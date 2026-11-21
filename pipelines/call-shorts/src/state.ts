/**
 * 상태 저장소 — 파일 해시(멱등성), 단계 상태, 비용, 화자 매핑, 에피소드 번호.
 *
 * SQLite 대신 단일 JSON 파일을 임시 파일 + rename(원자적)으로 씁니다.
 * 이 파이프라인은 launchd가 한 번에 하나만 돌리므로 이 정도면 충분하고,
 * Node 내장 모듈 외에 네이티브 의존성이 필요 없습니다.
 * (같은 통화를 두 번 처리해 돈을 두 번 쓰는 사고를 막는 것이 목적)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type FileStatus = "processing" | "done" | "failed" | "needs_review" | "blocked" | "skipped";

export interface FileRecord {
  sha256: string;
  sourcePath: string;
  sizeBytes: number;
  firstSeenAt: string;
  status: FileStatus;
  projectDir?: string;
  error?: string;
  updatedAt: string;
}

export interface StageRecord {
  status: string;
  startedAt?: string;
  finishedAt?: string;
  detail?: string;
}

export interface CostRecord {
  at: string;
  day: string;
  projectDir: string | null;
  stage: string | null;
  provider: string;
  usd: number;
  note?: string;
}

export interface SpeakerMapRecord {
  map: Record<string, string>;
  confidence: string;
  updatedAt: string;
}

interface StateData {
  version: 1;
  files: Record<string, FileRecord>;
  stages: Record<string, Record<string, StageRecord>>;
  costs: CostRecord[];
  counters: Record<string, number>;
  speakerMaps: Record<string, SpeakerMapRecord>;
}

const EMPTY: StateData = { version: 1, files: {}, stages: {}, costs: [], counters: {}, speakerMaps: {} };

export function utcNowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** 일일 예산 계산용 로컬 날짜 (기본 Asia/Seoul). */
export function localDay(now: Date = new Date(), timeZone = "Asia/Seoul"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "01";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export class StateStore {
  readonly file: string;
  private data: StateData;

  constructor(file: string) {
    this.file = file;
    mkdirSync(path.dirname(file), { recursive: true });
    this.data = this.read();
  }

  private read(): StateData {
    if (!existsSync(this.file)) return structuredClone(EMPTY);
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StateData>;
      return {
        version: 1,
        files: parsed.files ?? {},
        stages: parsed.stages ?? {},
        costs: parsed.costs ?? [],
        counters: parsed.counters ?? {},
        speakerMaps: parsed.speakerMaps ?? {},
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private save(): void {
    const temp = `${this.file}.tmp`;
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(temp, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(temp, this.file);
  }

  // ── 파일(해시) ───────────────────────────────────────
  getFile(sha256: string): FileRecord | null {
    return this.data.files[sha256] ?? null;
  }

  hasHash(sha256: string): boolean {
    return Boolean(this.data.files[sha256]);
  }

  /** 해시를 '처리 중'으로 선점. 이미 있으면 false (중복). */
  claimFile(sha256: string, sourcePath: string, sizeBytes: number, now = utcNowIso()): boolean {
    if (this.data.files[sha256]) return false;
    this.data.files[sha256] = {
      sha256,
      sourcePath,
      sizeBytes,
      firstSeenAt: now,
      status: "processing",
      updatedAt: now,
    };
    this.save();
    return true;
  }

  setFileStatus(sha256: string, status: FileStatus, options: { projectDir?: string; error?: string } = {}): void {
    const record = this.data.files[sha256];
    if (!record) return;
    record.status = status;
    if (options.projectDir !== undefined) record.projectDir = options.projectDir;
    if (options.error !== undefined) record.error = options.error;
    record.updatedAt = utcNowIso();
    this.save();
  }

  listFiles(limit = 20): FileRecord[] {
    return Object.values(this.data.files)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, limit);
  }

  // ── 단계 ─────────────────────────────────────────────
  startStage(projectDir: string, stage: string): void {
    this.data.stages[projectDir] ??= {};
    this.data.stages[projectDir][stage] = { status: "running", startedAt: utcNowIso() };
    this.save();
  }

  finishStage(projectDir: string, stage: string, status = "done", detail?: string): void {
    this.data.stages[projectDir] ??= {};
    const previous = this.data.stages[projectDir][stage];
    this.data.stages[projectDir][stage] = {
      status,
      startedAt: previous?.startedAt ?? utcNowIso(),
      finishedAt: utcNowIso(),
      detail,
    };
    this.save();
  }

  stageStatus(projectDir: string, stage: string): string | null {
    return this.data.stages[projectDir]?.[stage]?.status ?? null;
  }

  stageMap(projectDir: string): Record<string, string> {
    const stages = this.data.stages[projectDir] ?? {};
    return Object.fromEntries(Object.entries(stages).map(([stage, record]) => [stage, record.status]));
  }

  // ── 비용 ─────────────────────────────────────────────
  addCost(input: {
    usd: number;
    provider: string;
    projectDir?: string | null;
    stage?: string | null;
    note?: string;
    day?: string;
    timeZone?: string;
  }): void {
    this.data.costs.push({
      at: utcNowIso(),
      day: input.day ?? localDay(new Date(), input.timeZone ?? "Asia/Seoul"),
      projectDir: input.projectDir ?? null,
      stage: input.stage ?? null,
      provider: input.provider,
      usd: Number(input.usd),
      note: input.note,
    });
    this.save();
  }

  projectCost(projectDir: string): number {
    return this.data.costs.filter((cost) => cost.projectDir === projectDir).reduce((sum, cost) => sum + cost.usd, 0);
  }

  projectStageCost(projectDir: string, stage: string): number {
    return this.data.costs
      .filter((cost) => cost.projectDir === projectDir && cost.stage === stage)
      .reduce((sum, cost) => sum + cost.usd, 0);
  }

  costOnDay(day = localDay()): number {
    return this.data.costs.filter((cost) => cost.day === day).reduce((sum, cost) => sum + cost.usd, 0);
  }

  costByDay(limit = 14): Array<{ day: string; usd: number; calls: number }> {
    const grouped = new Map<string, { usd: number; calls: number }>();
    for (const cost of this.data.costs) {
      const entry = grouped.get(cost.day) ?? { usd: 0, calls: 0 };
      entry.usd += cost.usd;
      entry.calls += 1;
      grouped.set(cost.day, entry);
    }
    return [...grouped.entries()]
      .map(([day, entry]) => ({ day, usd: Number(entry.usd.toFixed(4)), calls: entry.calls }))
      .sort((a, b) => (a.day < b.day ? 1 : -1))
      .slice(0, limit);
  }

  costByProvider(): Array<{ provider: string; usd: number; calls: number }> {
    const grouped = new Map<string, { usd: number; calls: number }>();
    for (const cost of this.data.costs) {
      const entry = grouped.get(cost.provider) ?? { usd: 0, calls: 0 };
      entry.usd += cost.usd;
      entry.calls += 1;
      grouped.set(cost.provider, entry);
    }
    return [...grouped.entries()]
      .map(([provider, entry]) => ({ provider, usd: Number(entry.usd.toFixed(4)), calls: entry.calls }))
      .sort((a, b) => b.usd - a.usd);
  }

  // ── 화자 ─────────────────────────────────────────────
  saveSpeakerMap(projectDir: string, map: Record<string, string>, confidence = "human"): void {
    this.data.speakerMaps[projectDir] = { map, confidence, updatedAt: utcNowIso() };
    this.save();
  }

  loadSpeakerMap(projectDir: string): SpeakerMapRecord | null {
    return this.data.speakerMaps[projectDir] ?? null;
  }

  // ── 카운터 ───────────────────────────────────────────
  nextEpisodeNumber(name = "episode"): number {
    const value = (this.data.counters[name] ?? 0) + 1;
    this.data.counters[name] = value;
    this.save();
    return value;
  }

  counter(name = "episode"): number {
    return this.data.counters[name] ?? 0;
  }

  setCounter(value: number, name = "episode"): void {
    this.data.counters[name] = Math.trunc(value);
    this.save();
  }

  // ── 요약 ─────────────────────────────────────────────
  summary(): {
    files: Record<string, number>;
    episodes: number;
    costTodayUsd: number;
    costTotalUsd: number;
    stateFile: string;
  } {
    const files: Record<string, number> = {};
    for (const record of Object.values(this.data.files)) {
      files[record.status] = (files[record.status] ?? 0) + 1;
    }
    return {
      files,
      episodes: this.counter(),
      costTodayUsd: Number(this.costOnDay().toFixed(4)),
      costTotalUsd: Number(this.data.costs.reduce((sum, cost) => sum + cost.usd, 0).toFixed(4)),
      stateFile: this.file,
    };
  }
}
