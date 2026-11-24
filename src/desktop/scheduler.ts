import { processAlive, processStartTime } from "../shared/lib/autopilot-store";
import {
  dayIn,
  deadlineFor,
  definitionHash,
  dueOccurrences,
  getScheduleRunsInput,
  getSchedulesInput,
  MANUAL_DEADLINE_MS,
  mergeSchedule,
  nextRunAt,
  occurrenceKey,
  runScheduleNowInput,
  setScheduleInput,
  type RunStatus,
  type Schedule,
} from "../features/scheduler";
import { runDir, ScheduleFileStore, SchedulerDb, type RunRow } from "./scheduler-store";

export interface ActionOutcome {
  status: RunStatus;
  reason?: string;
  exitCode?: number | null;
  signal?: string | null;
  result?: unknown;
  /** Account-level stop: pause the schedule until the user turns it back on. */
  pause?: string;
  counts?: { accepted: number; visited: number; commented: number; liked: number };
}
export interface ActionHandle {
  pid?: number;
  done: Promise<ActionOutcome>;
  /** SIGTERM the process group, SIGKILL after a grace period, then stop the Aside session. */
  stop(): Promise<void>;
}
export interface ActionRunner {
  /** A failure code when the run cannot start yet (nothing was done on the site). */
  preflight(schedule: Schedule): Promise<string | undefined>;
  start(context: { schedule: Schedule; run: RunRow; onSession(id: string): void; log(message: string): void }): Promise<ActionHandle>;
  stopSession(sessionId: string): Promise<void>;
  stopOrphan(pid: number, sessionId: string | null): Promise<void>;
}
export interface SchedulerNotice {
  title: string;
  body: string;
}
export interface SchedulerOptions {
  root: string;
  runner: ActionRunner;
  now?: () => Date;
  hostPid?: number;
  hostPidStarted?: string;
  isAlive?: (pid: number) => boolean;
  processStart?: (pid: number) => string | undefined;
  notify?: (notice: SchedulerNotice) => void;
  log?: (message: string) => void;
  intervalMs?: number;
  startDelayMs?: number;
  preflightRetryMs?: number;
}

/**
 * A background-QA app (REELS_BACKGROUND_QA=1) may run against a real profile; it starts the
 * scheduler only with a fake aside (REELS_ASIDE_BIN), so QA can never reach the real site.
 */
export function schedulerEnabled(env: NodeJS.ProcessEnv) {
  if (env.REELS_DEMO === "1") return false;
  return env.REELS_BACKGROUND_QA !== "1" || !!env.REELS_ASIDE_BIN;
}

const statusLabels: Partial<Record<RunStatus, string>> = {
  partial: "일부 완료",
  failed: "실패",
  blocked: "막힘",
  interrupted: "중단",
};

interface ActiveRun {
  scheduleId: string;
  timeoutMs: number;
  startedAt: number;
  handle?: ActionHandle;
  stopReason?: "timeout" | "app-quit";
  stopping?: Promise<void>;
  done?: Promise<void>;
}

/**
 * The built-in scheduler of the desktop main process: a 60 s tick (plus app start,
 * resume and unlock) compares the wall clock with the database. Shaped like
 * WorkflowNotifications: an unref'd interval, a re-entrance guard and dispose().
 */
export class Scheduler {
  readonly db: SchedulerDb;
  readonly file: ScheduleFileStore;
  private now: () => Date;
  private hostPid: number;
  private hostPidStarted?: string;
  private isAlive: (pid: number) => boolean;
  private processStart: (pid: number) => string | undefined;
  private active = new Map<string, ActiveRun>();
  private timer?: ReturnType<typeof setInterval>;
  private startTimer?: ReturnType<typeof setTimeout>;
  private ticking?: Promise<void>;
  private again = false;
  private disposed = false;
  private prunedDay?: string;

  constructor(private options: SchedulerOptions) {
    this.db = new SchedulerDb(options.root);
    this.file = new ScheduleFileStore(options.root);
    this.now = options.now ?? (() => new Date());
    this.hostPid = options.hostPid ?? process.pid;
    this.isAlive = options.isAlive ?? processAlive;
    this.processStart = options.processStart ?? processStartTime;
    this.hostPidStarted = options.hostPidStarted ?? this.processStart(this.hostPid);
  }

  start() {
    if (this.disposed || this.timer) return;
    this.startTimer = setTimeout(() => void this.tick(), this.options.startDelayMs ?? 10_000);
    this.startTimer.unref?.();
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  /** Immediate tick, e.g. after powerMonitor resume/unlock-screen. */
  wake() {
    return this.tick();
  }

  /** Runs one tick; a call during a tick schedules exactly one more. */
  tick(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.ticking) {
      this.again = true;
      return this.ticking;
    }
    this.ticking = (async () => {
      try {
        do {
          this.again = false;
          await this.tickOnce();
        } while (this.again && !this.disposed);
      } catch (error) {
        this.log(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.ticking = undefined;
      }
    })();
    return this.ticking;
  }

  /** Runs started by this instance that have not finished. */
  running() {
    return this.active.size;
  }

  /** Test seam: resolves when every run started by this instance has finished. */
  async idle() {
    while (this.active.size) await Promise.all([...this.active.values()].map((run) => run.done));
  }

  /** Stops runs of this instance (recorded as interrupted) and closes the database. */
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.startTimer) clearTimeout(this.startTimer);
    await this.ticking?.catch(() => {});
    for (const run of this.active.values()) {
      run.stopReason ??= "app-quit";
      if (run.handle) run.stopping ??= run.handle.stop().catch(() => {});
      await run.stopping;
    }
    await this.idle();
    this.db.close();
  }

  private log(message: string) {
    (this.options.log ?? ((text: string) => console.warn(`[scheduler] ${text}`)))(message);
  }
  private notify(notice: SchedulerNotice) {
    try {
      this.options.notify?.(notice);
    } catch (error) {
      this.log(`notify failed: ${String(error)}`);
    }
  }

  private async schedules() {
    try {
      return await this.file.read();
    } catch (error) {
      this.log(error instanceof Error ? error.message : String(error));
      return [];
    }
  }

  private async tickOnce() {
    const now = this.now();
    const schedules = await this.schedules();
    const byId = new Map(schedules.map((s) => [s.id, s]));
    await this.reclaim();
    this.checkTimeouts(now);
    for (const schedule of schedules) this.planSchedule(schedule, now);
    this.expire(now, byId);
    await this.dispatch(byId);
    const today = dayIn(now, "UTC");
    if (this.prunedDay !== today) {
      this.prunedDay = today;
      this.db.prune(now);
    }
  }

  private planSchedule(schedule: Schedule, now: Date) {
    this.db.plan(
      schedule.id,
      (cursor) => {
        // A paused schedule keeps its cursor at now: resuming never replays the paused days.
        if (!schedule.enabled) return { cursor: { lastCheckedAt: now, definitionHash: definitionHash(schedule.trigger) }, missed: [] };
        const due = dueOccurrences(schedule, cursor, now);
        return {
          cursor: due.cursor,
          run: due.run && { key: occurrenceKey(due.run.at), trigger: due.run.trigger, at: due.run.at, deadline: deadlineFor(due.run.at, schedule) },
          missed: due.missed.map((m) => ({ key: occurrenceKey(m.at), at: m.at, reason: m.reason })),
        };
      },
      now,
    );
  }

  /** pending past its deadline: blocked when its preflight kept failing, otherwise missed. */
  private expire(now: Date, byId: Map<string, Schedule>) {
    for (const row of this.db.byStatus("pending")) {
      if (Date.parse(row.deadline_at) > now.getTime()) continue;
      const blocked = !!row.preflight_failed_at;
      if (!this.db.closePending(row.run_id, blocked ? "blocked" : "missed", blocked ? (row.reason ?? "preflight") : "deadline", now)) continue;
      if (blocked) this.notifyRun(byId.get(row.schedule_id), "blocked", row.reason ?? "preflight");
    }
  }

  private async dispatch(byId: Map<string, Schedule>) {
    for (const row of this.db.byStatus("pending")) {
      if (this.disposed) return;
      const now = this.now();
      const schedule = byId.get(row.schedule_id);
      if (!schedule) {
        this.db.closePending(row.run_id, "skipped", "schedule-missing", now);
        continue;
      }
      if (!schedule.enabled && row.trigger !== "manual") {
        this.db.closePending(row.run_id, "skipped", "disabled", now);
        continue;
      }
      const retryMs = this.options.preflightRetryMs ?? 10 * 60_000;
      if (row.preflight_failed_at && now.getTime() - Date.parse(row.preflight_failed_at) < retryMs) continue;
      const claimOptions = {
        now,
        timezone: schedule.trigger.timezone,
        maxRunsPerDay: schedule.limits.maxRunsPerDay,
        hostPid: this.hostPid,
        hostPidStarted: this.hostPidStarted,
      };
      // Decided without a preflight: the claim records the skip atomically.
      if (this.db.runningFor(row.schedule_id) || this.db.startedToday(row.schedule_id, now, schedule.trigger.timezone) >= schedule.limits.maxRunsPerDay) {
        this.db.claim(row.run_id, claimOptions);
        continue;
      }
      if (row.lock_key && this.db.byStatus("running").some((r) => r.lock_key === row.lock_key)) continue;
      const failure = await this.options.runner.preflight(schedule).catch((error) => `preflight-error:${String(error).slice(0, 80)}`);
      if (failure) {
        if (this.db.preflightFailed(row.run_id, failure, now))
          this.notify({ title: `예약 대기: ${schedule.name}`, body: `실행 전 확인 실패(${failure}). 마감 전까지 10분마다 다시 확인해요.` });
        continue;
      }
      const claim = this.db.claim(row.run_id, { ...claimOptions, now: this.now() });
      if (claim.kind === "claimed") this.launch(row.run_id, schedule);
    }
  }

  private launch(runId: string, schedule: Schedule) {
    const run: ActiveRun = {
      scheduleId: schedule.id,
      timeoutMs: schedule.limits.timeoutMinutes * 60_000,
      startedAt: Date.parse(this.db.get(runId)?.started_at ?? this.now().toISOString()),
    };
    this.active.set(runId, run);
    run.done = (async () => {
      let outcome: ActionOutcome;
      try {
        const handle = await this.options.runner.start({
          schedule,
          run: this.db.get(runId)!,
          onSession: (id) => this.db.setSession(runId, id),
          log: (message) => this.log(`${runId}: ${message}`),
        });
        run.handle = handle;
        this.db.setProcess(runId, handle.pid, handle.pid ? this.processStart(handle.pid) : undefined);
        if (run.stopReason) run.stopping ??= handle.stop().catch(() => {});
        outcome = await handle.done;
        // The session stop after the process exits belongs to this run too.
        await run.stopping;
      } catch (error) {
        this.log(`${runId}: start failed: ${error instanceof Error ? error.message : String(error)}`);
        outcome = { status: "failed", reason: "spawn" };
      }
      if (run.stopReason)
        outcome = { ...outcome, status: run.stopReason === "timeout" ? "failed" : "interrupted", reason: run.stopReason === "timeout" ? "timeout" : "app-quit" };
      try {
        this.db.finish(runId, outcome, this.now());
      } catch (error) {
        this.log(`${runId}: finish failed: ${String(error)}`);
      }
      if (outcome.pause) await this.pause(schedule, outcome.pause);
      if (outcome.status !== "ok") this.notifyRun(schedule, outcome.status, outcome.reason, outcome.counts);
    })().finally(() => this.active.delete(runId));
  }

  /** Timeout is checked on every tick, so it also fires right after a wake from sleep. */
  private checkTimeouts(now: Date) {
    for (const run of this.active.values()) {
      if (run.stopReason || now.getTime() - run.startedAt < run.timeoutMs) continue;
      run.stopReason = "timeout";
      if (run.handle) run.stopping = run.handle.stop().catch((error) => this.log(`stop failed: ${String(error)}`));
    }
  }

  /**
   * running rows this instance does not own. A live host (same pid and start time) is another
   * app instance sharing the profile and is never touched. A gone host leaves an orphan:
   * its child is stopped when it is still the same process, and the run becomes interrupted.
   */
  private async reclaim() {
    for (const row of this.db.byStatus("running")) {
      if (this.active.has(row.run_id)) continue;
      const mine = row.host_pid === this.hostPid && row.host_pid_started === (this.hostPidStarted ?? null);
      if (!mine && row.host_pid && this.isAlive(row.host_pid)) {
        const started = this.processStart(row.host_pid);
        if (!row.host_pid_started || !started || started === row.host_pid_started) continue;
      }
      let reason = "host-exited";
      if (row.pid && this.isAlive(row.pid)) {
        if (row.pid_started && this.processStart(row.pid) === row.pid_started) {
          await this.options.runner.stopOrphan(row.pid, row.session_id).catch(() => {});
          reason = "orphan-stopped";
        } else reason = "pid-reused";
      } else if (row.session_id) await this.options.runner.stopSession(row.session_id).catch(() => {});
      if (this.db.finish(row.run_id, { status: "interrupted", reason }, this.now()))
        this.notifyRun(undefined, "interrupted", reason, undefined, row.schedule_id);
    }
  }

  private async pause(schedule: Schedule, code: string) {
    const stamp = this.now().toISOString();
    await this.file
      .update((list) => ({
        schedules: list.map((s) => (s.id === schedule.id ? { ...s, enabled: false, pausedReason: `blocked:${code} ${stamp}`, updatedAt: stamp } : s)),
        result: undefined,
      }))
      .then(
        () => this.notify({ title: `예약 일시정지: ${schedule.name}`, body: `계정 확인이 필요해요(${code}). 해결한 뒤 예약을 다시 켜 주세요.` }),
        (error) => this.log(`pause failed: ${String(error)}`),
      );
  }

  /** Name, verdict, reason code and counts only: never blog ids, post URLs or comment text. */
  private notifyRun(schedule: Schedule | undefined, status: RunStatus, reason?: string, counts?: ActionOutcome["counts"], scheduleId?: string) {
    const label = statusLabels[status];
    if (!label) return;
    const tally = counts ? ` · 수락 ${counts.accepted} · 방문 ${counts.visited} · 댓글 ${counts.commented} · 공감 ${counts.liked}` : "";
    this.notify({ title: `예약 ${label}: ${schedule?.name ?? scheduleId ?? "?"}`, body: `사유: ${reason ?? "-"}${tally}` });
  }

  // ---- Tool surface (reels_get_schedules, reels_set_schedule, reels_run_schedule_now, reels_get_schedule_runs)

  async getSchedules(input: unknown) {
    const { id } = getSchedulesInput.parse(input ?? {});
    const now = this.now();
    const schedules = (await this.file.read()).filter((s) => !id || s.id === id);
    if (id && !schedules.length) throw new Error("SCHEDULE_NOT_FOUND: 예약을 찾지 못했어요.");
    return {
      file: this.file.path,
      fileError: this.file.lastError ?? null,
      now: now.toISOString(),
      schedules: schedules.map((schedule) => {
        const cursor = this.db.cursor(schedule.id);
        const [last] = this.db.list({ scheduleId: schedule.id, limit: 1 }).filter((r) => r.status !== "pending" && r.status !== "running");
        const active = [...this.db.byStatus("pending"), ...this.db.byStatus("running")].filter((r) => r.schedule_id === schedule.id);
        return {
          ...schedule,
          nextRunAt: schedule.enabled ? (nextRunAt(schedule.trigger, now)?.toISOString() ?? null) : null,
          cursor: cursor ? { lastCheckedAt: cursor.lastCheckedAt.toISOString() } : null,
          startedToday: this.db.startedToday(schedule.id, now, schedule.trigger.timezone),
          lastRun: last ? this.view(last) : null,
          activeRuns: active.map((r) => this.view(r)),
        };
      }),
    };
  }

  async setSchedule(input: unknown) {
    const parsed = setScheduleInput.parse(input);
    const schedule = await this.file.update((list) => {
      const index = list.findIndex((s) => s.id === parsed.id);
      const next = mergeSchedule(index < 0 ? undefined : list[index], parsed, this.now());
      const copy = [...list];
      if (index < 0) copy.push(next);
      else copy[index] = next;
      return { schedules: copy, result: next };
    });
    void this.tick();
    return { schedule, nextRunAt: schedule.enabled ? (nextRunAt(schedule.trigger, this.now())?.toISOString() ?? null) : null };
  }

  async runNow(input: unknown) {
    const { id } = runScheduleNowInput.parse(input);
    const schedule = (await this.file.read()).find((s) => s.id === id);
    if (!schedule) throw new Error("SCHEDULE_NOT_FOUND: 예약을 찾지 못했어요.");
    const now = this.now();
    if (this.db.runningFor(id)) throw new Error("ALREADY_RUNNING: 이 예약은 이미 실행 중이에요.");
    if (this.db.startedToday(id, now, schedule.trigger.timezone) >= schedule.limits.maxRunsPerDay)
      throw new Error("DAILY_LIMIT: 오늘 이미 실행한 예약이에요. 내일 다시 실행돼요.");
    const runId = this.db.insertManual(id, now, new Date(now.getTime() + MANUAL_DEADLINE_MS));
    void this.tick();
    return { runId, status: "pending", note: "Poll reels_get_schedule_runs for the verdict; a run can take up to timeoutMinutes." };
  }

  async runs(input: unknown) {
    const parsed = getScheduleRunsInput.parse(input ?? {});
    return { runs: this.db.list({ scheduleId: parsed.id, status: parsed.status, limit: parsed.limit }).map((r) => this.view(r)) };
  }

  private view(row: RunRow) {
    let result: unknown = null;
    try {
      result = row.result_json ? JSON.parse(row.result_json) : null;
    } catch {
      result = null;
    }
    return {
      runId: row.run_id,
      scheduleId: row.schedule_id,
      trigger: row.trigger,
      status: row.status,
      reason: row.reason,
      scheduledAt: row.scheduled_at,
      deadlineAt: row.deadline_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      sessionId: row.session_id,
      exitCode: row.exit_code,
      signal: row.signal,
      result,
      logDir: row.started_at ? runDir(this.options.root, row.run_id) : null,
    };
  }
}
