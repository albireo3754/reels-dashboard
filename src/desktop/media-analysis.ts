import { sha256Hex } from "../shared/lib/hash";
import { errorMessage } from "../shared/lib/errors";
import { readJsonFile } from "../shared/lib/fs";
import { ExecutionLogs } from "../shared/lib/execution-logs";
import { loggedExecFile } from "../shared/lib/logged-process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { sourceVersion as versionOf } from "../shared/lib/hash";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ContentLibrary } from "../features/content-library";
import { LocalStore } from "../shared/lib/storage";
import {
  analysisFields,
  analysisStart,
  analysisQuery,
  analysisCorrection,
  faceRegion,
  type AnalysisDocument,
  type AnalysisRun,
  type AnalysisSample,
  type AnalysisView,
} from "../shared/media-analysis";
import {
  CodexImageAnalyzer,
  type ImageAnalyzer,
} from "./analysis-provider";
const photos = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic"]);
const videos = new Set([".mov", ".mp4", ".m4v"]);
export class MediaAnalysis {
  private active = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private adapters: Map<string, ImageAnalyzer>;
  readonly root: string;
  constructor(
    private store: LocalStore,
    private library: ContentLibrary,
    private runtime: string,
    private logs: ExecutionLogs,
    adapters?: ImageAnalyzer[],
    contextMcpPath?: string,
  ) {
    this.root = path.join(store.root, "media-analysis");
    this.adapters = new Map(
      (adapters ?? [new CodexImageAnalyzer(this.root, undefined, contextMcpPath)]).map((a) => [a.id, a]),
    );
  }
  private async owner(): Promise<number | undefined> {
    try {
      const pid = Number(
        await readFile(path.join(this.root, "active.pid"), "utf8"),
      );
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error("ANALYSIS_BUSY: 분석 잠금을 확인해주세요.");
      try {
        process.kill(pid, 0);
        return pid;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ESRCH") return undefined;
        throw e;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }
  private async acquire() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      await writeFile(path.join(this.root, "active.pid"), String(process.pid), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST")
        throw new Error(
          "ANALYSIS_BUSY: 다른 분석이 실행 중이거나 중단된 분석 잠금이 남아 있어요.",
        );
      throw e;
    }
  }
  private async release() {
    await unlink(path.join(this.root, "active.pid")).catch(() => {});
  }
  providers() {
    return Promise.resolve(
      [...this.adapters.values()].map(({ id, label }) => ({ id, label })),
    );
  }
  private file(id: string) {
    return path.join(this.root, sha256Hex(id) + ".json");
  }
  private async load(projectId: string): Promise<AnalysisDocument> {
    await this.library.get(projectId);
    return readJsonFile<AnalysisDocument>(
      this.file(projectId),
      (value) => {
        const doc = value as AnalysisDocument;
        if (doc.schemaVersion !== 1 || doc.projectId !== projectId)
          throw new Error("분석 저장 형식 오류");
        return doc;
      },
      () => ({
        schemaVersion: 1,
        projectId,
        revision: 0,
        runs: [],
        results: [],
        corrections: {},
      }),
    );
  }
  private update(id: string, change: (d: AnalysisDocument) => void) {
    const operation = this.queue.then(async () => {
      const doc = await this.load(id);
      change(doc);
      doc.revision++;
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await this.store.atomic(this.file(id), doc);
      return doc;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async search(value: unknown): Promise<AnalysisView> {
    const { projectId, query } = analysisQuery.parse(value);
    const doc = await this.load(projectId);
    const owner = await this.owner();
    // A previous app process may have ended during a run. Never claim it is still active.
    doc.runs = doc.runs.map((r) =>
      r.status === "running" && !this.active.has(projectId) && !owner
        ? { ...r, status: "interrupted" }
        : r,
    );
    const latest = new Map<string, (typeof doc.results)[number]>();
    for (const r of doc.results) latest.set(r.sample.id, r);
    const q = query.normalize("NFC").toLowerCase();
    const matches = [...latest.values()]
      .map((r) => ({
        ...r,
        effective: { ...r.fields, ...doc.corrections[r.sample.id] },
      }))
      .filter((r) =>
        JSON.stringify([r.sample.sourcePath, r.effective.description, r.effective.tags, r.effective.ocr])
          .normalize("NFC")
          .toLowerCase()
          .includes(q),
      );
    return { ...doc, matches };
  }
  async correct(value: unknown) {
    const input = analysisCorrection.parse(value);
    const owner = await this.owner();
    if (owner && owner !== process.pid)
      throw new Error("ANALYSIS_BUSY: 외부 분석이 완료된 후 수정해주세요.");
    await this.update(input.projectId, (d) => {
      if (d.revision !== input.expectedRevision)
        throw new Error("STALE_ANALYSIS: 다시 조회해주세요.");
      if (!d.results.some((r) => r.sample.id === input.sampleId))
        throw new Error("분석 결과 없음");
      d.corrections[input.sampleId] = {
        ...d.corrections[input.sampleId],
        ...input.fields,
      };
    });
    return this.search({ projectId: input.projectId });
  }
  private async mosaicSource(projectId: string, sampleId: string) {
    const view = await this.search({ projectId });
    const result = view.matches.find((r) => r.sample.id === sampleId);
    if (!result || !result.fields.faceRegions) throw new Error("얼굴 분석 결과가 없어요.");
    const sample = result.sample;
    const { info } = await this.library.resolveMedia(projectId, sample.sourcePath);
    if (versionOf(info) !== sample.sourceVersion) throw new Error("분석 후 원본이 변경됐어요. 다시 분석해주세요.");
    return sample;
  }
  async mosaicSample(projectId: string, sampleId: string) {
    const sample = await this.mosaicSource(projectId, sampleId);
    const bytes = await readFile(sample.imagePath);
    return `data:image/jpeg;base64,${bytes.toString("base64")}`;
  }
  async mosaicExport(value: unknown, output: string) {
    const input = z.strictObject({ projectId: z.string().min(1).max(160), sampleId: z.string().min(1).max(100), regions: z.array(faceRegion).max(100), blockSize: z.number().int().min(4).max(100) }).parse(value);
    const sample = await this.mosaicSource(input.projectId, input.sampleId);
    const source = sample.kind === "photo" && !/\.heic$/i.test(sample.sourcePath) ? sample.sourcePath : sample.imagePath;
    const plan = { sourcePath: source, originalPath: sample.sourcePath, sourceVersion: sample.sourceVersion, sampleId: sample.id, kind: sample.kind, frameTime: sample.time, blockSize: input.blockSize, regions: input.regions };
    const sidecar = output + ".mosaic.json";
    await writeFile(sidecar, JSON.stringify(plan, null, 2), { flag: "wx", mode: 0o600 });
    try {
      await loggedExecFile(this.logs, {source: "analysis", label: "분석 사진 모자이크", projectId: input.projectId}, path.join(this.runtime, "reels-editor"), ["face-mosaic", sidecar, output], { timeout: 90000, maxBuffer: 1024 * 1024 });
    } catch (error) {
      await unlink(sidecar).catch(() => {});
      throw error;
    }
    return output;
  }
  async start(value: unknown): Promise<AnalysisRun> {
    const input = analysisStart.parse(value);
    const adapter = this.adapters.get(input.provider);
    if (!adapter) throw new Error("지원하지 않는 분석기예요.");
    if (this.active.size)
      throw new Error("ANALYSIS_BUSY: 진행 중인 분석이 끝난 뒤 시작해주세요.");
    this.active.add(input.projectId);
    let acquired = false;
    try {
      await this.acquire();
      acquired = true;
      const { project } = await this.library.get(input.projectId);
      const folder = await this.library.resolveMedia(
        input.projectId,
        input.folder,
      );
      if (!folder.info.isDirectory())
        throw new Error("분석할 폴더를 선택해주세요.");
      const entries = (await readdir(folder.path, { withFileTypes: true }))
        .filter(
          (e) =>
            e.isFile() &&
            !e.name.startsWith(".") &&
            (photos.has(path.extname(e.name).toLowerCase()) ||
              videos.has(path.extname(e.name).toLowerCase())),
        )
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!entries.length)
        throw new Error(
          "선택한 폴더에 사진·영상이 없어요. 하위 폴더는 자동 분석하지 않아요.",
        );
      if (entries.length > input.maxFiles)
        throw new Error(
          `파일 ${entries.length}개가 한도 ${input.maxFiles}개를 넘어요. 범위를 줄이거나 한도를 늘려주세요.`,
        );
      const previous = await this.load(input.projectId);
      const context = input.context ?? previous.context;
      if (input.context && input.expectedRevision === undefined)
        throw new Error(
          "CONTEXT_REVISION_REQUIRED: 맥락 수정 전 분석 상태를 조회해주세요.",
        );
      const run: AnalysisRun = {
        requestedModel: input.model ?? process.env.REELS_ANALYSIS_MODEL ?? "gpt-6.1-sol",
        requestedReasoning: input.reasoning ?? process.env.REELS_ANALYSIS_REASONING ?? "high",
        force: input.force, skippedSamples: 0, calls: [],
        context,
        promptVersion: "context-v4-selection-mcp",
        id: randomUUID(),
        provider: adapter.id,
        request: input.request,
        folder: folder.path,
        status: "running",
        startedAt: new Date().toISOString(),
        totalFiles: entries.length,
        processedFiles: 0,
        analyzedSamples: 0,
        errors: [],
      };
      await this.update(input.projectId, (d) => {
        if (input.context && d.revision !== input.expectedRevision)
          throw new Error(
            "STALE_ANALYSIS: 분석 맥락이 변경됐어요. 다시 조회해주세요.",
          );
        if (input.context) d.context = structuredClone(input.context);
        for (const r of d.runs)
          if (r.status === "running") r.status = "interrupted";
        d.runs.push(run);
      });
      void this.execute(
        input.projectId,
        JSON.stringify({
          projectTitle: project.title,
          projectDate: project.date,
          dateBasis: project.dateBasis ?? "unknown",
          facts: context ?? null,
        }),
        entries.map((e) => path.join(folder.path, e.name)),
        run,
        adapter,
      )
        .catch(() => {})
        .finally(async () => {
          await this.release();
          this.active.delete(input.projectId);
        });
      return structuredClone(run);
    } catch (e) {
      if (acquired) await this.release();
      this.active.delete(input.projectId);
      throw e;
    }
  }
  private async prepare(
    projectId: string,
    file: string,
    runId: string,
  ): Promise<AnalysisSample[]> {
    const { info } = await this.library.resolveMedia(projectId, file);
    const sourceVersion = versionOf(info),
      kind = videos.has(path.extname(file).toLowerCase())
        ? "video-frame"
        : "photo";
    const contentDigest = await analysisContentDigest(file);
    let times: (number | null)[] = [null];
    if (kind === "video-frame") {
      const { stdout } = await loggedExecFile(
        this.logs, { source: "analysis", label: "분석 영상 정보 확인", projectId, jobId: runId },
        path.join(this.runtime, "bin/ffprobe"),
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "json",
          file,
        ],
        { timeout: 60000, maxBuffer: 1024 * 1024 },
      );
      const duration = Number(JSON.parse(stdout).format.duration);
      if (!Number.isFinite(duration) || duration <= 0)
        throw new Error("영상 길이를 확인하지 못했어요.");
      times = [
        ...new Set(
          [
            Math.min(0.2, duration / 10),
            duration / 2,
            Math.max(0, duration - 0.2),
          ].map((t) => Math.round(t * 1000) / 1000),
        ),
      ];
    }
    const dir = path.join(this.root, "frames", runId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const samples: AnalysisSample[] = [];
    for (const time of times) {
      const id = sha256Hex(`${contentDigest}:${kind}:${time}`),
        imagePath = path.join(dir, id + ".jpg");
      const args = [
        "-nostdin",
        "-v",
        "error",
        ...(time === null ? [] : ["-ss", String(time)]),
        "-i",
        file,
        "-frames:v",
        "1",
        "-vf",
        "scale=960:960:force_original_aspect_ratio=decrease",
        "-q:v",
        "3",
        "-y",
        imagePath,
      ];
      await loggedExecFile(this.logs, { source: "analysis", label: `분석용 프레임 추출${time === null ? "" : ` · ${time}초`}`, projectId, jobId: runId }, path.join(this.runtime, "bin/ffmpeg"), args, {
        timeout: 90000,
        maxBuffer: 1024 * 1024,
      });
      samples.push({
        id,
        sourcePath: file,
        sourceVersion,
        kind,
        time,
        imagePath,
      });
    }
    return samples;
  }
  private async execute(
    projectId: string,
    context: string,
    files: string[],
    run: AnalysisRun,
    adapter: ImageAnalyzer,
  ) {
    const saveRun = () =>
      this.update(projectId, (d) => {
        const i = d.runs.findIndex((r) => r.id === run.id);
        d.runs[i] = structuredClone(run);
      });
    try {
      // Three source files per model invocation; each frame remains independently attributable.
      for (let offset = 0; offset < files.length; offset += 3) {
        let samples: AnalysisSample[] = [];
        for (const file of files.slice(offset, offset + 3)) {
          try {
            samples.push(...(await this.prepare(projectId, file, run.id)));
          } catch {
            run.errors.push({
              sourcePath: file,
              message: "원본 읽기 또는 프레임 추출 실패",
            });
          }
        }
        run.settingsDigest ??= sha256Hex(JSON.stringify([adapter.id, run.requestedModel, run.requestedReasoning, run.promptVersion, context, run.request]));
        const previous = await this.load(projectId);
        const seen = new Set(previous.results.filter(r => r.reuseKey).map(r => r.reuseKey));
        const unique = new Set<string>();
        const reused: AnalysisSample[] = [];
        samples = samples.filter(sample => {
          const key = sha256Hex(`${sample.id}:${run.settingsDigest}`);
          if (unique.has(key)) { run.skippedSamples = (run.skippedSamples ?? 0) + 1; return false; }
          unique.add(key);
          if (!run.force && seen.has(key)) { run.skippedSamples = (run.skippedSamples ?? 0) + 1; reused.push(sample); return false; }
          return true;
        });
        if (reused.length) await this.update(projectId, d => {
          for (const sample of reused) {
            const cached = [...d.results].reverse().find(r => r.reuseKey === sha256Hex(`${sample.id}:${run.settingsDigest}`));
            if (cached && (cached.sample.sourcePath !== sample.sourcePath || cached.sample.sourceVersion !== sample.sourceVersion)) d.results.push({ ...cached, sample });
          }
        });
        let providerFailed = false;
        if (samples.length) {
          try {
            const fields = await adapter.analyze(samples, context, run.request, {
              model: run.requestedModel!, reasoning: run.requestedReasoning!,
              recordUsage: usage => { (run.calls ??= []).push(usage); },
            });
            if (fields.length !== samples.length)
              throw new Error("분석 응답 수 불일치");
            // Refuse results if any source changed while the analyzer was running.
            for (const sample of samples) {
              const current = await stat(sample.sourcePath);
              if (
                versionOf(current) !==
                sample.sourceVersion
              )
                throw new Error("분석 중 원본 변경");
            }
            await this.update(projectId, (d) => {
              d.results.push(
                ...samples.map((sample, i) => ({
                  sample,
                  reuseKey: sha256Hex(`${sample.id}:${run.settingsDigest}`),
                  provider: adapter.id,
                  runId: run.id,
                  analyzedAt: new Date().toISOString(),
                  fields: analysisFields.parse(fields[i]),
                })),
              );
            });
            run.analyzedSamples += samples.length;
          } catch (e) {
            providerFailed = true;
            run.errors.push(
              ...[...new Set(samples.map((s) => s.sourcePath))].map(
                (sourcePath) => ({
                  sourcePath,
                  message: errorMessage(e, "분석 실패"),
                }),
              ),
            );
          }
        }
        run.processedFiles = Math.min(files.length, offset + 3);
        await saveRun();
        if (providerFailed) break; // Do not repeat login/quota/provider failures across the folder.
      }
      run.status = run.errors.length
        ? run.analyzedSamples
          ? "partial"
          : "failed"
        : "completed";
    } catch {
      run.status = "failed";
      run.errors.push({ sourcePath: "", message: "분석 결과 저장 실패" });
    }
    if (run.calls?.length) {
      const total = (key: "inputTokens" | "cachedInputTokens" | "outputTokens" | "reasoningTokens") => run.calls!.every(c => c[key] !== null) ? run.calls!.reduce((n,c) => n + c[key]!, 0) : null;
      run.usage = { inputTokens: total("inputTokens"), cachedInputTokens: total("cachedInputTokens"), outputTokens: total("outputTokens"), reasoningTokens: total("reasoningTokens"), actualModel: null, actualReasoning: null, durationMs: run.calls.reduce((n,c) => n+c.durationMs,0), imageCount: run.calls.reduce((n,c) => n+c.imageCount,0) };
    }
    run.finishedAt = new Date().toISOString();
    await saveRun();
  }
}

export async function analysisContentDigest(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
