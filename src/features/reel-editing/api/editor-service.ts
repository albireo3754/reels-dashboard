import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  writeFile,
  realpath,
  stat,
  rename,
  rm,
  readdir,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
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
interface RecordData {
  project: EditorProject;
  sourcePath: string;
  proxyPath: string;
  size: number;
  mtimeMs: number;
}
interface Options {
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
  reveal: (file: string) => void;
  changed?: (project: EditorProject) => void;
  renderStarted?: (job: RenderJob) => void;
}
const safeID = (id: unknown) => {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
    throw new Error("알 수 없는 편집 작업이에요.");
  return id;
};
const exists = async (file: string) => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};
export function parseRange(
  value: string | null,
  size: number,
): { start: number; end: number; partial: boolean } {
  if (!value) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw new Error("Invalid range");
  const start = match[1]
    ? Number(match[1])
    : Math.max(0, size - Number(match[2]));
  const end = match[1]
    ? match[2]
      ? Math.min(size - 1, Number(match[2]))
      : size - 1
    : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    throw new Error("Invalid range");
  return { start, end, partial: true };
}
export class EditorService implements EditorBridge {
  private records = new Map<string, RecordData>();
  private jobs = new Map<string, RenderJob>();
  private completions = new Map<string, Promise<void>>();
  private activeChild?: ChildProcess;
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
      const child = spawn(this.executable, args, {
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
      child.stdout.on("data", (chunk) => {
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
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-16000);
      });
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
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
      throw new Error("진행 중인 편집 작업이 끝난 뒤 다시 시도해주세요.");
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
    const file = path.join(dir, "project.json"),
      temp = file + "." + randomUUID() + ".tmp";
    await writeFile(temp, JSON.stringify(record, null, 2), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, file);
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
    const dir = path.join(this.dir(project.id), "work", randomUUID());
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const request = path.join(dir, "request.json");
    await writeFile(
      request,
      JSON.stringify({ sourcePath: record.sourcePath, ...valid.settings }),
      { mode: 0o600 },
    );
    return { dir, request, record, project: valid };
  }
  private async updateStage(
    project: EditorProject,
    stage: "editing" | "review",
  ) {
    const dashboard = await this.options.store.load();
    const old = dashboard.projects.find((p) => p.id === project.id);
    const item = {
      id: project.id,
      title: old?.title ?? project.source.name,
      date: old?.date ?? new Date().toLocaleDateString("en-CA"),
      stage,
      nextAction:
        stage === "review"
          ? "내보낸 영상과 표지를 확인해요."
          : "자막과 장소 안내를 편집해요.",
      publicURL: old?.publicURL ?? "",
      shared: old?.shared ?? false,
    };
    dashboard.projects = old
      ? dashboard.projects.map((p) => (p.id === item.id ? item : p))
      : [...dashboard.projects, item];
    dashboard.updatedAt = new Date().toISOString();
    await this.options.store.save(dashboard);
  }
  private async importFile(input: string): Promise<EditorProject> {
    const sourcePath = await realpath(input);
    const info = await stat(sourcePath);
    if (!info.isFile()) throw new Error("영상 파일을 선택해주세요.");
    const probe = await this.invoke(["probe", sourcePath]);
    if (!(probe.duration > 0 && probe.width > 0 && probe.height > 0))
      throw new Error("영상 정보를 읽지 못했어요.");
    const id = randomUUID(),
      dir = this.dir(id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const proxyPath = path.join(dir, "playback.mp4");
    try {
      await this.invoke(["proxy", sourcePath, proxyPath]);
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
        proxyPath,
        size: info.size,
        mtimeMs: info.mtimeMs,
      });
      await this.updateStage(project, "editing");
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
      return this.importFile(result.sourcePath);
    });
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
  async export(project: EditorProject): Promise<RenderJob | null> {
    return this.render(project, undefined, "both");
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
            path.parse(task.project.source.name).name + "_reel.mov",
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
          throw new Error("원본과 다른 MOV 또는 MP4 출력 경로를 선택해주세요.");
        const outputFiles =
          target === "both"
            ? [output, cover, manifest, cover.replace(/\.png$/, ".style.json")]
            : [output, manifest];
        for (const file of outputFiles)
          if (await exists(file))
            throw new Error(
              "같은 이름의 결과가 있어요. 새 파일 이름을 선택해주세요.",
            );
        const job: RenderJob = {
          id: randomUUID(),
          projectId: project.id,
          state: "running",
          phase: "영상 내보내기",
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
              await import("node:fs/promises").then((fs) =>
                fs.copyFile(from, to, 1),
              );
              published.push(to);
              const sourceManifest = from.replace(/\.[^.]+$/, ".style.json");
              if (await exists(sourceManifest)) {
                const target = to.replace(/\.[^.]+$/, ".style.json");
                await import("node:fs/promises").then((fs) =>
                  fs.copyFile(sourceManifest, target, 1),
                );
                published.push(target);
              }
            }
            job.outputPath = output;
            if (target !== "video") job.coverPath = cover;
            job.manifestPaths = published.filter((file) =>
              file.endsWith(".style.json"),
            );
            await this.updateStage(task.project, "review");
            job.progress = 100;
            job.phase = "내보내기 완료";
            job.state = "completed";
          } catch (e) {
            if (job.state !== "cancelled") {
              job.state = "failed";
              job.phase = "내보내기 실패";
              job.error = e instanceof Error ? e.message : String(e);
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
    if (!job) throw new Error("내보내기 작업을 찾지 못했어요.");
    if (this.activeJob === job && job.state !== "running")
      return { ...job, state: "running" as const, phase: "작업 정리 중" };
    return { ...job };
  }
  async cancel(id: string) {
    const job = this.jobs.get(id);
    if (!job || job.state !== "running") return;
    if (job.phase === "결과 저장")
      throw new Error("결과 파일 저장을 마무리하고 있어요.");
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
  async media(request: Request): Promise<Response> {
    const origin = request.headers.get("origin");
    const initiator = (request as Request & { initiatorOrigin?: string })
      .initiatorOrigin;
    if (
      (origin && !["null", "file://"].includes(origin)) ||
      (initiator && !["null", "file://"].includes(initiator))
    )
      return new Response("Forbidden", { status: 403 });
    const cors = {
      "access-control-allow-origin": origin === "file://" ? "file://" : "null",
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "access-control-allow-headers": "Range",
      "access-control-expose-headers":
        "Content-Range, Accept-Ranges, Content-Length",
      vary: "Origin",
    };
    try {
      const u = new URL(request.url);
      if (
        u.host !== "video" ||
        !["GET", "HEAD", "OPTIONS"].includes(request.method) ||
        u.search
      )
        throw new Error();
      const id = safeID(u.pathname.slice(1));
      const record = await this.record(id);
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers: cors });
      const file = await realpath(record.proxyPath);
      if (!file.startsWith((await realpath(this.dir(id))) + path.sep))
        throw new Error();
      const info = await stat(file);
      let range;
      try {
        range = parseRange(request.headers.get("range"), info.size);
      } catch {
        return new Response(null, {
          status: 416,
          headers: { ...cors, "content-range": `bytes */${info.size}` },
        });
      }
      const headers = {
        ...cors,
        "content-type": "video/mp4",
        "accept-ranges": "bytes",
        "content-length": String(range.end - range.start + 1),
        ...(range.partial
          ? {
              "content-range": `bytes ${range.start}-${range.end}/${info.size}`,
            }
          : {}),
      };
      if (request.method === "HEAD")
        return new Response(null, {
          status: range.partial ? 206 : 200,
          headers,
        });
      const stream = createReadStream(file, {
        start: range.start,
        end: range.end,
      });
      request.signal.addEventListener("abort", () => stream.destroy(), {
        once: true,
      });
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: range.partial ? 206 : 200,
        headers,
      });
    } catch {
      return new Response("Not found", { status: 404, headers: cors });
    }
  }
  async dispose() {
    this.closing = true;
    if (this.activeJob) await this.cancel(this.activeJob.id);
  }
}
