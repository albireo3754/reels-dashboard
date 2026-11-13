import { CoverPreferencesStore } from "../../../shared/lib/cover-preferences";
import { readJsonFile, writeFileAtomic, writeJsonAtomic } from "../../../shared/lib/fs";
import { errorMessage } from "../../../shared/lib/errors";
import { ExecutionLogs } from "../../../shared/lib/execution-logs";
import { loggedSpawn } from "../../../shared/lib/logged-process";
import { upsertExportedProject } from "../../../shared/production-project";
import { type ChildProcess } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  writeFile,
  realpath,
  rename,
  stat,
  rm,
  readdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  EditorBridge,
  EditorProject,
  EditorSource,
  RenderJob,
} from "../../../shared/editor";
import { defaultEditSettings } from "../../../shared/editor";
import { validateEditSettings } from "../../../shared/editor-model";
import type { LocalStore } from "../../../shared/lib/storage";
import type { LocalResource, Dashboard } from "../../../shared/contracts";
import { safeID, serveMedia } from "./media-handler";
import {
  emptyPhotosImportLedger,
  importPhotosBundle,
  type BundleAsset,
  type MaterializedMedia,
  type PhotosBundleInput,
  type PhotosImportLedger,
} from "../model/photos-bundle";
interface RecordData {
  project: EditorProject;
  sourcePath: string;
  /**
   * Legacy: imports before original-first playback always wrote a copy here. New
   * records omit it; a copy, when one is needed, lives at `playback.mp4` in the
   * project folder either way.
   */
  proxyPath?: string;
  size: number;
  mtimeMs: number;
}
interface Options {
  logs: ExecutionLogs;
  dashboardChanged?: (dashboard: Dashboard) => void;
  root: string;
  runtime: string;
  store: LocalStore;
  chooseVideo: () => Promise<string | null>;
  chooseOutput: (name: string) => Promise<string | null>;
  materialize: (v: {
    groupID: string;
    indexRunID: string;
    assetID: string;
  }) => Promise<{ sourcePath: string }>;
  /** Native `media.materialize`: photo or video copy (Live Photo motion included). */
  materializeMedia?: (v: {
    groupID: string;
    indexRunID: string;
    assetID: string;
  }) => Promise<MaterializedMedia>;
  /** Read-only `groups.show` for the current index run. */
  groupAssets?: (v: { groupID: string; indexRunID: string }) => Promise<BundleAsset[]>;
  reveal: (file: string) => void;
  changed?: (project: EditorProject) => void;
  renderStarted?: (job: RenderJob) => void;
  /** iCloud placeholder check; defaults to the macOS st_flags probe. */
  dataless?: (file: string) => Promise<boolean>;
}
const exists = async (file: string) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};
export class EditorService implements EditorBridge {
  private records = new Map<string, RecordData>();
  private jobs = new Map<string, RenderJob>();
  private completions = new Map<string, Promise<void>>();
  private activeChild?: ChildProcess;
  private children = new Set<ChildProcess>();
  private copies = new Map<string, Promise<string>>();
  private activeJob?: RenderJob;
  private pending = 0;
  private closing = false;
  constructor(private options: Options) {}
  get busy() {
    return this.pending > 0 || Boolean(this.activeJob);
  }
  private get executable() {
    return path.join(this.options.runtime, "reels-editor");
  }
  private dir(id: string) {
    return path.join(this.options.root, "editor", safeID(id));
  }
  async runtime() {
    return {
      available: await exists(this.executable),
      message: (await exists(this.executable))
        ? "편집 엔진 준비됨"
        : "편집 엔진이 없어요. 앱의 편집 런타임을 빌드해주세요.",
    };
  }
  private invoke(
    args: string[],
    onProgress?: (v: number) => void,
    tracked = false,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const child = loggedSpawn(this.options.logs, { source: "editor", label: ({probe: "편집 영상 정보 확인", render: "영상 인코딩", proxy: "편집 재생용 사본 준비", preview: "편집 미리보기", cover: "표지 생성"} as Record<string,string>)[args[0]] ?? `편집 엔진 · ${args[0]}`, projectId: this.activeJob?.projectId, jobId: this.activeJob?.id }, this.executable, args, {
        cwd: this.options.runtime,
        env: {
          ...process.env,
          PATH:
            path.join(this.options.runtime, "bin") +
            ":/usr/bin:/bin:/usr/sbin:/sbin",
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (tracked) this.activeChild = child;
      this.children.add(child);
      let stdout = "",
        stderr = "",
        tail = "";
      let result: unknown;
      let done = false;
      const timer = setTimeout(
        () => {
          try {
            if (child.pid) process.kill(-child.pid, "SIGTERM");
          } catch {}
        },
        tracked ? 3600000 : 600000,
      );
      child.stdout!.on("data", (chunk) => {
        const text = chunk.toString();
        stdout += text;
        if (stdout.length > 8 * 1024 * 1024) {
          child.kill();
          return;
        }
        tail += text;
        let index;
        while ((index = tail.indexOf("\n")) >= 0) {
          const line = tail.slice(0, index);
          tail = tail.slice(index + 1);
          try {
            const v = JSON.parse(line);
            if (v.type === "progress")
              onProgress?.(Math.max(0, Math.min(99, Number(v.percent) || 0)));
            else result = v;
          } catch {}
        }
      });
      child.stderr!.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-16000);
      });
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.children.delete(child);
        if (this.activeChild === child) this.activeChild = undefined;
        if (error) return reject(error);
        try {
          resolve(result ?? JSON.parse(stdout.trim()));
        } catch {
          reject(new Error("편집 엔진 결과를 읽지 못했어요."));
        }
      };
      child.on("error", (error) => finish(error));
      child.on("close", (code, signal) =>
        finish(
          code === 0
            ? undefined
            : new Error(
                stderr.trim() || `편집 작업이 종료됐어요 (${signal ?? code}).`,
              ),
        ),
      );
    });
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy || this.closing)
      throw Object.assign(
        new Error("진행 중인 편집 작업이 끝난 뒤 다시 시도해주세요."),
        { code: "EDITOR_BUSY" },
      );
    this.pending++;
    try {
      return await fn();
    } finally {
      this.pending--;
    }
  }
  private async saveRecord(record: RecordData) {
    const dir = this.dir(record.project.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(
      path.join(dir, "project.json"),
      JSON.stringify(record, null, 2),
      { mode: 0o600 },
    );
    this.records.set(record.project.id, record);
  }
  private async record(id: string) {
    safeID(id);
    let record = this.records.get(id);
    if (!record) {
      record = JSON.parse(
        await readFile(path.join(this.dir(id), "project.json"), "utf8"),
      ) as RecordData;
      if (record.project.id !== id)
        throw new Error("작업 기록이 일치하지 않아요.");
      this.records.set(id, record);
    }
    return record;
  }
  private async trusted(
    project: EditorProject,
    mode: "draft" | "video" | "cover" | "export",
  ) {
    if (!project || project.schemaVersion !== 1)
      throw new Error("편집 기록 형식이 올바르지 않아요.");
    const record = await this.record(project.id);
    if (project.updatedAt !== record.project.updatedAt)
      throw new Error(
        "STALE_PROJECT: 편집 설정이 변경됐어요. 프로젝트를 다시 조회해주세요.",
      );
    const info = await stat(record.sourcePath);
    if (
      info.size !== record.size ||
      Math.abs(info.mtimeMs - record.mtimeMs) > 1
    )
      throw new Error("촬영 원본 파일이 바뀌었어요. 영상을 다시 열어주세요.");
    const settings = validateEditSettings(
      project.settings,
      record.project.source.duration,
      mode,
    );
    return {
      record,
      project: {
        ...record.project,
        settings,
        updatedAt: new Date(
          Math.max(Date.now(), Date.parse(record.project.updatedAt) + 1),
        ).toISOString(),
      },
    };
  }
  private async stage(
    project: EditorProject,
    phase: "video" | "cover" | "export",
  ) {
    const { record, project: valid } = await this.trusted(project, phase);
    const coverSignature = phase !== "video" && valid.settings.cover.template !== "rosy-follow"
      ? (await new CoverPreferencesStore(this.options.root).get()).signature
      : undefined;
    const dir = path.join(this.dir(project.id), "work", randomUUID());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const request = path.join(dir, "request.json");
    await writeFile(
      request,
      JSON.stringify({ sourcePath: record.sourcePath, ...valid.settings, coverSignature }),
      { mode: 0o600 },
    );
    return { dir, request, record, project: valid };
  }
  private async updateStage(
    project: EditorProject,
    stage: "editing" | "review",
    outputs: LocalResource[] = [],
  ) {
    const record = await this.record(project.id);
    outputs = await Promise.all(
      outputs.map(async (resource) => ({
        ...resource,
        path: await realpath(resource.path),
      })),
    );
    const dashboard = await this.options.store.update((dashboard) =>
      upsertExportedProject(
        dashboard,
        { kind: "video", id: project.id },
        {
          title: project.source.name,
          stage,
          nextAction:
            stage === "review"
              ? "내보낸 영상과 표지를 확인해요."
              : "자막과 장소 안내를 편집해요.",
          resources: [
            {
              role: "footage",
              path: record.sourcePath,
              label: project.source.name,
            },
            ...outputs,
          ],
          exported: outputs,
        },
        new Date(),
        randomUUID,
      ),
    );
    this.options.dashboardChanged?.(dashboard);
  }
  /** `card: false` creates the edit project without a dashboard card of its own. */
  private async importFile(
    input: string,
    { card = true }: { card?: boolean } = {},
  ): Promise<EditorProject> {
    const sourcePath = await realpath(input);
    const info = await stat(sourcePath);
    if (!info.isFile()) throw new Error("영상 파일을 선택해주세요.");
    const probe = await this.invoke(["probe", sourcePath]);
    if (!(probe.duration > 0 && probe.width > 0 && probe.height > 0))
      throw new Error("영상 정보를 읽지 못했어요.");
    const id = randomUUID(),
      dir = this.dir(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      // The original is played directly; a playback copy is made only if the
      // renderer later reports that it cannot play it (see playbackCopy).
      const source: EditorSource = {
        id,
        name: path.basename(sourcePath),
        duration: probe.duration,
        width: probe.width,
        height: probe.height,
        hdr: Boolean(probe.hdr),
        hasAudio: Boolean(probe.hasAudio),
        videoURL: `reels-media://video/${id}`,
      };
      const project: EditorProject = {
        schemaVersion: 1,
        id,
        source,
        settings: defaultEditSettings(source.duration),
        updatedAt: new Date().toISOString(),
      };
      await this.saveRecord({
        project,
        sourcePath,
        size: info.size,
        mtimeMs: info.mtimeMs,
      });
      if (card) await this.updateStage(project, "editing");
      return project;
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
  }
  async chooseVideo() {
    return this.exclusive(async () => {
      const file = await this.options.chooseVideo();
      return file ? this.importFile(file) : null;
    });
  }
  async fromPhotos(selection: {
    groupID: string;
    indexRunID: string;
    assetID: string;
  }) {
    return this.exclusive(async () => {
      if (
        !selection ||
        [selection.groupID, selection.indexRunID, selection.assetID].some(
          (v) => typeof v !== "string" || !v || v.length > 500,
        )
      )
        throw new Error("선택한 촬영본을 확인해주세요.");
      const result = await this.options.materialize(selection);
      const project = await this.importFile(result.sourcePath);
      // A later bundle import of the same asset reuses this copy instead of
      // copying again. Best effort: the import itself already succeeded.
      await this.withPhotosLedger(async (ledger, save) => {
        ledger.assets[selection.assetID] = {
          assetId: selection.assetID,
          mediaKind: "video",
          sourcePath: (await this.record(project.id)).sourcePath,
          editId: project.id,
          name: project.source.name,
          importedAt: new Date().toISOString(),
        };
        await save(ledger);
      }).catch(() => {});
      return project;
    });
  }
  private photosQueue: Promise<unknown> = Promise.resolve();
  private get ledgerFile() {
    return path.join(this.options.root, "photos-imports.json");
  }
  /** Serializes ledger readers and writers inside this process. */
  private withPhotosLedger<T>(
    fn: (
      ledger: PhotosImportLedger,
      save: (ledger: PhotosImportLedger) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    const run = this.photosQueue.then(async () => {
      const ledger = await readJsonFile(
        this.ledgerFile,
        (value) => {
          const v = value as PhotosImportLedger;
          if (v?.schemaVersion !== 1 || typeof v.assets !== "object" || !v.assets)
            throw new Error("Photos 가져오기 기록을 읽지 못했어요.");
          return v;
        },
        emptyPhotosImportLedger,
      );
      return fn(ledger, (next) =>
        writeJsonAtomic(this.ledgerFile, next, { mode: 0o600 }),
      );
    });
    this.photosQueue = run.catch(() => {});
    return run;
  }
  /**
   * Copy every photo and video of one Photos group (or a subset) into app
   * storage and attach them to an existing content card. Photos originals are
   * only read; already-imported assets are reused, not copied again.
   */
  async importPhotosBundle(input: PhotosBundleInput) {
    const { materializeMedia, groupAssets } = this.options;
    if (!materializeMedia || !groupAssets)
      throw new Error("UNSUPPORTED: Photos 묶음 가져오기를 쓸 수 없는 환경이에요.");
    return this.exclusive(() =>
      this.withPhotosLedger(async (ledger, save) =>
        importPhotosBundle(input, {
          groupAssets: () =>
            groupAssets({ groupID: input.groupId, indexRunID: input.indexRunId }),
          projectExists: async (id) =>
            (await this.options.store.load()).projects.some((p) => p.id === id),
          loadLedger: async () => ledger,
          saveLedger: save,
          isFile: async (file) => {
            try {
              return (await stat(file)).isFile();
            } catch {
              return false;
            }
          },
          editExists: async (id) => {
            try {
              await this.record(id);
              return true;
            } catch {
              return false;
            }
          },
          materialize: async (assetID) => {
            const copied = await materializeMedia({
              groupID: input.groupId,
              indexRunID: input.indexRunId,
              assetID,
            });
            // Same path form as the edit record, so later edits do not add a duplicate resource.
            return {
              ...copied,
              sourcePath: await realpath(copied.sourcePath),
              ...(copied.pairedVideoPath
                ? { pairedVideoPath: await realpath(copied.pairedVideoPath) }
                : {}),
            };
          },
          createEdit: (sourcePath) => this.importFile(sourcePath, { card: false }),
          attach: async (mutate) => {
            let owners = new Map<string, string>();
            const dashboard = await this.options.store.update((current) => {
              const next = mutate(current);
              owners = next.owners;
              return next.dashboard;
            });
            this.options.dashboardChanged?.(dashboard);
            return { dashboard, owners };
          },
          now: () => new Date(),
        }),
      ),
    );
  }
  async list() {
    const root = path.join(this.options.root, "editor");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const records = [];
    for (const id of await readdir(root)) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      try {
        const r = await this.record(id);
        records.push({
          id,
          name: r.project.source.name,
          updatedAt: r.project.updatedAt,
        });
      } catch {}
    }
    return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async load(id: string) {
    return structuredClone((await this.record(id)).project);
  }
  async save(project: EditorProject) {
    return this.exclusive(async () => {
      const { record, project: valid } = await this.trusted(project, "draft");
      const changed =
        JSON.stringify(record.project.settings) !==
        JSON.stringify(valid.settings);
      await this.saveRecord({ ...record, project: valid });
      if (changed) await this.updateStage(valid, "editing");
      this.options.changed?.(structuredClone(valid));
      return structuredClone(valid);
    });
  }
  async importVideo(input: string, settings?: EditorProject["settings"]) {
    return this.exclusive(async () => {
      if (typeof input !== "string" || !path.isAbsolute(input))
        throw new Error("절대 영상 경로를 지정해주세요.");
      // Validate reused settings against the new duration before creating a project.
      if (settings) {
        const probe = await this.invoke(["probe", await realpath(input)]);
        validateEditSettings(settings, probe.duration);
      }
      const created = await this.importFile(input);
      if (!settings) return created;
      const record = await this.record(created.id);
      const project = {
        ...created,
        settings: validateEditSettings(settings, created.source.duration),
      };
      await this.saveRecord({ ...record, project });
      return structuredClone(project);
    });
  }
  activeJobs() {
    return [...this.jobs.values()].map((job) =>
      this.activeJob === job && job.state !== "running"
        ? { ...job, state: "running" as const, phase: "작업 정리 중" }
        : { ...job },
    );
  }
  async preview(project: EditorProject, time: number, kind: "video" | "cover") {
    return (await this.previewArtifact(project, time, kind)).image;
  }
  async previewArtifact(
    project: EditorProject,
    time: number,
    kind: "video" | "cover",
  ) {
    return this.exclusive(async () => {
      if (!["video", "cover"].includes(kind))
        throw new Error("미리보기 종류를 확인해주세요.");
      const task = await this.stage(project, kind);
      try {
        if (
          !Number.isFinite(time) ||
          time < 0 ||
          time >= task.project.source.duration
        )
          throw new Error("미리보기 시간을 확인해주세요.");
        const out = path.join(task.dir, "preview.png");
        await this.invoke(
          kind === "cover"
            ? ["cover", task.request, out]
            : ["preview", task.request, out, "--time", String(time)],
        );
        const bytes = await readFile(out);
        if (bytes.length > 40 * 1024 * 1024)
          throw new Error("미리보기가 너무 커요.");
        const manifest = JSON.parse(
          await readFile(out.replace(/\.png$/, ".style.json"), "utf8"),
        );
        return {
          image: `data:image/png;base64,${bytes.toString("base64")}`,
          manifest,
        };
      } finally {
        await rm(task.dir, { recursive: true, force: true });
      }
    });
  }
  async export(
    project: EditorProject,
    target: "both" | "cover" = "both",
  ): Promise<RenderJob | null> {
    if (!["both", "cover"].includes(target))
      throw new Error("지원하지 않는 출력 형식이에요.");
    return this.render(project, undefined, target);
  }
  async render(
    project: EditorProject,
    destination?: string,
    target: "video" | "cover" | "both" = "both",
  ): Promise<RenderJob | null> {
    return this.exclusive(async () => {
      const task = await this.stage(
        project,
        target === "both" ? "export" : target,
      );
      try {
        const selected =
          destination ??
          (await this.options.chooseOutput(
            path.parse(task.project.source.name).name +
              (target === "cover" ? "_card.png" : "_reel.mov"),
          ));
        if (!selected) {
          await rm(task.dir, { recursive: true, force: true });
          return null;
        }
        if (!path.isAbsolute(selected))
          throw new Error("절대 출력 경로를 지정해주세요.");
        const output = path.resolve(selected),
          cover =
            target === "cover"
              ? output
              : path.join(
                  path.dirname(output),
                  path.parse(output).name + "_cover.png",
                ),
          manifest = output.replace(/\.[^.]+$/, ".style.json");
        if (
          !(target === "cover" ? [".png"] : [".mov", ".mp4"]).includes(
            path.extname(output).toLowerCase(),
          ) ||
          [output, cover, manifest].includes(task.record.sourcePath)
        )
          throw new Error(
            target === "cover"
              ? "원본과 다른 PNG 출력 경로를 선택해주세요."
              : "원본과 다른 MOV 또는 MP4 출력 경로를 선택해주세요.",
          );
        const outputFiles =
          target === "both"
            ? [output, cover, manifest, cover.replace(/\.png$/, ".style.json")]
            : [output, manifest];
        for (const file of outputFiles)
          if (await exists(file))
            throw Object.assign(
              new Error(
                "같은 이름의 결과가 있어요. 새 파일 이름을 선택해주세요.",
              ),
              { code: "OUTPUT_EXISTS" },
            );
        const job: RenderJob = {
          id: randomUUID(),
          projectId: project.id,
          state: "running",
          phase: target === "cover" ? "카드 이미지 내보내기" : "영상 내보내기",
          progress: 0,
        };
        await this.saveRecord({ ...task.record, project: task.project });
        this.jobs.set(job.id, job);
        this.activeJob = job;
        const completion = (async () => {
          const tempVideo = path.join(task.dir, "video" + path.extname(output));
          const tempCover = path.join(task.dir, "cover.png");
          const published: string[] = [];
          try {
            if (target !== "cover")
              await this.invoke(
                ["render", task.request, tempVideo],
                (percent) => (job.progress = percent * 0.9),
                true,
              );
            if ((job as RenderJob).state === "cancelled") return;
            job.phase = "표지 만들기";
            job.progress = 92;
            if (target !== "video")
              await this.invoke(
                ["cover", task.request, tempCover],
                undefined,
                true,
              );
            if ((job as RenderJob).state === "cancelled") return;
            job.phase = "결과 저장";
            const pairs: [string, string][] = [];
            if (target !== "cover") pairs.push([tempVideo, output]);
            if (target !== "video") pairs.push([tempCover, cover]);
            for (const [from, to] of pairs) {
              await copyFile(from, to, 1);
              published.push(to);
              const sourceManifest = from.replace(/\.[^.]+$/, ".style.json");
              if (await exists(sourceManifest)) {
                const target = to.replace(/\.[^.]+$/, ".style.json");
                await copyFile(sourceManifest, target, 1);
                published.push(target);
              }
            }
            job.outputPath = output;
            if (target !== "video") job.coverPath = cover;
            job.manifestPaths = published.filter((file) =>
              file.endsWith(".style.json"),
            );
            await this.updateStage(task.project, "review", [
              ...(target !== "cover"
                ? [
                    {
                      role: "draft" as const,
                      path: output,
                      label: path.basename(output),
                    },
                  ]
                : []),
              ...(target !== "video"
                ? [
                    {
                      role: "cover" as const,
                      path: cover,
                      label: path.basename(cover),
                    },
                  ]
                : []),
            ]);
            job.progress = 100;
            job.phase = "내보내기 완료";
            job.state = "completed";
          } catch (e) {
            if (job.state !== "cancelled") {
              job.state = "failed";
              job.phase = "내보내기 실패";
              job.error = errorMessage(e);
            }
            for (const file of published) await rm(file, { force: true });
          } finally {
            await rm(task.dir, { recursive: true, force: true });
            if (this.activeJob === job) this.activeJob = undefined;
          }
        })();
        this.options.changed?.(structuredClone(task.project));
        this.options.renderStarted?.({ ...job });
        this.completions.set(job.id, completion);
        return { ...job };
      } catch (error) {
        await rm(task.dir, { recursive: true, force: true });
        throw error;
      }
    });
  }
  async job(id: string) {
    const job = this.jobs.get(id);
    if (!job)
      throw Object.assign(new Error("내보내기 작업을 찾지 못했어요."), {
        code: "RENDER_JOB_NOT_FOUND",
      });
    if (this.activeJob === job && job.state !== "running")
      return { ...job, state: "running" as const, phase: "작업 정리 중" };
    return { ...job };
  }
  async cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job || job.state !== "running") return;
    if (job.phase === "결과 저장")
      throw Object.assign(new Error("결과 파일 저장을 마무리하고 있어요."), {
        code: "RENDER_SAVE_BUSY",
      });
    job.state = "cancelled";
    job.phase = "내보내기 취소됨";
    const child = this.activeChild;
    if (this.activeJob === job && child?.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      setTimeout(() => {
        if (this.activeJob === job)
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {}
      }, 2000).unref();
    }
    await this.completions.get(id);
  }
  async reveal(id: string) {
    const job = await this.job(id);
    if (job.state !== "completed" || !job.outputPath)
      throw new Error("완료된 결과가 없어요.");
    this.options.reveal(job.outputPath);
  }
  private copyPath(id: string) {
    return path.join(this.dir(id), "playback.mp4");
  }
  async playbackCopy(id: string) {
    safeID(id);
    if (this.closing) throw new Error("앱이 종료 중이에요.");
    const record = await this.record(id);
    const url = `reels-media://video/${id}/copy`;
    const output = this.copyPath(id);
    if ((await stat(output).catch(() => null))?.size) return url;
    let work = this.copies.get(id);
    if (!work) {
      work = (async () => {
        const temporary = output + `.${randomUUID()}.mp4`;
        try {
          await this.invoke(["proxy", record.sourcePath, temporary]);
          await rename(temporary, output);
          return url;
        } catch {
          // The engine's stderr stays in the execution log.
          throw new Error(
            "재생용 사본을 만들지 못했어요. 실행 로그에서 원인을 확인해주세요.",
          );
        } finally {
          await rm(temporary, { force: true });
        }
      })().finally(() => this.copies.delete(id));
      this.copies.set(id, work);
    }
    return work;
  }
  async media(request: Request): Promise<Response> {
    return serveMedia(request, {
      record: (id) => this.record(id),
      copyPath: (id) => this.copyPath(id),
      dir: (id) => this.dir(id),
      options: this.options,
    });
  }
  async dispose() {
    this.closing = true;
    if (this.activeJob) await this.cancel(this.activeJob.id);
    // Playback copies and other short engine calls do not outlive the app.
    for (const child of this.children)
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
  }
}
