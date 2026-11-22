// 락 파일은 `wx`(O_EXCL)로 원자적으로 만들고 pid 생존 여부로 멈춘 실행을 가립니다.
// 두 인스턴스가 같은 통화로 API 를 두 번 결제하는 것을 막는 유일한 장치입니다.

import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

import { PipelineError } from "./errors.js";

export const DEFAULT_STALE_MS = 3 * 60 * 60 * 1000;
const BROKEN_LOCK_GRACE_MS = 60_000;

export interface LockRecord {
  pid: number;
  startedAt: string;
  command: string;
}

export interface LockHandle {
  readonly file: string;
  readonly record: LockRecord;
  release(): void;
}

export class LockHeldError extends PipelineError {
  override readonly exitCode = 5;
  override readonly status = "skipped";
  readonly holder: LockRecord | null;

  constructor(file: string, holder: LockRecord | null) {
    super(
      `다른 실행이 이미 진행 중입니다${
        holder ? ` (pid ${holder.pid}, ${holder.command || "알 수 없는 명령"}, ${holder.startedAt})` : ""
      } — 이번 실행은 건너뜁니다.`,
      { hint: `멈춘 실행이라면 ${file} 을(를) 지우세요. ${DEFAULT_STALE_MS / 3_600_000}시간이 지난 락은 자동으로 풀립니다.` },
    );
    this.name = "LockHeldError";
    this.holder = holder;
  }
}

export function lockFileFor(stateFile: string): string {
  return path.join(path.dirname(stateFile), "pipeline.lock");
}

export interface AcquireOptions {
  command?: string;
  now?: number;
  staleMs?: number;
  isAlive?: (pid: number) => boolean;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readRecord(file: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<LockRecord>;
    if (typeof parsed.pid !== "number") return null;
    return {
      pid: parsed.pid,
      startedAt: String(parsed.startedAt ?? ""),
      command: String(parsed.command ?? ""),
    };
  } catch {
    return null;
  }
}

function modifiedAt(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function isStale(
  file: string,
  holder: LockRecord | null,
  now: number,
  staleMs: number,
  isAlive: (pid: number) => boolean,
): boolean {
  const modified = modifiedAt(file);
  if (modified === null) return true;
  const startedAt = holder ? Date.parse(holder.startedAt) : Number.NaN;
  const started = Number.isFinite(startedAt) ? startedAt : modified;
  if (now - started > staleMs) return true;
  if (!holder) return now - modified > BROKEN_LOCK_GRACE_MS;
  return !isAlive(holder.pid);
}

function handleFor(file: string, record: LockRecord): LockHandle {
  let released = false;
  return {
    file,
    record,
    release(): void {
      if (released) return;
      released = true;
      const current = readRecord(file);
      if (current && (current.pid !== record.pid || current.startedAt !== record.startedAt)) return;
      try {
        unlinkSync(file);
      } catch {
        /* 이미 지워졌으면 그대로 둡니다 */
      }
    },
  };
}

export function acquireLock(stateFile: string, options: AcquireOptions = {}): LockHandle {
  const file = lockFileFor(stateFile);
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const isAlive = options.isAlive ?? isProcessAlive;
  const record: LockRecord = {
    pid: process.pid,
    startedAt: new Date(now).toISOString(),
    command: options.command ?? "",
  };
  mkdirSync(path.dirname(file), { recursive: true });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(file, "wx");
      try {
        writeSync(fd, `${JSON.stringify(record, null, 2)}\n`, 0, "utf8");
      } finally {
        closeSync(fd);
      }
      return handleFor(file, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readRecord(file);
      if (!isStale(file, holder, now, staleMs, isAlive)) throw new LockHeldError(file, holder);
      try {
        unlinkSync(file);
      } catch {
        /* 다른 프로세스가 먼저 지웠으면 다음 시도에서 잡습니다 */
      }
    }
  }
  throw new LockHeldError(file, readRecord(file));
}
