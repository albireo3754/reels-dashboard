import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  admission, afterOffWork, buildQueue, findItem, freshnessOf, inActiveHours, inFlight, interpretRun, maxAutoSlots, pickToday,
  planManual, planTick, reclaim, renderToday, runnerAlive, selectCandidates,
  type AutopilotConfig, type AutopilotState, type Queue, type QueueItem, type Reservation, type RunOutput, type TickResult,
} from "../../shared/autopilot";
import type { Project } from "../../shared/contracts";
import { errorMessage } from "../../shared/lib/errors";
import { AutopilotStore, processAlive, processStartTime } from "../../shared/lib/autopilot-store";
import {
  addLinearKey, defaultSecurityRunner, keychainAccount, keychainService, linearFailureHint, refreshLinear, removeLinearKey,
  type FetchLike, type LinearDeps, type LinearFailure, type LinearRefresh, type SecurityRunner,
} from "../../shared/lib/linear-source";
import { PlanningStore } from "../../shared/lib/planning-store";
import { LocalStore } from "../../shared/lib/storage";
import { seoulDate, type Planning } from "../../shared/planning";
import { CliError, exitCodes, type ErrorDetails } from "./outcome";

export interface AutopilotContext {
  /** The profile folder that holds dashboard.json, planning.json and autopilot/. */
  root: string;
  env: NodeJS.ProcessEnv;
  /** The reels bundle this process runs; the executor is started from it. */
  script?: string;
  /** True when stdin and stdout are a terminal. `connect-linear` runs only then. */
  interactive?: boolean;
}
export interface ModelRun { command: string; args: string[]; input: string; cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv; }
/** Everything that touches the clock, processes or the model, so tests can replace it. */
export interface AutopilotDeps {
  now(): Date;
  isAlive(pid: number): boolean;
  /** Start time of a pid, recorded with the reservation so a reused pid is not taken for the executor. */
  processStart(pid: number): string | undefined;
  newId(): string;
  /** Starts the detached executor for one run and returns its pid. `token` is what the executor must present. */
  launch(run: { runId: string; logPath: string; token: string }): Promise<{ pid: number }>;
  /** The only place a model is called. */
  runModel(run: ModelRun): Promise<RunOutput>;
  /**
   * Optional hook a tick runs before it reads the Linear copy (a cheap, model-free refresh of the
   * planning snapshot). A failure ends the tick with zero automatic runs and its reason in `lastTick`.
   */
  refreshPlanning?(input: { now: Date; staleAfterMinutes: number }): Promise<PlanningRefresh>;
  /**
   * The Linear API key store (macOS Keychain through `security`) and `fetch`. When present, a tick refreshes
   * the Linear copy itself before its gate (see {@link linearRefreshHook}). Tests replace both; nothing else
   * in this module reads the Keychain or the network.
   */
  linear?: { runner: SecurityRunner; fetch: FetchLike };
}
export type PlanningRefresh = { ok: true; refreshed: boolean; summary?: Record<string, unknown> } | { ok: false; reason: string; detail?: string };
export type CommandScope = { readOnly?: boolean; inFlight?: ErrorDetails };
export type CommandResult = { data: unknown };

const automatedEnv = "REELS_AUTOPILOT_AUTOMATED";
/** The executor proves it is the one a tick or manual run started with this value; it is an id, not a credential. */
export const runTokenEnv = "REELS_AUTOPILOT_RUN_TOKEN";
const descriptionLimit = 8000;
/** The Workflow args travel inside the outer prompt. Past this size, long descriptions go to run files the workers Read. */
const argsInlineLimit = 12_000;
const descriptionInlineLimit = 1500;
const lockWaitMs = 30_000;

export function defaultDeps(ctx: AutopilotContext): AutopilotDeps {
  return {
    now: () => new Date(),
    linear: { runner: defaultSecurityRunner, fetch: fetch as FetchLike },
    isAlive: processAlive,
    processStart: processStartTime,
    newId: randomUUID,
    async launch({ runId, logPath, token }) {
      if (!ctx.script) throw new Error("The CLI bundle path is unknown, so the executor cannot start.");
      const log = openSync(logPath, "a", 0o600);
      try {
        const child = spawn(process.execPath, [ctx.script, "autopilot", "execute", "--run", runId], {
          detached: true, stdio: ["ignore", log, log], env: { ...ctx.env, [automatedEnv]: "1", [runTokenEnv]: token },
        });
        await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
        child.unref();
        if (!child.pid) throw new Error("The executor has no pid.");
        return { pid: child.pid };
      } finally { closeSync(log); }
    },
    runModel: ({ command, args, input, cwd, timeoutMs, env }) => new Promise<RunOutput>(resolve => {
      const limit = 5 * 1024 * 1024;
      let stdout = "", stderr = "", timedOut = false, settled = false;
      const finish = (output: RunOutput) => { if (!settled) { settled = true; clearTimeout(timer); resolve(output); } };
      const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
      child.stdout.on("data", chunk => { if (stdout.length < limit) stdout += chunk; });
      child.stderr.on("data", chunk => { if (stderr.length < limit) stderr += chunk; });
      child.once("error", error => finish({ code: null, stdout, stderr, error: errorMessage(error) }));
      child.once("close", code => finish({ code, stdout, stderr, ...(timedOut ? { timedOut } : {}) }));
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }),
  };
}

const storeOf = (ctx: AutopilotContext, deps: AutopilotDeps, now: () => Date = deps.now) =>
  new AutopilotStore(ctx.root, { now, isAlive: deps.isAlive, processStart: deps.processStart });
const probeOf = (deps: AutopilotDeps) => ({ isAlive: deps.isAlive, startedAt: deps.processStart });

async function loadSources(root: string): Promise<{ planning: Planning; projects: Project[] }> {
  try {
    const [planning, dashboard] = await Promise.all([new PlanningStore(root).get(), new LocalStore(root).load()]);
    return { planning, projects: dashboard.projects };
  } catch (error) {
    throw new CliError("STORE_UNREADABLE", `Linear 또는 Dashboard 상태를 읽지 못했어요: ${errorMessage(error)}`, { retry: "no" });
  }
}

const summary = (queue: Queue) => ({
  review: queue.review.length, active: queue.active.length, candidates: queue.candidates.length, occupancy: queue.occupancy,
});
const itemView = (item: QueueItem) => ({
  key: item.key, kind: item.kind, title: item.title, ...(item.url ? { url: item.url } : {}),
  ...(item.identifier ? { identifier: item.identifier } : {}), ...(item.projectId ? { projectId: item.projectId } : {}),
  ...(item.stateName ? { stateName: item.stateName } : {}),
  dueDate: item.dueDate ?? null, score: item.score, reasons: item.reasons,
});
const reservationView = (r: Reservation, now: Date, deps: AutopilotDeps) => ({
  id: r.id, key: r.key, mode: r.mode, status: r.status, ...(r.runId ? { runId: r.runId } : {}),
  ...(r.pid ? { pid: r.pid } : {}), leaseUntil: r.leaseUntil, createdAt: r.createdAt,
  ...(r.startDeadline ? { startDeadline: r.startDeadline } : {}),
  ...(r.finishedAt ? { finishedAt: r.finishedAt } : {}), ...(r.reason ? { reason: r.reason } : {}),
  ...(r.reportPath ? { reportPath: r.reportPath } : {}), ...(r.outcome ? { outcome: r.outcome } : {}),
  ...(r.changes?.length ? { changes: r.changes } : {}),
  ...(inFlight(r) ? { runnerAlive: runnerAlive(r, probeOf(deps)), leaseExpired: Date.parse(r.leaseUntil) <= now.getTime() } : {}),
});

/** `reels autopilot status`: read-only. Reclaim is previewed in memory, never written. */
export async function status(ctx: AutopilotContext, deps: AutopilotDeps): Promise<unknown> {
  const now = deps.now();
  const store = storeOf(ctx, deps);
  const config = await store.readConfig().catch(error => { throw new CliError("STORE_UNREADABLE", `autopilot 설정을 읽지 못했어요: ${errorMessage(error)}`, { retry: "no" }); });
  const state = await store.readState().catch(error => { throw new CliError("STORE_UNREADABLE", `autopilot 상태를 읽지 못했어요: ${errorMessage(error)}`, { retry: "no" }); });
  const { planning, projects } = await loadSources(ctx.root);
  const preview = reclaim(state, now, probeOf(deps));
  const queue = buildQueue({ planning, projects, ledger: preview.state.reservations, now, config });
  const running = preview.state.reservations.filter(inFlight).length;
  const lock = await store.peekLock();
  const limit = Math.min(config.maxSlots, maxAutoSlots);
  const { eligible, skipped } = selectCandidates(queue, preview.state.reservations);
  return {
    enabled: config.enabled, paused: state.paused, lastTick: state.lastTick,
    config: { intervalMinutes: config.intervalMinutes, activeHours: config.activeHours, offWorkAt: config.offWorkAt, maxSlots: limit, staleAfterMinutes: config.staleAfterMinutes },
    freshness: queue.freshness,
    occupancy: queue.occupancy,
    autoSlots: queue.freshness.ok ? admission({ occupancy: queue.occupancy, runningReservations: running, mode: "auto", maxSlots: limit, candidates: eligible.length }) : 0,
    runningReservations: running,
    ...(preview.leaseExpiredAlive.length ? { leaseExpiredAlive: preview.leaseExpiredAlive } : {}),
    ...(lock ? { lock: { pid: lock.pid, alive: lock.alive, ageSeconds: lock.ageMs === null ? null : Math.round(lock.ageMs / 1000) } } : {}),
    reservations: state.reservations.filter(r => r.status !== "done").map(r => reservationView(r, now, deps)),
    queue: { review: queue.review.map(itemView), active: queue.active.map(itemView), candidates: queue.candidates.map(itemView), skippedCandidates: skipped },
    order: { previous: state.previousOrder?.items.map(({ key, score }) => ({ key, score })) ?? null, current: state.order?.items.map(({ key, score }) => ({ key, score })) ?? null },
    today: pickToday(queue),
  };
}

export interface TickOptions { dryRun: boolean; now?: Date; }

/** `reels autopilot tick`: the automatic path. Cheap checks first; the model is only reached by `launch`. */
export async function tick(ctx: AutopilotContext, options: TickOptions, deps: AutopilotDeps): Promise<Record<string, unknown>> {
  const now = options.now ?? deps.now();
  const clock = () => now;
  const store = storeOf(ctx, deps, clock);
  const { dryRun } = options;
  let refreshInfo: Record<string, unknown> | undefined;
  const out = (result: TickResult, reason: string, extra: Record<string, unknown> = {}) => ({
    result, reason, dryRun, modelCalls: 0, admitted: 0, admittedKeys: [] as string[], ...(refreshInfo ? { refresh: refreshInfo } : {}), ...extra,
  });
  // Best effort and only for real ticks: the reason is kept so `status` can show why nothing ran.
  const record = async (result: TickResult, reason: string) => {
    if (dryRun) return;
    await store.withLock(async () => {
      const state = await store.readState();
      await store.writeState({ ...state, lastTick: { at: now.toISOString(), ...(state.lastTick?.fingerprint ? { fingerprint: state.lastTick.fingerprint } : {}), result, reason } });
    }).catch(() => {});
  };
  const skip = async (result: TickResult, reason: string, extra: Record<string, unknown> = {}) => {
    await record(result, reason);
    return out(result, reason, extra);
  };
  let config: AutopilotConfig;
  try { config = await store.readConfig(); } catch (error) {
    return out("state_unreadable", `autopilot 설정을 읽지 못했어요: ${errorMessage(error)}`);
  }
  let state: AutopilotState;
  try { state = await store.readState(); } catch (error) {
    return out("state_unreadable", `autopilot 상태를 읽지 못했어요: ${errorMessage(error)}`);
  }
  const gate: [TickResult, string] | null = !config.enabled ? ["disabled", "config.enabled가 false예요."]
    : state.paused ? ["paused", `일시정지 중: ${state.paused.reason} (reels autopilot resume으로 재개)`]
    : !inActiveHours(config, now) ? ["outside_hours", `활성 시간(${config.activeHours.from}~${config.activeHours.to} KST) 밖이에요.`]
    : null;
  let today: Record<string, unknown> | undefined;
  const refreshToday = !dryRun && afterOffWork(config, now) && state.todayDate !== seoulDate(now);
  // Runs outside the lock: a slow network call must not hold it. The planning store's revision check guards its write.
  const refreshHook = deps.refreshPlanning ?? (deps.linear ? linearRefreshHook(ctx, deps) : undefined);
  // Linear reads use no model: keep the copy current overnight while dispatch stays inside activeHours.
  // An explicit disable/pause still stops the automatic tick, including its refresh.
  if ((!gate || gate[0] === "outside_hours") && !dryRun && refreshHook) {
    const refreshed = await refreshHook({ now, staleAfterMinutes: config.staleAfterMinutes })
      .catch((error): PlanningRefresh => ({ ok: false, reason: "refresh_error", detail: errorMessage(error) }));
    if (!refreshed.ok)
      return skip("freshness", `Linear 갱신에 실패해 자동 실행을 시작하지 않았어요: ${refreshed.reason}${refreshed.detail ? ` (${refreshed.detail})` : ""}`, { refresh: refreshed });
    if (refreshed.refreshed) refreshInfo = { refreshed: true, ...refreshed.summary };
  }
  // Once the model-free refresh is done, gated ticks only read the queue when today.md is due.
  if (gate && !dryRun && !refreshToday) return skip(gate[0], gate[1]);
  let sources: { planning: Planning; projects: Project[] };
  try { sources = await loadSources(ctx.root); } catch (error) {
    return gate && !dryRun ? skip(gate[0], gate[1]) : skip("state_unreadable", errorMessage(error));
  }
  if (refreshToday) {
    // After the off-work time, the first tick refreshes today.md; reading only, no model.
    const written = await store.withLock(async () => {
      const queue = buildQueue({ ...sources, ledger: (await store.readState()).reservations, now, config });
      const pick = pickToday(queue);
      await store.writeToday(renderToday(seoulDate(now), pick, queue));
      await store.writeState({ ...(await store.readState()), todayDate: seoulDate(now) });
      return pick;
    }).catch(() => undefined);
    if (written && !written.busy) today = { refreshed: true, path: store.todayPath };
  }
  if (gate && !dryRun) return skip(gate[0], gate[1], today ? { today } : {});
  const freshness = freshnessOf(sources.planning, now, config);
  const preview = () => {
    const queue = buildQueue({ ...sources, ledger: reclaim(state, now, probeOf(deps)).state.reservations, now, config });
    return { queue: summary(queue), today: pickToday(queue) };
  };
  if (!freshness.ok)
    return skip("freshness", freshness.detail, { freshness, ...(dryRun ? { ...preview(), ...(gate ? { gate: gate[0] } : {}) } : {}) });

  const plan = (current: AutopilotState, from = sources) => planTick({ state: current, ...from, config, now, probe: probeOf(deps), newId: deps.newId });
  const report = (p: ReturnType<typeof plan>, extra: Record<string, unknown> = {}) => ({
    freshness, occupancy: p.queue.occupancy, autoSlots: p.autoSlots, queue: summary(p.queue), today: pickToday(p.queue),
    ...(p.skipped.length ? { skippedCandidates: p.skipped } : {}), ...(p.reclaimed.length ? { reclaimed: p.reclaimed.length } : {}),
    ...(p.leaseExpiredAlive.length ? { leaseExpiredAlive: p.leaseExpiredAlive } : {}),
    order: { previous: p.state.previousOrder?.items.map(({ key, score }) => ({ key, score })) ?? null, current: p.state.order?.items.map(({ key, score }) => ({ key, score })) ?? null },
    ...extra,
  });

  if (dryRun) {
    const p = plan(state);
    const wouldAdmit = gate ? 0 : p.admitted.length;
    // A dry run reserves nothing, so it never says it did.
    const reason = gate ? gate[1] : p.result === "admitted" ? `예약할 수 있어요 ${wouldAdmit}개. (dry-run이라 예약하지 않았어요.)` : p.reason;
    return out(gate ? gate[0] : p.result, reason, {
      ...report(p), wouldAdmit, wouldAdmitKeys: gate ? [] : p.admitted.map(r => r.key), ...(gate ? { gate: gate[0] } : {}),
    });
  }

  // Only a tick that is about to reserve asks the API again. A full queue or unchanged input ends without a call.
  let recheck: Recheck | undefined;
  let fresh: { planning: Planning; projects: Project[] } | undefined;
  if (deps.linear && plan(state).result === "admitted") {
    const strict = await strictRecheck(ctx, deps, config);
    if (strict && !strict.result.ok)
      return skip("freshness", `예약 직전 Linear 재확인에 실패해 자동 실행을 시작하지 않았어요: ${strict.result.reason}${strict.result.detail ? ` (${strict.result.detail})` : ""}`, { recheck: strict.result });
    recheck = strict?.result;
    fresh = strict?.sources;
  }
  const locked = await store.withLock(async () => {
    const p = plan(await store.readState(), fresh ?? sources);
    let finalState = p.state;
    let result: TickResult = p.result;
    let reason = p.reason;
    if (p.admitted.length) {
      const started = await startExecutor(store, deps, p.state, { runId: p.runId!, token: p.admitted[0].token }, now);
      finalState = started.state;
      if (started.failure) {
        result = "spawn_failed";
        reason = `실행기를 시작하지 못했어요: ${started.failure}`;
      }
    } else await store.writeState(finalState);
    const launched = result === "admitted";
    return out(result, reason, report(p, {
      ...(recheck ? { recheck } : {}),
      admitted: launched ? p.admitted.length : 0, admittedKeys: launched ? p.admitted.map(r => r.key) : [],
      modelCalls: launched ? p.admitted.length : 0, ...(launched ? { runId: p.runId } : {}),
    }));
  });
  if (locked.busy) {
    const held = locked.held;
    // Not written to lastTick: only a lock holder may write state, and this tick does not hold it.
    return out("busy", held
      ? `lock_held_alive: pid ${held.pid}가 ${held.ageMs === null ? "알 수 없는 시간" : `${Math.round(held.ageMs / 1000)}초`} 동안 잠금을 쥐고 있어요. 살아 있는 소유자의 잠금은 시간이 지나도 회수하지 않아요.`
      : "다른 tick 또는 실행이 상태를 쓰고 있어서 아무것도 하지 않았어요.",
      held ? { lockHeld: { pid: held.pid, ageSeconds: held.ageMs === null ? null : Math.round(held.ageMs / 1000) } } : {});
  }
  return locked.value;
}

/**
 * Reservations are saved as `starting` first, so a slot is held while the executor is being spawned. Only
 * after the spawn succeeded are they `running` with a pid and its start time; a failed spawn is `failed`.
 */
async function startExecutor(
  store: AutopilotStore, deps: AutopilotDeps, state: AutopilotState, run: { runId: string; token: string }, now: Date,
): Promise<{ state: AutopilotState; pid?: number; failure?: string }> {
  await store.writeState(state);
  const mine = (r: Reservation) => r.runId === run.runId && r.status === "starting";
  try {
    const dir = store.runDir(run.runId);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const { pid } = await deps.launch({ runId: run.runId, logPath: path.join(dir, "execute.log"), token: run.token });
    const startedAt = deps.processStart(pid);
    const next: AutopilotState = { ...state, reservations: state.reservations.map(r => (mine(r)
      ? { ...r, status: "running" as const, pid, ...(startedAt ? { processStartedAt: startedAt } : {}) } : r)) };
    await store.writeState(next);
    return { state: next, pid };
  } catch (error) {
    const next: AutopilotState = { ...state, reservations: state.reservations.map(r => (mine(r)
      ? { ...r, status: "failed" as const, finishedAt: now.toISOString(), reason: `spawn_failed: ${errorMessage(error).slice(0, 200)}` } : r)) };
    await store.writeState(next);
    return { state: next, failure: errorMessage(error) };
  }
}

const linearDepsOf = (deps: AutopilotDeps): LinearDeps => {
  if (!deps.linear) throw new CliError("INTERNAL", "Linear 연결 도구가 준비되지 않았어요.", { retry: "no" });
  return { runner: deps.linear.runner, fetch: deps.linear.fetch, now: deps.now };
};
const readLinearSettings = async (ctx: AutopilotContext, deps: AutopilotDeps) =>
  (await storeOf(ctx, deps).readConfig().catch(error => { throw new CliError("STORE_UNREADABLE", `autopilot 설정을 읽지 못했어요: ${errorMessage(error)}`, { retry: "no" }); })).linear;

export type Recheck =
  | { ok: true; issues: number; syncedAt: string }
  | { ok: false; reason: string; detail?: string };
/**
 * The strict check right before work is reserved or a model starts. It always asks the Linear API (model-free),
 * saves the result like any refresh and returns sources whose `linear` is what the API said just now, with the
 * Dashboard re-read from disk. A failed, incomplete or unauthenticated read is a failure: without a fresh read
 * there is no honest occupancy, and a connector-synced copy alone never allows an automatic start. Returns
 * undefined only when no Linear tools were injected (tests); the default dependencies always have them.
 */
async function strictRecheck(ctx: AutopilotContext, deps: AutopilotDeps, config: AutopilotConfig): Promise<{ result: Recheck; sources?: { planning: Planning; projects: Project[] } } | undefined> {
  if (!deps.linear) return undefined;
  const fetched = await refreshLinear(ctx.root, config.linear, linearDepsOf(deps), { dryRun: false })
    .catch((error): LinearRefresh => ({ ok: false, reason: "linear_incomplete", detail: errorMessage(error).slice(0, 200) }));
  if (!fetched.ok)
    return { result: { ok: false, reason: fetched.reason, detail: [fetched.detail, linearFailureHint[fetched.reason]].filter(Boolean).join(" — ") } };
  let loaded: { planning: Planning; projects: Project[] };
  try { loaded = await loadSources(ctx.root); } catch (error) { return { result: { ok: false, reason: "state_unreadable", detail: errorMessage(error) } }; }
  return {
    result: { ok: true, issues: fetched.summary.issues, syncedAt: fetched.summary.syncedAt },
    sources: { planning: { ...loaded.planning, linear: fetched.linear }, projects: loaded.projects },
  };
}

/**
 * The tick's model-free refresh. It reads the Linear copy's age and only goes to the API once the copy is
 * at least half of `staleAfterMinutes` old, so a cheap tick does not call Linear every time. It runs outside
 * the state lock; the planning write is guarded by its revision check. Without a Keychain key it fails with
 * `linear_auth_missing`: a copy that a Claude connector session synced by hand is still used while it is
 * fresh, but it cannot be renewed automatically.
 */
export function linearRefreshHook(ctx: AutopilotContext, deps: AutopilotDeps): NonNullable<AutopilotDeps["refreshPlanning"]> {
  return async ({ now, staleAfterMinutes }) => {
    const planning = await new PlanningStore(ctx.root).get();
    const syncedAt = planning.linear ? Date.parse(planning.linear.syncedAt) : Number.NEGATIVE_INFINITY;
    if (now.getTime() - syncedAt < (staleAfterMinutes * 60_000) / 2) return { ok: true, refreshed: false };
    const result = await refreshLinear(ctx.root, await readLinearSettings(ctx, deps), linearDepsOf(deps), { dryRun: false });
    if (!result.ok) return { ok: false, reason: result.reason, detail: [result.detail, linearFailureHint[result.reason]].filter(Boolean).join(" — ") };
    return { ok: true, refreshed: result.saved, summary: { ...result.summary } };
  };
}

const linearError = (failure: Extract<LinearRefresh, { ok: false }>, stored = false) => new CliError(
  failure.reason.toUpperCase(),
  `${stored ? "키는 저장했지만 확인에 실패했어요. " : ""}${failure.reason}${failure.detail ? ` (${failure.detail})` : ""}`,
  { hint: linearFailureHint[failure.reason as LinearFailure], exitCode: exitCodes.toolError, retry: failure.reason === "linear_rate_limited" ? "wait" : "no", writeOutcome: "not_applied" },
);

/** `reels autopilot refresh-linear [--dry-run]`: counts and states only, never titles or the key. */
export async function refreshLinearCommand(ctx: AutopilotContext, options: { dryRun: boolean }, deps: AutopilotDeps): Promise<unknown> {
  const result = await refreshLinear(ctx.root, await readLinearSettings(ctx, deps), linearDepsOf(deps), options);
  if (!result.ok) throw linearError(result);
  return { dryRun: options.dryRun, saved: result.saved, ...result.summary, ...(result.note ? { note: result.note } : {}) };
}

const connectSteps = [
  "터미널(TTY)에서 `reels autopilot connect-linear`를 직접 실행하세요. macOS가 키 입력을 직접 받아요(입력은 화면에 보이지 않아요).",
  "키는 Linear Settings > Account > Security & access의 personal API key(읽기 전용 권한)예요. 채팅·명령줄 인자에 붙여 넣지 마세요.",
];
/**
 * `reels autopilot connect-linear`: terminal only. Runs `security add-generic-password -U -s <service> -a <account> -w`
 * with `-w` as the last argument and no value, attached to the terminal, so macOS asks for the secret itself.
 * Afterwards a dry-run refresh confirms the key and prints only the issue and state counts.
 */
export async function connectLinear(ctx: AutopilotContext, deps: AutopilotDeps): Promise<unknown> {
  const linear = linearDepsOf(deps);
  if (!ctx.interactive)
    throw new CliError("USAGE", "connect-linear는 대화형 터미널에서만 실행해요. 이 환경에서는 키 입력을 받지 않고 아무것도 저장하지 않았어요.", { hint: connectSteps.join(" "), retry: "no" });
  const added = await addLinearKey(linear.runner);
  if (added.code !== 0)
    throw new CliError("LINEAR_KEYCHAIN_FAILED", `security add-generic-password가 exit ${added.code ?? "none"}로 끝나 키를 저장하지 못했어요.`, { retry: "no", writeOutcome: "not_applied", exitCode: exitCodes.toolError });
  const check = await refreshLinear(ctx.root, await readLinearSettings(ctx, deps), linear, { dryRun: true });
  if (!check.ok) throw linearError(check, true);
  return { connected: true, service: keychainService, account: keychainAccount, verified: true, issues: check.summary.issues, byState: check.summary.byState, next: ["reels autopilot refresh-linear --dry-run"] };
}

/** `reels autopilot disconnect-linear`: deletes only this tool's Keychain item. */
export async function disconnectLinear(deps: AutopilotDeps): Promise<unknown> {
  const { runner } = linearDepsOf(deps);
  const { removed, code } = await removeLinearKey(runner);
  if (removed) return { disconnected: true, service: keychainService, account: keychainAccount };
  if (code === 44) return { disconnected: false, reason: "not_found", service: keychainService, account: keychainAccount };
  throw new CliError("LINEAR_KEYCHAIN_FAILED", `security delete-generic-password가 exit ${code ?? "none"}로 끝났어요.`, { retry: "no", writeOutcome: "unknown", exitCode: exitCodes.toolError });
}

/** `reels autopilot run --manual <key>...`: no slot limit, only the items named. */
export async function runManual(ctx: AutopilotContext, refs: string[], deps: AutopilotDeps): Promise<unknown> {
  if (ctx.env[automatedEnv] === "1")
    throw new CliError("USAGE", `${automatedEnv}=1인 자동 경로는 수동 실행으로 시작할 수 없어요.`, { retry: "no" });
  if (!refs.length) throw new CliError("USAGE", "--manual에는 항목 key가 하나 이상 필요해요.");
  const now = deps.now();
  const store = storeOf(ctx, deps);
  const config = await store.readConfig().catch(error => { throw new CliError("STORE_UNREADABLE", `autopilot 설정을 읽지 못했어요: ${errorMessage(error)}`, { retry: "no" }); });
  const sources = await loadSources(ctx.root);
  const locked = await store.withLock(async () => {
    const state = await store.readState();
    const queue = buildQueue({ ...sources, ledger: reclaim(state, now, probeOf(deps)).state.reservations, now, config });
    const plan = planManual({ state, queue, refs, config, now, probe: probeOf(deps), newId: deps.newId });
    // One executor per run of at most three items (the registered Workflow's limit); each run has its own id and token.
    const started: { runId: string; keys: string[]; pid?: number; failure?: string }[] = [];
    let current = plan.state;
    for (const run of plan.runs) {
      const result = await startExecutor(store, deps, current, { runId: run.runId, token: run.token }, now);
      current = result.state;
      started.push({ runId: run.runId, keys: run.reservations.map(r => r.key), ...(result.pid ? { pid: result.pid } : {}), ...(result.failure ? { failure: result.failure } : {}) });
    }
    return { plan, started };
  }, 10_000);
  if (locked.busy) throw new CliError("AUTOPILOT_BUSY", "다른 tick 또는 실행이 상태를 쓰고 있어요. 잠시 뒤 다시 실행하세요.");
  const { plan, started } = locked.value;
  if (!plan.admitted.length)
    throw new CliError("INVALID_INPUT", `시작할 항목이 없어요: ${plan.rejected.map(r => `${r.ref} (${r.reason})`).join(", ")}`, { next: ["reels autopilot status"] });
  const launched = started.filter(run => !run.failure);
  if (!launched.length) throw new CliError("INTERNAL", `실행기를 시작하지 못했어요: ${started[0].failure}`, { retry: "no", writeOutcome: "not_applied" });
  const failedKeys = started.filter(run => run.failure).flatMap(run => run.keys);
  return {
    mode: "manual", runId: launched[0].runId, pid: launched[0].pid, modelCalls: launched.reduce((sum, run) => sum + run.keys.length, 0),
    admitted: plan.admitted.filter(r => !failedKeys.includes(r.key)).map(r => ({ id: r.id, key: r.key })), rejected: plan.rejected,
    runs: started.map(run => ({ runId: run.runId, keys: run.keys, ...(run.pid ? { pid: run.pid } : {}), ...(run.failure ? { failure: run.failure } : {}) })),
    ...(freshnessOf(sources.planning, now, config).ok ? {} : { freshness: freshnessOf(sources.planning, now, config) }),
  };
}

/** `reels autopilot today`: the one item for after work, also written to today.md. */
export async function today(ctx: AutopilotContext, deps: AutopilotDeps): Promise<unknown> {
  const now = deps.now();
  const store = storeOf(ctx, deps);
  const config = await store.readConfig().catch(error => { throw new CliError("STORE_UNREADABLE", `autopilot 설정을 읽지 못했어요: ${errorMessage(error)}`, { retry: "no" }); });
  const state = await store.readState().catch(error => { throw new CliError("STORE_UNREADABLE", `autopilot 상태를 읽지 못했어요: ${errorMessage(error)}`, { retry: "no" }); });
  const sources = await loadSources(ctx.root);
  const queue = buildQueue({ ...sources, ledger: reclaim(state, now, probeOf(deps)).state.reservations, now, config });
  const pick = pickToday(queue);
  const text = renderToday(seoulDate(now), pick, queue);
  const locked = await store.withLock(() => store.writeToday(text), 10_000);
  if (locked.busy) throw new CliError("AUTOPILOT_BUSY", "today.md를 쓰는 동안 다른 실행이 잠금을 잡고 있어요.");
  return { date: seoulDate(now), today: pick, freshness: queue.freshness, queue: summary(queue), path: store.todayPath };
}

async function mutateState(ctx: AutopilotContext, deps: AutopilotDeps, change: (state: AutopilotState, now: Date) => { state: AutopilotState; value: unknown }): Promise<unknown> {
  const store = storeOf(ctx, deps);
  const locked = await store.withLock(async () => {
    const next = change(await store.readState().catch(error => { throw new CliError("STORE_UNREADABLE", `autopilot 상태를 읽지 못했어요: ${errorMessage(error)}`, { retry: "no" }); }), deps.now());
    await store.writeState(next.state);
    return next.value;
  }, 10_000);
  if (locked.busy) throw new CliError("AUTOPILOT_BUSY", "다른 tick 또는 실행이 상태를 쓰고 있어요. 잠시 뒤 다시 실행하세요.");
  return locked.value;
}

export const resolveKey = (ctx: AutopilotContext, key: string, deps: AutopilotDeps) => mutateState(ctx, deps, (state, now) => {
  const hit = state.reservations.filter(r => r.status === "awaiting_review" && r.key === key);
  if (!hit.length)
    throw new CliError("INVALID_INPUT", `리뷰 대기 예약이 없는 key예요: ${key}. Linear/Dashboard의 리뷰는 그쪽 상태를 바꿔 닫으세요.`, { next: ["reels autopilot status"] });
  return {
    state: { ...state, reservations: state.reservations.map(r => (hit.includes(r) ? { ...r, status: "done" as const, finishedAt: now.toISOString(), reason: "resolved" } : r)) },
    value: { key, resolved: hit.length },
  };
});
export const pause = (ctx: AutopilotContext, reason: string, deps: AutopilotDeps) => mutateState(ctx, deps, (state, now) => ({
  state: { ...state, paused: { at: now.toISOString(), reason } }, value: { paused: true, reason },
}));
export const resume = (ctx: AutopilotContext, deps: AutopilotDeps) => mutateState(ctx, deps, state => ({
  state: { ...state, paused: null }, value: { paused: false, wasPaused: state.paused },
}));

/**
 * The prompt the executor sends to `claude -p`. The Workflow args are in the prompt itself as one JSON line,
 * because the model is allowed no other tool in this step and could not read a file. Long descriptions are
 * moved to run files beforehand (see {@link spillLongInput}) and named by path in the args.
 */
export const outerPrompt = (args: unknown) => `afterwork-autopilot 등록 workflow를 Workflow 도구로 정확히 한 번 호출한다.
- name: afterwork-autopilot
- args: 아래 <args-json> 줄의 JSON 객체를 한 글자도 바꾸지 말고, 문자열이 아닌 객체 그대로 넘긴다. 파일을 읽을 필요가 없다.
<args-json>
${JSON.stringify(args)}
</args-json>
Workflow 도구 한 번 외에는 어떤 도구도 쓰지 않고 재시도하지 않는다. 입력 원문을 읽고 작업하는 일은 workflow 안의 에이전트가 한다.
workflow가 반환한 JSON 객체 하나만 마지막 출력으로 그대로 쓴다.
workflow가 없거나 실패하면 {"passed":false,"reason":"<짧은 이유>"} 만 출력한다.`;

/**
 * What the worker starts from, never the title alone. Linear text is the description as of this run
 * (cut at 8,000 characters with `descriptionTruncated` and the source URL). A Dashboard project hands over
 * its next action, notes and resource paths, and the worker rereads the project with `reels get-project`.
 */
export function workflowInput(item: QueueItem) {
  const description = item.description?.trim();
  const truncated = description !== undefined && description.length > descriptionLimit;
  const linear = item.identifier || description
    ? {
      ...(item.identifier ? { identifier: item.identifier } : {}), ...(item.stateName ? { stateName: item.stateName } : {}),
      ...(item.url ? { sourceUrl: item.url } : {}),
      ...(description ? { description: truncated ? description.slice(0, descriptionLimit) : description } : {}),
      ...(truncated ? { descriptionTruncated: true } : {}),
    }
    : undefined;
  const projectId = item.projectId ?? (item.source === "dashboard" ? item.key : undefined);
  const project = item.stage && projectId
    ? {
      id: projectId, stage: item.stage, nextAction: item.nextAction ?? "",
      ...(item.localNotes ? { localNotes: item.localNotes } : {}), ...(item.resources?.length ? { resources: item.resources } : {}),
      reread: `reels get-project --project-id ${projectId}`,
    }
    : undefined;
  return { ...(linear ? { linear } : {}), ...(project ? { project } : {}) };
}

const safeName = (key: string) => key.replace(/[^A-Za-z0-9_-]/g, "_");
/**
 * Keeps the Workflow args small. When the args would exceed {@link argsInlineLimit}, each description longer than
 * {@link descriptionInlineLimit} is written in full to `<runDir>/input-<key>.md` (0600) and the args carry a short
 * preview plus `descriptionPath`, which the worker reads first (its prompt allows that Read).
 */
export async function spillLongInput<T extends { key: string; input: { linear?: { description?: string; descriptionPath?: string } } }>(items: T[], dir: string, rest: Record<string, unknown>): Promise<T[]> {
  if (JSON.stringify({ ...rest, items }).length <= argsInlineLimit) return items;
  const spilled: T[] = [];
  for (const item of items) {
    const description = item.input.linear?.description;
    if (!description || description.length <= descriptionInlineLimit) { spilled.push(item); continue; }
    const file = path.join(dir, `input-${safeName(item.key)}.md`);
    await writeFile(file, description + "\n", { mode: 0o600 });
    spilled.push({ ...item, input: { ...item.input, linear: { ...item.input.linear, description: `${description.slice(0, 500)}…`, descriptionPath: file } } });
  }
  return spilled;
}

/** Files the executor itself writes into a run folder; a worker report can never be one of them. */
const executorFile = /^(args\.json|recheck\.json|execute\.log|input-.*)$/;
/**
 * The coordinating model only relays the workflow's JSON, so a passing verdict must point at a report the worker
 * actually wrote: a non-empty regular file in this run's fresh folder that is not one of the executor's own files.
 */
async function requireReports(result: ReturnType<typeof interpretRun>): Promise<ReturnType<typeof interpretRun>> {
  const verdicts = await Promise.all(result.verdicts.map(async v => {
    if (v.status !== "awaiting_review") return v;
    const report = v.reportPath ?? "";
    const real = !executorFile.test(path.basename(report))
      && await stat(report).then(info => info.isFile() && info.size > 0, () => false);
    return real ? v : { key: v.key, status: "failed" as const, reason: "report_missing" };
  }));
  return { ...result, verdicts };
}

const executorArgs = (config: AutopilotConfig, runDir: string) => [
  ...config.executor.args,
  "--permission-mode", config.execution.permissionMode,
  ...(config.execution.allowedTools.length ? ["--allowedTools", config.execution.allowedTools.join(",")] : []),
  // The reports live in the profile folder, outside the content project the worker runs in.
  "--add-dir", runDir,
];

/**
 * `reels autopilot execute --run <id>`: internal. Presents the run token, rechecks, calls the workflow once
 * and settles the reservations. A run whose reservations were reclaimed or never existed does nothing.
 */
export async function execute(ctx: AutopilotContext, runId: string, deps: AutopilotDeps): Promise<unknown> {
  const store = storeOf(ctx, deps);
  const config = await store.readConfig();
  let sources = await loadSources(ctx.root);
  const now = deps.now();
  const token = ctx.env[runTokenEnv];
  const workdir = config.execution.workdir;
  const workdirOk = workdir ? await stat(workdir).then(info => info.isDirectory(), () => false) : false;
  // Strict recheck, before the lock so a slow request never holds it: ask the Linear API again (no model) and use
  // that answer, not the cached copy, to count what waits for the user. Automatic runs are removed when it fails
  // or the queue is full; manual runs never are, but the outcome of the lookup is written down.
  const peek = token ? (await store.readState()).reservations.filter(r => r.runId === runId && r.token === token && inFlight(r)) : [];
  const runMode = peek[0]?.mode;
  let recheck: Recheck | undefined;
  if (peek.length) {
    const strict = await strictRecheck(ctx, deps, config);
    if (strict) {
      recheck = strict.result;
      if (strict.sources) sources = strict.sources;
    }
  }
  // Last check before any model call. A reservation that no longer fits is removed, not failed.
  const prepared = await store.withLock(async () => {
    const state = await store.readState();
    const mine = token ? state.reservations.filter(r => r.runId === runId && r.token === token && inFlight(r)) : [];
    if (!mine.length) return { items: [] as QueueItem[], mine, removed: [] as { key: string; reason: string }[], notMine: token ? "reservation_missing" : "token_missing", occupancy: undefined as number | undefined };
    const queue = buildQueue({ ...sources, ledger: state.reservations, now, config });
    const limit = Math.min(config.maxSlots, maxAutoSlots);
    const removed: { key: string; reason: string }[] = [];
    const keep: Reservation[] = [];
    for (const r of mine) {
      const reason = r.mode === "auto" && !config.enabled ? "disabled"
        : r.mode === "auto" && state.paused ? "paused"
        : r.mode === "auto" && recheck && !recheck.ok ? "linear_unavailable_at_start"
        : r.mode === "auto" && queue.occupancy >= limit ? "queue_full_at_start"
        : !findItem(queue, r.key) ? "item_gone"
        : !workdirOk ? "workdir_missing" : null;
      if (reason) removed.push({ key: r.key, reason }); else keep.push(r);
    }
    const dropped = new Set(mine.filter(r => !keep.includes(r)).map(r => r.id));
    const startedAt = deps.processStart(process.pid);
    const reservations = state.reservations.filter(r => !dropped.has(r.id)).map((r): Reservation => (keep.includes(r)
      ? { ...r, status: "running", pid: process.pid, ...(startedAt ? { processStartedAt: startedAt } : {}) } : r));
    // Without a working folder nothing can run and nothing would change on a retry: stop automatic ticks and say why.
    const missing = removed.some(item => item.reason === "workdir_missing");
    await store.writeState({
      ...state, reservations,
      paused: missing && !state.paused ? { at: now.toISOString(), reason: "workdir_missing: user-data autopilot/config.json의 execution.workdir에 콘텐츠 프로젝트 절대 경로를 설정한 뒤 `reels autopilot resume`" } : state.paused,
    });
    return { items: keep.map(r => findItem(queue, r.key)!), mine: keep, removed, notMine: undefined, occupancy: queue.occupancy };
  }, lockWaitMs);
  if (prepared.busy) throw new CliError("AUTOPILOT_BUSY", "상태 잠금을 얻지 못해 실행하지 않았어요.");
  const { items, mine, removed, notMine, occupancy } = prepared.value;
  const dir = store.runDir(runId);
  if (runMode) {
    // Kept for every run that had reservations, also when nothing started: why a start was or was not allowed.
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, "recheck.json"), JSON.stringify({
      at: now.toISOString(), mode: runMode, ...(recheck ? { lookup: recheck } : { lookup: "not_available" }),
      ...(occupancy !== undefined ? { occupancy } : {}), enforced: runMode === "auto",
    }, null, 2) + "\n", { mode: 0o600 });
  }
  if (!mine.length) return { runId, started: false, removed, modelCalls: 0, ...(recheck ? { recheck } : {}), ...(notMine ? { reason: notMine } : {}) };

  await mkdir(dir, { recursive: true, mode: 0o700 });
  const argsPath = path.join(dir, "args.json");
  const workflowItems = items.map(item => ({
    key: item.key, title: item.title, ...(item.url ? { url: item.url } : {}), kind: item.kind,
    ...(item.stage ? { stage: item.stage } : {}), ...(item.nextAction ? { nextAction: item.nextAction } : {}), reasons: item.reasons,
    input: workflowInput(item),
  }));
  const header = { runId, runDir: dir };
  const workflowArgs = { ...header, items: await spillLongInput(workflowItems, dir, header) };
  await writeFile(argsPath, JSON.stringify(workflowArgs, null, 2) + "\n", { mode: 0o600 });
  const output = await deps.runModel({
    command: config.executor.command, args: executorArgs(config, dir), input: outerPrompt(workflowArgs), cwd: workdir!,
    timeoutMs: config.executor.timeoutMinutes * 60_000, env: ctx.env,
  }).catch((error): RunOutput => ({ code: null, stdout: "", stderr: "", error: errorMessage(error) }));
  const verdict = await requireReports(interpretRun(output, mine, dir));

  const settled = await store.withLock(async () => {
    const state = await store.readState();
    const at = deps.now().toISOString();
    const reservations = state.reservations.map((r): Reservation => {
      const v = r.runId === runId && r.token === token && r.status === "running" ? verdict.verdicts.find(item => item.key === r.key) : undefined;
      if (!v) return r;
      return v.status === "awaiting_review"
        ? {
          ...r, status: "awaiting_review", finishedAt: at, ...(v.reportPath ? { reportPath: v.reportPath } : {}), ...(v.reason ? { reason: v.reason } : {}),
          ...(v.outcome ? { outcome: v.outcome } : {}), ...(v.changes ? { changes: v.changes } : {}),
        }
        : { ...r, status: "failed", finishedAt: at, reason: v.reason ?? "failed" };
    });
    // A limit or incomplete run stops automatic restarts until `reels autopilot resume`.
    await store.writeState({ ...state, reservations, paused: verdict.pause ? { at, reason: verdict.pause } : state.paused });
  }, lockWaitMs);
  if (settled.busy) throw new CliError("AUTOPILOT_BUSY", "결과를 기록하지 못했어요. 실행기가 끝났으므로 다음 tick이 pid 사망을 확인하고 회수해요.", { retry: "no" });
  return {
    runId, started: true, modelCalls: items.length, removed, passed: verdict.detail === "passed",
    ...(recheck ? { recheck } : {}),
    ...(verdict.pause ? { paused: verdict.pause } : {}), verdicts: verdict.verdicts,
  };
}

export const autopilotUsage = "reels autopilot <status|tick|run|today|resolve|pause|resume|refresh-linear|connect-linear|disconnect-linear|execute> [options]";
export const autopilotHelp = `Usage: ${autopilotUsage}
After-work autopilot: Linear/Dashboard queue, at most 3 automatic reservations, one item for after work.
  status                          Queue, occupancy, automatic slots, freshness, pause and last tick. Read-only.
  tick [--dry-run] [--now <iso>]  The automatic path a scheduler runs. --dry-run changes nothing and starts nothing.
  run --manual <key>...           Start named items now. Ignores the slot limit; refused when REELS_AUTOPILOT_AUTOMATED=1.
  today                           Print the one item to look at and write <profile>/autopilot/today.md.
  resolve <key>                   Close an awaiting_review reservation.
  pause [--reason <text>]         Stop automatic ticks from starting work.
  resume                          Allow them again (also after a limit pause).
  refresh-linear [--dry-run]      Model-free Linear read (Keychain key): counts and states only. Saves the copy unless --dry-run.
  connect-linear                  Terminal only. Stores the Linear API key in the Keychain; macOS asks for it, never an argument.
  disconnect-linear               Deletes that Keychain item only.
  execute --run <id>              Internal: the executor a tick or manual run starts.
Works without the app. REELS_USER_DATA selects the profile. Never prints credentials.
Example: reels autopilot tick --dry-run`;
const subcommands = ["status", "tick", "run", "today", "resolve", "pause", "resume", "refresh-linear", "connect-linear", "disconnect-linear", "execute"] as const;
const optionsFor = {
  status: {}, today: {}, resume: {}, resolve: {}, "connect-linear": {}, "disconnect-linear": {},
  "refresh-linear": { "dry-run": { type: "boolean" } },
  tick: { "dry-run": { type: "boolean" }, now: { type: "string" } },
  run: { manual: { type: "boolean" } },
  pause: { reason: { type: "string" } },
  execute: { run: { type: "string" } },
} as const;
export const autopilotWords = () => [...subcommands, "--dry-run", "--now", "--manual", "--reason", "--run", "--help"];
export const autopilotValueWords = () => ["--now", "--reason", "--run"];

function parse<T extends keyof typeof optionsFor>(name: T, args: string[]) {
  try {
    const { values, positionals } = parseArgs({ args, options: optionsFor[name] as never, allowPositionals: true, strict: true });
    return { values: values as Record<string, string | boolean | undefined>, positionals };
  } catch (error) {
    throw new CliError("USAGE", errorMessage(error).split(/\n|\. /)[0], { usage: autopilotUsage });
  }
}

export async function autopilotCommand(args: string[], ctx: AutopilotContext, scope: CommandScope, deps: AutopilotDeps = defaultDeps(ctx)): Promise<CommandResult> {
  const [name, ...rest] = args;
  if (name === undefined || name === "--help" || name === "-h" || rest.includes("--help")) return { data: { help: autopilotHelp } };
  if (!(subcommands as readonly string[]).includes(name))
    throw new CliError("USAGE", `Unknown autopilot command: ${name}`, { usage: autopilotUsage, didYouMean: [...subcommands] });
  const command = name as (typeof subcommands)[number];
  const { values, positionals } = parse(command, rest);
  const none = () => { if (positionals.length) throw new CliError("USAGE", `${command} takes no arguments.`, { usage: autopilotUsage }); };
  scope.readOnly = command === "status" || ((command === "tick" || command === "refresh-linear") && values["dry-run"] === true);
  switch (command) {
    case "status": none(); return { data: await status(ctx, deps) };
    case "tick": {
      none();
      const given = values.now as string | undefined;
      if (given !== undefined && !Number.isFinite(Date.parse(given))) throw new CliError("USAGE", "--now must be an ISO date-time.", { usage: autopilotUsage });
      scope.inFlight = { retry: "inspect_first", writeOutcome: "unknown", next: ["reels autopilot status"] };
      return { data: await tick(ctx, { dryRun: values["dry-run"] === true, ...(given ? { now: new Date(given) } : {}) }, deps) };
    }
    case "run":
      if (values.manual !== true) throw new CliError("USAGE", "run은 --manual만 지원해요. 자동 실행은 tick이 시작해요.", { usage: autopilotUsage });
      scope.inFlight = { retry: "inspect_first", writeOutcome: "unknown", next: ["reels autopilot status"] };
      return { data: await runManual(ctx, positionals, deps) };
    case "today": none(); return { data: await today(ctx, deps) };
    case "resolve":
      if (positionals.length !== 1) throw new CliError("USAGE", "resolve needs exactly one key.", { usage: autopilotUsage });
      return { data: await resolveKey(ctx, positionals[0], deps) };
    case "pause": none(); return { data: await pause(ctx, (values.reason as string | undefined) ?? "manual", deps) };
    case "resume": none(); return { data: await resume(ctx, deps) };
    case "refresh-linear":
      none();
      scope.inFlight = { retry: "safe", writeOutcome: "unknown", next: ["reels autopilot status"] };
      return { data: await refreshLinearCommand(ctx, { dryRun: values["dry-run"] === true }, deps) };
    case "connect-linear": none(); return { data: await connectLinear(ctx, deps) };
    case "disconnect-linear": none(); return { data: await disconnectLinear(deps) };
    case "execute": {
      none();
      const run = values.run as string | undefined;
      if (!run || !/^[A-Za-z0-9_-]+$/.test(run)) throw new CliError("USAGE", "execute needs --run <id>.", { usage: autopilotUsage });
      scope.inFlight = { retry: "no", writeOutcome: "unknown", next: ["reels autopilot status"] };
      return { data: await execute(ctx, run, deps) };
    }
  }
}
