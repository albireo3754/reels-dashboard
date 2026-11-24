import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { chmod, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { readJsonFile, writeJsonAtomic } from "../shared/lib/fs";
import {
  dayIn,
  scheduleFileSchema,
  startedStatuses,
  type Cursor,
  type RunStatus,
  type RunTrigger,
  type Schedule,
} from "../features/scheduler";

export const schedulerDir = (root: string) => path.join(root, "scheduler");
export const runDir = (root: string, runId: string) => path.join(schedulerDir(root), "runs", runId);
export const newRunId = () => `r_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;

export interface RunRow {
  run_id: string;
  schedule_id: string;
  occurrence_key: string;
  trigger: RunTrigger;
  scheduled_at: string;
  deadline_at: string;
  status: RunStatus;
  lock_key: string | null;
  reason: string | null;
  preflight_failed_at: string | null;
  notified: number;
  pid: number | null;
  pid_started: string | null;
  host_pid: number | null;
  host_pid_started: string | null;
  session_id: string | null;
  exit_code: number | null;
  signal: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result_json: string | null;
}

const SCHEMA_VERSION = 1;
const migration = `
CREATE TABLE IF NOT EXISTS cursor(
  schedule_id TEXT PRIMARY KEY,
  last_checked_at TEXT NOT NULL,
  definition_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs(
  run_id TEXT NOT NULL UNIQUE,
  schedule_id TEXT NOT NULL,
  occurrence_key TEXT NOT NULL,
  trigger TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  status TEXT NOT NULL,
  lock_key TEXT,
  reason TEXT,
  preflight_failed_at TEXT,
  notified INTEGER NOT NULL DEFAULT 0,
  pid INTEGER,
  pid_started TEXT,
  host_pid INTEGER,
  host_pid_started TEXT,
  session_id TEXT,
  exit_code INTEGER,
  signal TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  result_json TEXT,
  PRIMARY KEY(schedule_id, occurrence_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_per_schedule ON runs(schedule_id) WHERE status = 'running';
CREATE UNIQUE INDEX IF NOT EXISTS one_active_per_lock ON runs(lock_key) WHERE status = 'running' AND lock_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_by_time ON runs(schedule_id, scheduled_at);
`;
const RESULT_LIMIT = 16_000;
const KEEP_PER_SCHEDULE = 200;
const DROP_QUIET_AFTER_MS = 30 * 24 * 60 * 60_000;
/** Rows the daily limit may still count (an occurrence day plus the longest catch-up) are never pruned. */
const COUNTED_MS = 50 * 60 * 60_000;
const HOUR = 60 * 60_000;

export type ClaimResult =
  | { kind: "claimed" }
  | { kind: "gone" }
  | { kind: "locked" }
  | { kind: "expired" }
  | { kind: "skipped"; reason: "already-running" | "daily-limit" };
export interface ClaimOptions {
  now: Date;
  timezone: string;
  maxRunsPerDay: number;
  hostPid: number;
  hostPidStarted?: string;
}

/**
 * `<userData>/scheduler/scheduler.sqlite`: occurrences, runs and the catch-up cursor.
 * The database, not the process, guarantees one run per occurrence (primary key),
 * one running run per schedule and one aside run at a time (partial unique indexes).
 * Several connections (dev and packaged app share the profile) may use it at once.
 */
export class SchedulerDb {
  readonly db: DatabaseSync;
  constructor(private root: string) {
    const dir = schedulerDir(root);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const file = path.join(dir, "scheduler.sqlite");
    this.db = new DatabaseSync(file, { timeout: 5000 });
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=OFF;");
    chmodSync(file, 0o600);
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version < SCHEMA_VERSION)
      this.transaction(() => {
        this.db.exec(migration);
        this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
      });
  }

  close() {
    if (this.db.isOpen) this.db.close();
  }

  /** BEGIN IMMEDIATE: the write lock is taken up front, so two connections serialize here. */
  transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = body();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  cursor(scheduleId: string): Cursor | undefined {
    const row = this.db.prepare("SELECT last_checked_at, definition_hash FROM cursor WHERE schedule_id = ?").get(scheduleId) as
      | { last_checked_at: string; definition_hash: string }
      | undefined;
    return row && { lastCheckedAt: new Date(row.last_checked_at), definitionHash: row.definition_hash };
  }

  /**
   * Records past occurrences and moves the cursor in one transaction. `plan` runs inside it with
   * the cursor as stored, so a second instance planning at the same moment sees the moved cursor.
   */
  plan(
    scheduleId: string,
    plan: (cursor: Cursor | undefined) => {
      cursor: Cursor;
      run?: { key: string; trigger: RunTrigger; at: Date; deadline: Date };
      missed: { key: string; at: Date; reason: string }[];
    },
    now: Date,
  ): string | undefined {
    return this.transaction(() => {
      const result = plan(this.cursor(scheduleId));
      const insert = this.db.prepare(
        `INSERT INTO runs(run_id, schedule_id, occurrence_key, trigger, scheduled_at, deadline_at, status, lock_key, reason, created_at, finished_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      );
      const stamp = now.toISOString();
      for (const missed of result.missed)
        insert.run(newRunId(), scheduleId, missed.key, "cron", missed.at.toISOString(), missed.at.toISOString(), "missed", null, missed.reason, stamp, stamp);
      let created: string | undefined;
      if (result.run) {
        const runId = newRunId();
        const change = insert.run(runId, scheduleId, result.run.key, result.run.trigger, result.run.at.toISOString(), result.run.deadline.toISOString(), "pending", "aside", null, stamp, null);
        if (change.changes) created = runId;
        // Only the latest occurrence may run: an older one still pending (its preflight kept failing) gives way.
        this.db
          .prepare(
            `UPDATE runs SET status = 'missed', reason = 'superseded', finished_at = ?
             WHERE schedule_id = ? AND status = 'pending' AND trigger != 'manual' AND scheduled_at < ?`,
          )
          .run(stamp, scheduleId, result.run.at.toISOString());
      }
      this.db
        .prepare(
          `INSERT INTO cursor(schedule_id, last_checked_at, definition_hash) VALUES(?, ?, ?)
           ON CONFLICT(schedule_id) DO UPDATE SET last_checked_at = excluded.last_checked_at, definition_hash = excluded.definition_hash`,
        )
        .run(scheduleId, result.cursor.lastCheckedAt.toISOString(), result.cursor.definitionHash);
      return created;
    });
  }

  /** A manual occurrence; its key is unique per request. */
  insertManual(scheduleId: string, now: Date, deadline: Date) {
    const runId = newRunId();
    this.db
      .prepare(
        `INSERT INTO runs(run_id, schedule_id, occurrence_key, trigger, scheduled_at, deadline_at, status, lock_key, created_at)
         VALUES(?, ?, ?, 'manual', ?, ?, 'pending', 'aside', ?)`,
      )
      .run(runId, scheduleId, `manual:${runId}`, now.toISOString(), deadline.toISOString(), now.toISOString());
    return runId;
  }

  get(runId: string) {
    return this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId) as RunRow | undefined;
  }
  byStatus(status: RunStatus) {
    return this.db.prepare("SELECT * FROM runs WHERE status = ? ORDER BY scheduled_at, created_at").all(status) as unknown as RunRow[];
  }
  runningFor(scheduleId: string) {
    return this.db.prepare("SELECT * FROM runs WHERE schedule_id = ? AND status = 'running'").get(scheduleId) as RunRow | undefined;
  }

  /**
   * Started runs (manual included) whose occurrence falls on `at`'s calendar day in `timezone`.
   * The day is the scheduled one, not the start: a catch-up after midnight still belongs to the
   * day it was due, so it never uses up the next day's run.
   */
  startedOn(scheduleId: string, at: Date, timezone: string) {
    const rows = this.db
      .prepare(
        `SELECT scheduled_at FROM runs WHERE schedule_id = ? AND started_at IS NOT NULL AND scheduled_at >= ? AND scheduled_at <= ?
         AND status IN (${startedStatuses.map(() => "?").join(", ")})`,
      )
      .all(scheduleId, new Date(at.getTime() - 30 * HOUR).toISOString(), new Date(at.getTime() + 30 * HOUR).toISOString(), ...startedStatuses) as {
      scheduled_at: string;
    }[];
    const day = dayIn(at, timezone);
    return rows.filter((row) => dayIn(new Date(row.scheduled_at), timezone) === day).length;
  }
  /** Started runs of today's occurrences (see startedOn). */
  startedToday(scheduleId: string, now: Date, timezone: string) {
    return this.startedOn(scheduleId, now, timezone);
  }

  /**
   * pending → running, atomically with the daily count and both locks. Another instance
   * running the same claim at the same moment waits on BEGIN IMMEDIATE and then sees this one.
   */
  claim(runId: string, options: ClaimOptions): ClaimResult {
    try {
      return this.transaction((): ClaimResult => {
        const row = this.get(runId);
        if (!row || row.status !== "pending") return { kind: "gone" };
        const decided = this.closeIfBlocked(row, options);
        if (decided) return decided;
        if (row.lock_key && this.db.prepare("SELECT 1 FROM runs WHERE lock_key = ? AND status = 'running'").get(row.lock_key))
          return { kind: "locked" };
        this.db
          .prepare(
            `UPDATE runs SET status = 'running', started_at = ?, host_pid = ?, host_pid_started = ?, reason = NULL WHERE run_id = ? AND status = 'pending'`,
          )
          .run(options.now.toISOString(), options.hostPid, options.hostPidStarted ?? null, runId);
        return { kind: "claimed" };
      });
    } catch (error) {
      // The partial unique indexes are the backstop for anything the checks above missed.
      if (/UNIQUE constraint failed/.test(String(error))) return { kind: "locked" };
      throw error;
    }
  }

  /**
   * Closes a pending run that cannot start (past its deadline, another run of the schedule running,
   * the day's limit used up) and says why; undefined when it may start. Runs inside a transaction.
   */
  private closeIfBlocked(row: RunRow, options: ClaimOptions): ClaimResult | undefined {
    const stamp = options.now.toISOString();
    const close = (status: RunStatus, reason: string) =>
      this.db.prepare("UPDATE runs SET status = ?, reason = ?, finished_at = ? WHERE run_id = ?").run(status, reason, stamp, row.run_id);
    if (Date.parse(row.deadline_at) <= options.now.getTime()) {
      if (row.preflight_failed_at) close("blocked", row.reason ?? "preflight");
      else close("missed", "deadline");
      return { kind: "expired" };
    }
    for (const reason of ["already-running", "daily-limit"] as const) {
      const blocked =
        reason === "already-running"
          ? !!this.runningFor(row.schedule_id)
          : this.startedOn(row.schedule_id, new Date(row.scheduled_at), options.timezone) >= options.maxRunsPerDay;
      if (blocked) {
        close("skipped", reason);
        return { kind: "skipped", reason };
      }
    }
    return undefined;
  }

  /** The skip half of claim: closes the run when it cannot start, and otherwise leaves it pending. */
  skipIfBlocked(runId: string, options: ClaimOptions): ClaimResult | undefined {
    return this.transaction(() => {
      const row = this.get(runId);
      if (!row || row.status !== "pending") return { kind: "gone" } as const;
      return this.closeIfBlocked(row, options);
    });
  }

  /** Returns true the first time a pending run's preflight fails (to notify once). */
  preflightFailed(runId: string, reason: string, now: Date) {
    return this.transaction(() => {
      const row = this.get(runId);
      if (!row || row.status !== "pending") return false;
      this.db.prepare("UPDATE runs SET reason = ?, preflight_failed_at = ?, notified = 1 WHERE run_id = ?").run(reason, now.toISOString(), runId);
      return row.notified === 0;
    });
  }

  setProcess(runId: string, pid: number | undefined, pidStarted: string | undefined) {
    this.db.prepare("UPDATE runs SET pid = ?, pid_started = ? WHERE run_id = ?").run(pid ?? null, pidStarted ?? null, runId);
  }
  setSession(runId: string, sessionId: string) {
    this.db.prepare("UPDATE runs SET session_id = ? WHERE run_id = ?").run(sessionId, runId);
  }

  /** running → terminal status. A run that already ended (e.g. reclaimed) is left unchanged. */
  finish(
    runId: string,
    outcome: { status: RunStatus; reason?: string | null; exitCode?: number | null; signal?: string | null; result?: unknown },
    now: Date,
  ) {
    const result = outcome.result === undefined ? null : JSON.stringify(outcome.result).slice(0, RESULT_LIMIT);
    return (
      this.db
        .prepare(
          `UPDATE runs SET status = ?, reason = ?, exit_code = ?, signal = ?, result_json = COALESCE(?, result_json), finished_at = ?
           WHERE run_id = ? AND status = 'running'`,
        )
        .run(outcome.status, outcome.reason ?? null, outcome.exitCode ?? null, outcome.signal ?? null, result, now.toISOString(), runId).changes > 0
    );
  }

  /** pending → skipped/missed/blocked without running. */
  closePending(runId: string, status: RunStatus, reason: string, now: Date) {
    return (
      this.db
        .prepare("UPDATE runs SET status = ?, reason = ?, finished_at = ? WHERE run_id = ? AND status = 'pending'")
        .run(status, reason, now.toISOString(), runId).changes > 0
    );
  }

  list(options: { scheduleId?: string; status?: RunStatus; finished?: boolean; limit: number }) {
    const where: string[] = [];
    const args: string[] = [];
    if (options.scheduleId) where.push("schedule_id = ?"), args.push(options.scheduleId);
    if (options.status) where.push("status = ?"), args.push(options.status);
    if (options.finished) where.push("status NOT IN ('pending', 'running')");
    return this.db
      .prepare(
        `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY COALESCE(started_at, scheduled_at) DESC, created_at DESC LIMIT ?`,
      )
      .all(...args, options.limit) as unknown as RunRow[];
  }

  /**
   * Keep the newest 200 rows per schedule; missed/skipped rows go after 30 days. A started run the
   * daily limit may still count is always kept. The run folders of deleted rows go with them.
   */
  prune(now: Date) {
    const deleted = this.transaction(() => {
      const quiet = this.db
        .prepare("DELETE FROM runs WHERE status IN ('missed', 'skipped') AND scheduled_at < ? RETURNING run_id")
        .all(new Date(now.getTime() - DROP_QUIET_AFTER_MS).toISOString()) as { run_id: string }[];
      const old = this.db
        .prepare(
          `DELETE FROM runs WHERE status NOT IN ('pending', 'running')
           AND NOT (started_at IS NOT NULL AND scheduled_at >= ?)
           AND run_id IN (
             SELECT run_id FROM (
               SELECT run_id, ROW_NUMBER() OVER (PARTITION BY schedule_id ORDER BY scheduled_at DESC, created_at DESC) AS n FROM runs
             ) WHERE n > ${KEEP_PER_SCHEDULE}
           ) RETURNING run_id`,
        )
        .all(new Date(now.getTime() - COUNTED_MS).toISOString()) as { run_id: string }[];
      return [...quiet, ...old].map((row) => row.run_id);
    });
    for (const runId of deleted) rmSync(runDir(this.root, runId), { recursive: true, force: true });
    return deleted;
  }
}

/**
 * `<userData>/scheduler/schedules.json`: definitions people can read and edit by hand.
 * Re-read when the file changes; an invalid edit keeps the last good definitions.
 */
export class ScheduleFileStore {
  private cached: { mtimeMs: number; schedules: Schedule[] } | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  lastError: string | undefined;
  constructor(private root: string) {}
  get path() {
    return path.join(schedulerDir(this.root), "schedules.json");
  }

  async read(): Promise<Schedule[]> {
    const mtimeMs = await stat(this.path).then((s) => s.mtimeMs, () => -1);
    if (this.cached && this.cached.mtimeMs === mtimeMs) return this.cached.schedules;
    try {
      const schedules = await readJsonFile(this.path, (value) => scheduleFileSchema.parse(value).schedules, () => [] as Schedule[]);
      this.cached = { mtimeMs, schedules };
      this.lastError = undefined;
      return schedules;
    } catch (error) {
      this.lastError = `SCHEDULES_INVALID: ${error instanceof Error ? error.message.slice(0, 500) : String(error)}`;
      if (this.cached) return this.cached.schedules;
      throw new Error(this.lastError);
    }
  }

  /** Serialized read-change-write; `change` returns the new list and a result. */
  update<T>(change: (schedules: Schedule[]) => { schedules: Schedule[]; result: T }): Promise<T> {
    const op = this.queue.then(async () => {
      this.cached = undefined;
      const current = await this.read();
      const { schedules, result } = change(current);
      const valid = scheduleFileSchema.parse({ version: 1, schedules });
      await mkdir(schedulerDir(this.root), { recursive: true, mode: 0o700 });
      await writeJsonAtomic(this.path, valid, { mode: 0o600 });
      await chmod(this.path, 0o600);
      this.cached = undefined;
      return result;
    });
    this.queue = op.catch(() => {});
    return op;
  }
}
