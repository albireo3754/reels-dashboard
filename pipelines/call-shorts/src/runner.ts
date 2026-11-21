/**
 * 오케스트레이션 — 한 통화를 EP 폴더로 만들고 5단계를 실행합니다.
 * transcribe → plan → illustrate → render → publish
 *
 * 멈춤 규칙(가드레일 6): 화자 매핑/캐릭터 시트/스키마 검증 → needs_review,
 * 예산 초과 → blocked, 그 밖의 실패 → failed(+ 원본 사본과 error.log).
 */

import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Config } from "./config.js";
import { ensureDirs, episodeIdFor, projectDirFor, projectSubdirs } from "./config.js";
import { loadEpisode } from "./episode.js";
import { BudgetExceededError, NeedsHumanError, PipelineError } from "./errors.js";
import { Illustrator } from "./illustrator.js";
import { notifyBlocked, notifyFailed, notifyReady } from "./notify.js";
import { copyToOutbox, publish } from "./publish.js";
import { render } from "./renderer.js";
import { ScriptWriter } from "./scriptwriter.js";
import { StateStore, utcNowIso } from "./state.js";
import { loadTranscript, Transcriber } from "./transcribe.js";
import type { Episode, ProjectMeta, RunResult, RunStatus, Stage, Transcript } from "./types.js";
import { STAGES } from "./types.js";
import { InboxScanner, sha256File, type ScanItem } from "./watcher.js";

const ARTIFACTS: Record<Stage, string> = {
  transcribe: "transcript/diarized.json",
  plan: "plan/episode.json",
  illustrate: "images/cut_01.png",
  render: "render/short.mp4",
  publish: "publish/meta.json",
};

export interface PipelineOptions {
  executeRender?: boolean;
  notifier?: (kind: "ready" | "blocked" | "failed", projectDir: string, stage: string, message: string) => void;
}

export class Pipeline {
  readonly config: Config;
  readonly store: StateStore;
  readonly executeRender: boolean;
  private readonly notifier?: PipelineOptions["notifier"];

  constructor(config: Config, store?: StateStore, options: PipelineOptions = {}) {
    this.config = config;
    this.store = store ?? new StateStore(config.stateFile);
    this.executeRender = options.executeRender ?? !config.dryRun;
    this.notifier = options.notifier;
    ensureDirs(config);
  }

  // ── inbox ────────────────────────────────────────────
  async runOnce(options: { file?: string; startStage?: Stage; force?: boolean; limit?: number } = {}): Promise<RunResult[]> {
    if (options.file) return [await this.runFile(options.file, options)];

    const scanner = new InboxScanner(this.config, this.store);
    let items = (await scanner.scan(options.force ?? false)).filter((item) => item.status === "new");
    const limit = options.limit ?? 1;
    if (limit !== undefined) items = items.slice(0, limit);
    const results: RunResult[] = [];
    for (const item of items) {
      if (!this.store.claimFile(item.sha256!, item.path, item.size)) continue;
      results.push(await this.runFile(item.path, { ...options, sha256: item.sha256 }));
    }
    return results;
  }

  async runFile(
    file: string,
    options: { sha256?: string; startStage?: Stage; force?: boolean } = {},
  ): Promise<RunResult> {
    if (!existsSync(file)) throw new PipelineError(`파일이 없습니다: ${file}`);
    const digest = options.sha256 ?? (await sha256File(file));
    const existing = this.store.getFile(digest);

    if (existing && !options.force) {
      if (["done", "processing", "needs_review", "blocked"].includes(existing.status)) {
        return {
          projectDir: existing.projectDir ?? this.config.projectsDir,
          episodeId: existing.projectDir ? path.basename(existing.projectDir).split("_").at(-1) ?? "EP" : "EP",
          status: "skipped",
          message: `이미 처리한 통화입니다 (${existing.status})`,
          stages: {},
          video: null,
          cover: null,
          meta: null,
        };
      }
    }

    if (!existing) this.store.claimFile(digest, path.resolve(file), statSync(file).size);
    this.store.setFileStatus(digest, "processing");
    const project = this.projectFor(digest, existing, file, options.force ?? false);
    this.store.setFileStatus(digest, "processing", { projectDir: project });
    return this.runStages(project, { startStage: options.startStage, digest, source: file, force: options.force });
  }

  async resume(projectDir: string, startStage?: Stage, force = false): Promise<RunResult> {
    const meta = this.readProject(projectDir);
    const source = meta.sourcePath && existsSync(meta.sourcePath) ? meta.sourcePath : null;
    return this.runStages(projectDir, { startStage, digest: meta.sha256, source, force });
  }

  // ── 단계 실행 ────────────────────────────────────────
  private async runStages(
    projectDir: string,
    options: { startStage?: Stage; digest?: string; source: string | null; force?: boolean },
  ): Promise<RunResult> {
    const episodeId = this.episodeId(projectDir);
    let stages = [...STAGES];
    if (options.startStage) {
      const index = STAGES.indexOf(options.startStage);
      if (index < 0) throw new PipelineError(`알 수 없는 단계입니다: ${options.startStage}`);
      stages = stages.slice(index);
    }
    const statuses: Record<string, string> = {};
    const result: RunResult = {
      projectDir,
      episodeId,
      status: "done",
      message: "",
      stages: statuses,
      video: null,
      cover: null,
      meta: null,
    };
    let stage: Stage = stages[0];

    try {
      for (stage of stages) {
        if (!options.force && this.stageComplete(projectDir, stage)) {
          statuses[stage] = "이미 완료";
          continue;
        }
        this.store.startStage(projectDir, stage);
        console.log(`[${path.basename(projectDir)}] ${stage} 시작`);
        await this.runStage(projectDir, stage, options.source);
        this.store.finishStage(projectDir, stage, "done");
        statuses[stage] = "완료";
      }

      const video = path.join(projectDir, "render", "short.mp4");
      const cover = path.join(projectDir, "render", "cover.png");
      const meta = path.join(projectDir, "publish", "meta.json");
      result.video = existsSync(video) ? video : null;
      result.cover = existsSync(cover) ? cover : null;
      result.meta = existsSync(meta) ? meta : null;
      this.finalizeSuccess(projectDir, options.digest, options.source);
      this.notify("ready", projectDir, "publish", episodeId);
      return result;
    } catch (error) {
      if (error instanceof NeedsHumanError) {
        this.store.finishStage(projectDir, stage, "needs_review", error.message);
        statuses[stage] = "사람 확인 필요";
        result.status = "needs_review";
        result.message = error.message;
        this.setProjectStatus(projectDir, "needs_review", error.message);
        if (options.digest) this.store.setFileStatus(options.digest, "needs_review", { projectDir, error: error.message });
        this.notify("blocked", projectDir, stage, error.message);
        if (error.action) console.warn(`다음 명령: ${error.action}`);
        return result;
      }
      if (error instanceof BudgetExceededError) {
        this.store.finishStage(projectDir, stage, "blocked", error.message);
        statuses[stage] = "예산 초과";
        result.status = "blocked";
        result.message = error.message;
        this.setProjectStatus(projectDir, "blocked", error.message);
        if (options.digest) this.store.setFileStatus(options.digest, "blocked", { projectDir, error: error.message });
        this.notify("blocked", projectDir, stage, error.message);
        return result;
      }

      const detail = `${(error as Error).name ?? "Error"}: ${(error as Error).message}`;
      this.store.finishStage(projectDir, stage, "failed", detail);
      statuses[stage] = "실패";
      result.status = "failed";
      result.message = detail;
      this.writeErrorLog(projectDir, stage, error as Error);
      if (options.source) this.copyToFailed(projectDir, options.source);
      this.setProjectStatus(projectDir, "failed", detail);
      if (options.digest) this.store.setFileStatus(options.digest, "failed", { projectDir, error: detail });
      this.notify("failed", projectDir, stage, detail);
      return result;
    }
  }

  private async runStage(projectDir: string, stage: Stage, source: string | null): Promise<void> {
    if (stage === "transcribe") {
      if (!source) throw new PipelineError("원본 오디오 경로를 찾을 수 없습니다.", { hint: "project.json 의 sourcePath 확인" });
      await new Transcriber(this.config, this.store).run(projectDir, source);
      return;
    }
    if (stage === "plan") {
      const transcript = loadTranscript(projectDir);
      const writer = new ScriptWriter(this.config, this.store);
      await writer.plan(projectDir, transcript);
      await writer.writeEpisode(projectDir, transcript);
      return;
    }
    if (stage === "illustrate") {
      await new Illustrator(this.config, this.store).generate(projectDir, loadEpisode(projectDir));
      return;
    }
    if (stage === "render") {
      render(projectDir, loadEpisode(projectDir), this.config, { execute: this.executeRender });
      return;
    }
    if (stage === "publish") {
      const rendered = existsSync(path.join(projectDir, "render", "short.mp4"));
      publish(projectDir, loadEpisode(projectDir), this.config, { rendered });
      return;
    }
    throw new PipelineError(`알 수 없는 단계: ${stage}`);
  }

  // ── 상태·파일 ───────────────────────────────────────
  private projectFor(digest: string, existing: ReturnType<StateStore["getFile"]>, file: string, force: boolean): string {
    if (existing?.projectDir && ["needs_review", "blocked", "failed"].includes(existing.status) && existsSync(existing.projectDir)) {
      this.ensureLayout(existing.projectDir);
      return existing.projectDir;
    }

    const modified = statSync(file).mtime;
    const callDate = new Date(modified).toLocaleDateString("en-CA", { timeZone: this.config.tz });
    const number = this.store.nextEpisodeNumber();
    let project = projectDirFor(this.config, callDate, number);
    let suffix = 1;
    while (existsSync(project)) {
      suffix += 1;
      project = path.join(this.config.projectsDir, `${callDate}_${episodeIdFor(number)}-${suffix}`);
    }
    this.ensureLayout(project);

    const ext = path.extname(file).toLowerCase() || ".m4a";
    const audioDest = path.join(project, "audio", `call${ext}`);
    copyFileSync(file, audioDest);
    this.writeProject(project, {
      episodeId: this.episodeId(project),
      sourcePath: path.resolve(file),
      sha256: digest,
      sourceSize: statSync(file).size,
      callDate,
      createdAt: new Date().toISOString(),
      status: "processing",
      audio: path.relative(project, audioDest),
    });
    void force;
    return project;
  }

  private ensureLayout(projectDir: string): void {
    mkdirSync(projectDir, { recursive: true });
    for (const sub of projectSubdirs()) mkdirSync(path.join(projectDir, sub), { recursive: true });
  }

  private stageComplete(projectDir: string, stage: Stage): boolean {
    if (this.store.stageStatus(projectDir, stage) !== "done") return false;
    let artifact = path.join(projectDir, ARTIFACTS[stage]);
    if (stage === "render" && this.config.dryRun && !this.executeRender) {
      artifact = path.join(projectDir, "render", "ffmpeg-plan.txt");
    }
    return existsSync(artifact);
  }

  private finalizeSuccess(projectDir: string, digest?: string, source?: string | null): void {
    this.setProjectStatus(projectDir, "done");
    if (digest) this.store.setFileStatus(digest, "done", { projectDir });
    if (source) this.archiveSource(source, digest);
    copyToOutbox(projectDir, this.config);
  }

  private archiveSource(source: string, digest?: string): void {
    const prefix = (digest ?? "unknown").slice(0, 8);
    const dest = path.join(this.config.processedDir, `${prefix}_${path.basename(source)}`);
    try {
      if (this.config.archiveMode === "move") renameSync(source, dest);
      else copyFileSync(source, dest);
    } catch (error) {
      console.error(`원본 보존 실패 (${source}): ${(error as Error).message}`);
    }
  }

  private copyToFailed(projectDir: string, source: string): void {
    try {
      const target = path.join(this.config.failedDir, path.basename(projectDir));
      mkdirSync(target, { recursive: true });
      copyFileSync(source, path.join(target, path.basename(source)));
    } catch {
      /* 보존 실패는 기록만 */
    }
  }

  private writeErrorLog(projectDir: string, stage: string, error: Error): void {
    const content = `${new Date().toISOString()} [${stage}] ${error.name}: ${error.message}\n\n${error.stack ?? ""}\n`;
    for (const target of [
      path.join(this.config.failedDir, path.basename(projectDir), "error.log"),
      path.join(projectDir, "error.log"),
    ]) {
      try {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content, "utf8");
      } catch {
        /* 무시 */
      }
    }
  }

  private writeProject(projectDir: string, meta: ProjectMeta): void {
    writeFileSync(path.join(projectDir, "project.json"), JSON.stringify(meta, null, 2), "utf8");
  }

  private readProject(projectDir: string): Partial<ProjectMeta> {
    const file = path.join(projectDir, "project.json");
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Partial<ProjectMeta>;
    } catch {
      return {};
    }
  }

  private setProjectStatus(projectDir: string, status: RunStatus, detail = ""): void {
    const meta = this.readProject(projectDir);
    const updated: Partial<ProjectMeta> = {
      ...meta,
      status,
      updatedAt: utcNowIso(),
      statusDetail: detail || meta.statusDetail,
      stages: this.store.stageMap(projectDir),
    };
    writeFileSync(path.join(projectDir, "project.json"), JSON.stringify(updated, null, 2), "utf8");
  }

  private episodeId(projectDir: string): string {
    const name = path.basename(projectDir);
    return name.includes("_") ? name.split("_")[1].split("-")[0] : name || "EP";
  }

  private notify(kind: "ready" | "blocked" | "failed", projectDir: string, stage: string, message: string): void {
    if (this.notifier) {
      this.notifier(kind, projectDir, stage, message);
      return;
    }
    if (kind === "ready") notifyReady(projectDir, this.episodeId(projectDir), this.duration(projectDir));
    else if (kind === "blocked") notifyBlocked(projectDir, stage, message);
    else notifyFailed(projectDir, stage, message);
  }

  private duration(projectDir: string): number | undefined {
    try {
      const episode: Episode = loadEpisode(projectDir);
      return episode.cuts.at(-1)?.tEnd;
    } catch {
      return undefined;
    }
  }
}

export type { ScanItem, Transcript };
