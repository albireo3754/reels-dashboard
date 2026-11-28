import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  SLOWMO_FLOW_LONG_SIDE,
  slowmoStartInput,
  type SlowmoBridge,
  type SlowmoJob,
} from "../../../shared/slowmo";
import type { ExecutionLogs } from "../../../shared/lib/execution-logs";
import { loggedSpawn } from "../../../shared/lib/logged-process";
import { plan, type Plan, type Probe } from "../model/plan";

type Command = "probe" | "render";
export interface RunHandle {
  done: Promise<Record<string, unknown>>;
  cancel(): void;
}
/** Runs the native tool; `argument` is the source (probe) or a request JSON path (render). */
export type Runner = (command: Command, argument: string, onProgress: (percent: number) => void) => RunHandle;

const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".m4v"]);
const KEEP_FINISHED_JOBS = 20;

function isActive(job: SlowmoJob): boolean {
  return job.state === "queued" || job.state === "running";
}

/**
 * Slow-motion copies made by `reels-slowmo` (Vision optical flow + Metal on the GPU).
 * One job at a time; jobs live in memory and survive MCP disconnects but not app restarts.
 * The result is written to a hidden partial file and renamed only after success.
 */
export class SlowmoService implements SlowmoBridge {
  private jobs = new Map<string, SlowmoJob>();
  private handles = new Map<string, RunHandle>();
  private cancelled = new Set<string>();
  private waiters = new Map<string, Array<() => void>>();
  private queue: Promise<unknown> = Promise.resolve();
  private run: Runner;

  constructor(executable: string, logs?: ExecutionLogs, runner?: Runner) {
    this.run = runner ?? nativeRunner(executable, logs);
  }

  get busy() {
    return [...this.jobs.values()].some(isActive);
  }

  get(jobId: string): SlowmoJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error("SLOWMO_JOB: 작업을 찾지 못했어요. 앱을 다시 시작했다면 결과 파일이 있는지 확인해주세요.");
    return structuredClone(job);
  }

  list() {
    return [...this.jobs.values()].map((job) => structuredClone(job));
  }

  async cancel(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) return this.get(jobId);
    if (job.state === "queued") this.finish(job, "cancelled");
    else if (job.state === "running") {
      this.cancelled.add(jobId);
      this.handles.get(jobId)?.cancel();
      await this.wait(jobId);
    }
    return this.get(jobId);
  }

  /** Resolves with the job once it reaches a terminal state. */
  wait(jobId: string): Promise<SlowmoJob> {
    const job = this.jobs.get(jobId);
    if (!job || !isActive(job)) return Promise.resolve(this.get(jobId));
    return new Promise((resolve) => {
      const list = this.waiters.get(jobId) ?? [];
      list.push(() => resolve(this.get(jobId)));
      this.waiters.set(jobId, list);
    });
  }

  async start(raw: unknown): Promise<SlowmoJob> {
    const input = slowmoStartInput.parse(raw);
    const source = await realpath(input.sourcePath).catch(() => {
      throw new Error("SLOWMO_SOURCE: 원본 영상을 찾지 못했어요.");
    });
    if (!(await stat(source)).isFile()) throw new Error("SLOWMO_SOURCE: 원본은 일반 파일이어야 해요.");
    if (!VIDEO_EXTENSIONS.has(path.extname(source).toLowerCase()))
      throw new Error("SLOWMO_SOURCE: mov/mp4/m4v 영상만 처리해요.");
    const output = path.resolve(input.outputPath);
    const directory = await realpath(path.dirname(output)).catch(() => {
      throw new Error("SLOWMO_OUTPUT: 저장할 폴더가 없어요.");
    });
    const target = path.join(directory, path.basename(output));
    if (target === source) throw new Error("SLOWMO_OUTPUT: 원본을 덮어쓸 수 없어요.");
    const existing = await stat(target).catch(() => undefined);
    if (existing && (!input.overwrite || !existing.isFile()))
      throw new Error("SLOWMO_OUTPUT_EXISTS: 같은 이름의 파일이 있어요. overwrite를 켜거나 다른 경로를 지정해주세요.");
    if ([...this.jobs.values()].some((job) => isActive(job) && job.outputPath === output))
      throw new Error("SLOWMO_OUTPUT: 같은 경로로 만드는 작업이 이미 진행 중이에요.");
    // Validate the range before queueing so mistakes come back immediately.
    const probe = await this.probe(source);
    const settings = plan(probe, input);

    const job: SlowmoJob = {
      id: randomUUID(),
      sourcePath: source,
      outputPath: output,
      state: "queued",
      percent: 0,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(job.id, job);
    this.prune();
    const next = this.queue.then(() => this.execute(job, target, probe, settings));
    this.queue = next.catch(() => undefined);
    return this.get(job.id);
  }

  private async probe(source: string): Promise<Probe> {
    const result = await this.run("probe", source, () => undefined).done;
    return {
      width: Number(result.width),
      height: Number(result.height),
      duration: Number(result.duration),
      fps: Number(result.fps),
      hdr: Boolean(result.hdr),
      hasAudio: Boolean(result.hasAudio),
    };
  }

  private async execute(
    job: SlowmoJob,
    target: string,
    probe: Probe,
    settings: Plan,
  ) {
    if (job.state !== "queued") return;
    job.state = "running";
    const began = performance.now();
    const work = await mkdtemp(path.join(os.tmpdir(), "reels-slowmo-"));
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.partial${path.extname(target)}`);
    try {
      const request = path.join(work, "request.json");
      await writeFile(request, JSON.stringify({
        source: job.sourcePath,
        output: temporary,
        start: settings.start,
        duration: settings.end - settings.start,
        speed: settings.speed,
        fps: settings.fps,
        flowLongSide: SLOWMO_FLOW_LONG_SIDE,
      }));
      if (this.cancelled.has(job.id)) throw new Cancelled();
      const handle = this.run("render", request, (percent) => { job.percent = Math.min(99, Math.round(percent)); });
      this.handles.set(job.id, handle);
      const native = await handle.done;
      if (this.cancelled.has(job.id)) throw new Cancelled();
      await rename(temporary, target);
      const bytes = (await stat(target)).size;
      job.result = {
        outputPath: job.outputPath,
        bytes,
        width: Number(native.width),
        height: Number(native.height),
        fps: Number(native.fps),
        speed: settings.speed,
        durationSeconds: Number(native.durationSeconds),
        start: settings.start,
        end: settings.end,
        sourceDurationSeconds: probe.duration,
        sourceFps: Math.round(probe.fps * 1000) / 1000,
        frames: Number(native.frames),
        interpolatedFrames: Number(native.interpolatedFrames),
        hdr: Boolean(native.hdr),
        codec: native.codec === "hevc-main10" ? "hevc-main10" : "h264",
        elapsedMs: Math.round(performance.now() - began),
        audio: "removed",
        warnings: settings.warnings,
      };
      this.finish(job, "succeeded");
    } catch (error) {
      if (error instanceof Cancelled || this.cancelled.has(job.id)) this.finish(job, "cancelled");
      else this.finish(job, "failed", error instanceof Error ? error.message : String(error));
    } finally {
      this.handles.delete(job.id);
      this.cancelled.delete(job.id);
      await rm(temporary, { force: true });
      await rm(work, { recursive: true, force: true });
      this.wakeWaiters(job.id);
    }
  }

  private finish(job: SlowmoJob, state: "succeeded" | "failed" | "cancelled", error?: string) {
    job.state = state;
    if (state === "succeeded") job.percent = 100;
    if (error) job.error = error;
    job.finishedAt = new Date().toISOString();
    // A cancelled queued job can have waiters even though it never enters the render loop.
    if (state === "cancelled") this.wakeWaiters(job.id);
  }

  private wakeWaiters(jobId: string) {
    const waiters = this.waiters.get(jobId);
    if (!waiters) return;
    this.waiters.delete(jobId);
    for (const wake of waiters) wake();
  }

  private prune() {
    const finished = [...this.jobs.values()].filter((job) => job.finishedAt);
    for (const job of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED_JOBS))) this.jobs.delete(job.id);
  }
}

class Cancelled extends Error {}

function nativeRunner(executable: string, logs?: ExecutionLogs): Runner {
  const labels: Record<Command, string> = { probe: "슬로우 · 영상 정보", render: "슬로우 · GPU 보간·인코딩" };
  return (command, argument, onProgress) => {
    const options: SpawnOptions = { detached: true, stdio: ["ignore", "pipe", "pipe"] };
    const child: ChildProcess = logs
      ? loggedSpawn(logs, { source: "slowmo", label: labels[command] }, executable, [command, argument], options)
      : spawn(executable, [command, argument], options);
    let killed = false;
    const done = new Promise<Record<string, unknown>>((resolve, reject) => {
      let result: Record<string, unknown> | undefined;
      let pending = "";
      let stderr = "";
      const decoder = new StringDecoder("utf8");
      child.stdout?.on("data", (chunk: Buffer) => {
        pending += decoder.write(chunk);
        const lines = pending.split("\n");
        pending = lines.pop()!;
        for (const line of lines) {
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (event.type === "progress" && typeof event.percent === "number") onProgress(event.percent);
            if (event.type === "result") result = event;
          } catch { /* not JSON */ }
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
      child.once("error", (error) => reject(new Error(`SLOWMO_NATIVE: 슬로우 도구를 실행하지 못했어요. ${error.message}`)));
      child.once("close", (code, signal) => {
        if (code === 0 && result) resolve(result);
        else if (killed) reject(new Cancelled());
        else {
          const message = stderr.trim().split("\n").at(-1) || `exit ${code ?? signal}`;
          reject(new Error(message.startsWith("SLOWMO_") ? message : `SLOWMO_NATIVE: ${message}`));
        }
      });
    });
    return {
      done,
      cancel() {
        killed = true;
        // The tool runs in its own process group so nothing outlives a cancel.
        try { if (child.pid) process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
      },
    };
  };
}
