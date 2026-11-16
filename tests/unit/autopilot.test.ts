import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  admission, buildQueue, classifyLinear, computeAutopilotView, defaultAutopilotConfig, emptyAutopilotState, evidenceFingerprint, fingerprint,
  interpretRun, pickToday, rankItems, reclaim, renderToday, selectCandidates, autopilotConfigSchema, linearKey, type RawItem, type Reservation,
} from "../../src/shared/autopilot";
import { AutopilotStore } from "../../src/shared/lib/autopilot-store";
import { PlanningStore } from "../../src/shared/lib/planning-store";
import { LocalStore } from "../../src/shared/lib/storage";
import { emptyPlanning, linearImportSchema, type Planning } from "../../src/shared/planning";
import type { Project, Stage } from "../../src/shared/contracts";
import {
  autopilotCommand, execute, outerPrompt, resolveKey, runManual, spillLongInput, status, tick, workflowInput, type AutopilotContext, type AutopilotDeps, type ModelRun,
} from "../../src/app/cli/autopilot";
import { CliError } from "../../src/app/cli/outcome";
import { run as runCli } from "../../src/app/cli/run";
import { Readable } from "node:stream";
import type { RunOutput } from "../../src/shared/autopilot";

const now = new Date("2026-11-16T05:00:00Z"); // Monday 14:00 KST, inside the active hours
const window = { from: "2026-11-09", to: "2026-11-23" };
const syncedAt = "2026-11-16T04:30:00Z";
type Issue = ReturnType<typeof linearImportSchema.parse>["issues"][number];
const issue = (n: number, extra: Partial<Issue> = {}): Issue => ({
  id: `i${n}`, identifier: `CONTENT-${n}`, title: `Synthetic issue ${n}`, url: `https://linear.app/example/issue/CONTENT-${n}`,
  dueDate: null, state: "unstarted", ...extra,
});
const linear = (issues: Issue[], extra: Record<string, unknown> = {}) =>
  linearImportSchema.parse({ url: "https://linear.app/example/team/CONTENT/all", syncedAt, window, issues, ...extra });
const planningOf = (issues: Issue[]): Planning => ({ ...emptyPlanning(), linear: linear(issues) });
const project = (id: string, stage: Stage, extra: Partial<Project> = {}): Project => ({
  id, title: `Synthetic project ${id}`, date: "2026-11-10", nextAction: "", stage, publicURL: "", shared: false, ...extra,
});
const config = () => defaultAutopilotConfig();

async function makeRoot(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "autopilot-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function setLinear(root: string, issues: Issue[], at = syncedAt, extra: Record<string, unknown> = {}) {
  const planning = new PlanningStore(root);
  const current = await planning.get();
  await planning.update({ expectedUpdatedAt: current.updatedAt, linear: linear(issues, { syncedAt: at, ...extra }) });
}
async function setProjects(root: string, projects: Project[]) {
  await new LocalStore(root).save({ schemaVersion: 1, projects, updatedAt: "2026-11-16T00:00:00.000Z" });
}

/** Replaces the clock, the processes and the model. The model mock counts every call. */
function fakeDeps(options: { delayMs?: number; outputs?: (RunOutput | Error)[]; alive?: (pid: number) => boolean; processStart?: (pid: number) => string | undefined } = {}) {
  const launches: { runId: string; logPath: string; token: string }[] = [];
  const models: ModelRun[] = [];
  const deps: AutopilotDeps = {
    now: () => now,
    isAlive: pid => (options.alive ? options.alive(pid) : pid === process.pid),
    processStart: pid => (options.processStart ? options.processStart(pid) : pid === process.pid ? "T0" : undefined),
    newId: randomUUID,
    async launch(run) {
      if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
      launches.push(run);
      return { pid: process.pid };
    },
    async runModel(run) {
      models.push(run);
      const next = options.outputs?.shift();
      if (next instanceof Error) throw next;
      return next ?? { code: 0, stdout: "", stderr: "" };
    },
  };
  return { deps, launches, models };
}
const context = (root: string, env: NodeJS.ProcessEnv = {}): AutopilotContext => ({ root, env: { REELS_USER_DATA: root, ...env }, script: "/unused/reels.mjs" });
const run = (ctx: AutopilotContext, deps: AutopilotDeps, dryRun = false) => tick(ctx, { dryRun, now }, deps);
const states = (root: string) => new AutopilotStore(root).readState();
async function writeConfig(root: string, config: Record<string, unknown>) {
  await mkdir(path.join(root, "autopilot"), { recursive: true });
  await writeFile(path.join(root, "autopilot", "config.json"), JSON.stringify(config));
}
const reviewIssues = (count: number) => Array.from({ length: count }, (_, i) => issue(100 + i, { state: "triage" }));
const candidateIssues = (count: number) => Array.from({ length: count }, (_, i) => issue(i + 1));

test("1. automatic admission is 3-existing, capped at three, and zero when three or more wait", async t => {
  const expected = new Map([[0, 3], [1, 2], [2, 1], [3, 0], [4, 0]]);
  for (const [existing, slots] of expected) {
    const root = await makeRoot(t);
    await setLinear(root, [...reviewIssues(existing), ...candidateIssues(5)]);
    const { deps, launches, models } = fakeDeps();
    const result = await run(context(root), deps);
    assert.equal(result.admitted, slots, `existing ${existing}`);
    assert.equal(launches.length, slots ? 1 : 0, `existing ${existing}: one executor, or none`);
    assert.equal(models.length, 0, "a tick never calls the model itself");
    if (slots === 0) {
      assert.equal(result.result, "queue_full");
      assert.equal(result.modelCalls, 0);
    } else assert.equal(result.modelCalls, slots);
    const running = (await states(root)).reservations.filter(r => r.status === "running");
    assert.equal(running.length, slots);
  }
  assert.equal(admission({ occupancy: 0, runningReservations: 0, mode: "auto" }), 3);
  assert.equal(admission({ occupancy: 1, runningReservations: 1, mode: "auto" }), 1);
  assert.equal(admission({ occupancy: 2, runningReservations: 0, mode: "auto", candidates: 0 }), 0);
  assert.equal(admission({ occupancy: 0, runningReservations: 0, mode: "auto", maxSlots: 9 }), 3, "never more than three");
  assert.equal(autopilotConfigSchema.safeParse({ ...config(), maxSlots: 4 }).success, false);
});

test("1b. running reservations count against automatic slots, awaiting ones count as occupied", async t => {
  const root = await makeRoot(t);
  await setLinear(root, [...reviewIssues(1), ...candidateIssues(5)]);
  const { deps, launches } = fakeDeps();
  const first = await run(context(root), deps);
  assert.equal(first.admitted, 2);
  // A second tick on changed input finds the running reservations and starts nothing more.
  await setLinear(root, [...reviewIssues(1), ...candidateIssues(5), issue(50)]);
  const second = await run(context(root), deps);
  assert.equal(second.admitted, 0);
  assert.equal(second.result, "no_slots");
  assert.equal(launches.length, 1);
});

test("2. manual runs ignore the limit, but an automated environment cannot pose as manual", async t => {
  for (const existing of [3, 4]) {
    const root = await makeRoot(t);
    await setLinear(root, [...reviewIssues(existing), ...candidateIssues(2)]);
    const { deps, launches } = fakeDeps();
    const auto = await run(context(root), deps);
    assert.equal(auto.result, "queue_full");
    assert.equal(launches.length, 0);
    const manual = (await runManual(context(root), ["linear:i1"], deps)) as { admitted: { key: string }[]; modelCalls: number };
    assert.deepEqual(manual.admitted.map(a => a.key), ["linear:i1"]);
    assert.equal(launches.length, 1);
    const [reservation] = (await states(root)).reservations;
    assert.equal(reservation.mode, "manual");
    assert.equal(reservation.status, "running");
    // The manual run is already running, so the same key is refused instead of started twice.
    await assert.rejects(runManual(context(root), ["linear:i1"], deps), /already_running/);
    assert.equal(launches.length, 1);
  }
  const root = await makeRoot(t);
  await setLinear(root, candidateIssues(1));
  const { deps, launches } = fakeDeps();
  await assert.rejects(
    autopilotCommand(["run", "--manual", "linear:i1"], context(root, { REELS_AUTOPILOT_AUTOMATED: "1" }), {}, deps),
    (error: unknown) => error instanceof CliError && error.code === "USAGE" && /수동 실행으로/.test(error.message),
  );
  assert.equal(launches.length, 0);
  assert.equal((await states(root)).reservations.length, 0);
  // Through the command it works, by Linear identifier as well as by key.
  const viaCommand = await autopilotCommand(["run", "--manual", "CONTENT-1"], context(root), {}, deps);
  assert.equal((viaCommand.data as { admitted: unknown[] }).admitted.length, 1);
  // A running manual reservation takes an automatic slot: 3 - 0 occupied - 1 running.
  await setLinear(root, candidateIssues(5));
  const next = await run(context(root), deps);
  assert.equal(next.admitted, 2);
});

test("3. overlapping ticks never exceed the slots or reserve a key twice", async t => {
  const root = await makeRoot(t);
  await setLinear(root, [...reviewIssues(1), ...candidateIssues(6)]);
  const { deps, launches } = fakeDeps({ delayMs: 120 });
  const results = await Promise.all([run(context(root), deps), run(context(root), deps), run(context(root), deps)]);
  assert.equal(results.filter(r => r.result === "busy").length, 2, "the others do nothing");
  const reservations = (await states(root)).reservations;
  assert.equal(reservations.length, 2, "1 existing review leaves 2 slots in total");
  assert.equal(new Set(reservations.map(r => r.key)).size, reservations.length);
  assert.equal(launches.length, 1);
  assert.equal(results.reduce((sum, r) => sum + (r.admitted as number), 0), 2);
  assert.deepEqual(await stat(path.join(root, "autopilot", "lock")).catch(() => "released"), "released");
});

test("3b. a dead holder's lock and orphaned reservations are taken back; failed keys wait for new evidence", async t => {
  const root = await makeRoot(t);
  await setLinear(root, candidateIssues(3));
  let alive = true;
  const { deps, launches } = fakeDeps({ alive: pid => (pid === process.pid ? alive : pid === 99_999_999 ? false : false) });
  // A crashed tick left its lock behind.
  await mkdir(path.join(root, "autopilot"), { recursive: true });
  await writeFile(path.join(root, "autopilot", "lock"), JSON.stringify({ pid: 99_999_999, at: now.toISOString(), token: "dead" }));
  const first = await run(context(root), deps);
  assert.equal(first.admitted, 3);
  assert.equal(launches.length, 1);
  // The executor dies: its pid is gone, so the next tick reclaims instead of leaving ghosts.
  alive = false;
  const second = await run(context(root), deps);
  assert.equal(second.reclaimed, 3);
  assert.equal(second.result, "no_candidates");
  assert.deepEqual((second.skippedCandidates as { reason: string }[]).map(s => s.reason), ["failed_unchanged", "failed_unchanged", "failed_unchanged"]);
  const failed = (await states(root)).reservations;
  assert.deepEqual(failed.map(r => [r.status, r.reason]), [["failed", "orphaned"], ["failed", "orphaned"], ["failed", "orphaned"]]);
  assert.equal(launches.length, 1, "no retry on unchanged evidence");
  // New evidence for one item frees only that item.
  await setLinear(root, [issue(1, { priority: 1 }), issue(2), issue(3)]);
  alive = true;
  const third = await run(context(root), deps);
  assert.equal(third.admitted, 1);
  assert.deepEqual(third.admittedKeys, ["linear:i1"]);
});

test("3c. only a dead runner gives a slot back: a missing pid or a dead pid, never an expired lease alone", async t => {
  const root = await makeRoot(t);
  await setLinear(root, candidateIssues(2));
  const store = new AutopilotStore(root);
  const mk = (id: string, key: string, extra: Partial<Reservation>): Reservation => ({
    id, key, mode: "auto", status: "running", token: "t", createdAt: "2026-11-16T01:00:00.000Z", leaseUntil: "2026-11-16T09:00:00.000Z", evidenceFingerprint: "old", ...extra,
  });
  await store.writeState({
    ...emptyAutopilotState(),
    reservations: [mk("a", "linear:i1", { pid: process.pid, leaseUntil: "2026-11-16T04:00:00.000Z" }), mk("b", "linear:i2", {})],
  });
  const { deps } = fakeDeps();
  const result = await run(context(root), deps);
  // "a" has an expired lease but its process is alive: it stays, and the tick says so. "b" has no pid.
  assert.equal(result.reclaimed, 1);
  const after = (await states(root)).reservations;
  assert.deepEqual(after.slice(0, 2).map(r => [r.status, r.reason ?? null]), [["running", null], ["failed", "orphaned"]]);
  assert.deepEqual(result.leaseExpiredAlive, ["linear:i1"]);
  assert.match((await states(root)).lastTick?.reason ?? "", /lease_expired_alive: linear:i1/);
  // The old evidence differs from the current one, so "b" is eligible again; "a" is still running and is not started twice.
  assert.deepEqual(result.admittedKeys, ["linear:i2"]);
});

test("4. Linear states map to autopilot kinds", () => {
  const kind = (state: Issue["state"], stateName?: string) => classifyLinear({ state, ...(stateName ? { stateName } : {}) });
  assert.equal(kind("started"), "active");
  assert.equal(kind("started", "In Progress"), "active");
  assert.equal(kind("started", "In Review"), "review");
  assert.equal(kind("started", "검토 필요"), "review");
  assert.equal(kind("triage"), "review");
  assert.equal(kind("backlog"), "candidate");
  assert.equal(kind("unstarted"), "candidate");
  assert.equal(kind("completed"), "ignore");
  assert.equal(kind("canceled"), "ignore");
  assert.equal(kind("duplicate"), "ignore");
});

test("J. Inbox and review state names count as review on every open type, and a closed type is ignored whatever its name", async t => {
  const kind = (state: Issue["state"], stateName?: string) => classifyLinear({ state, ...(stateName ? { stateName } : {}) });
  for (const [type, name] of [
    ["unstarted", "Inbox"], ["unstarted", "In box"], ["unstarted", " inbox "], ["backlog", "검토 대기"], ["backlog", "인박스"], ["unstarted", "Needs Review"],
    ["backlog", "리뷰 요청"], ["triage", "Inbox"], ["started", "In Review"],
  ] as const) assert.equal(kind(type, name), "review", `${type} / ${name}`);
  for (const type of ["completed", "canceled", "duplicate"] as const) assert.equal(kind(type, "In Review"), "ignore", `${type} stays ignored`);
  assert.equal(kind("unstarted", "Todo"), "candidate");
  assert.equal(kind("backlog", "Backlog"), "candidate");
  assert.equal(kind("started", "In Progress"), "active");
  assert.equal(kind("unstarted", "Inbox Zero plan"), "candidate", "only the Inbox column itself, not any name containing the word");
  // They occupy the review queue and stay out of the automatic pool, so three of them stop the tick.
  const root = await makeRoot(t);
  await setLinear(root, [
    issue(1, { state: "unstarted", stateName: "Inbox" }), issue(2, { state: "backlog", stateName: "검토 대기" }), issue(3, { state: "unstarted", stateName: "In box" }),
    issue(4), issue(5),
  ]);
  const { deps, launches, models } = fakeDeps();
  const result = await run(context(root), deps);
  assert.equal(result.occupancy, 3);
  assert.equal(result.result, "queue_full");
  assert.equal(result.admitted, 0);
  assert.equal(launches.length + models.length, 0);
  const queue = buildQueue({ planning: planningOf([issue(1, { state: "unstarted", stateName: "Inbox" }), issue(4)]), projects: [], ledger: [], now, config: config() });
  assert.deepEqual(selectCandidates(queue, []).eligible.map(i => i.key), ["linear:i4"], "the Inbox-named item is not a candidate");
});

test("4b. the same item in Linear and the Dashboard is counted once, review first", () => {
  const planning = planningOf([
    issue(1, { state: "started", stateName: "In Progress", projectId: "p1" }),
    issue(2, { state: "triage", projectId: "p2" }),
    issue(3, { state: "completed", projectId: "p3" }),
    issue(4, { state: "unstarted", projectId: "p9" }),
  ]);
  const projects = [project("p1", "review"), project("p2", "editing"), project("p3", "published"), project("p9", "published"), project("p4", "idea")];
  const queue = buildQueue({ planning, projects, ledger: [], now, config: config() });
  assert.deepEqual(queue.review.map(i => i.key).sort(), ["p1", "p2"], "p1 is review in the Dashboard, p2 is Inbox in Linear");
  assert.deepEqual(queue.active.map(i => i.key), ["p4"]);
  assert.deepEqual(queue.candidates, [], "a candidate whose project is published has nothing to prepare");
  assert.equal(queue.occupancy, 2);
  assert.equal(new Set([...queue.review, ...queue.active].map(i => i.key)).size, 3);
  assert.equal(linearKey(issue(1, { projectId: "p1" })), "p1");
  assert.equal(linearKey(issue(1)), "linear:i1");
  // A reservation waiting for review on a key already in the queue is not counted twice.
  const waiting: Reservation = {
    id: "r", key: "p2", mode: "auto", status: "awaiting_review", token: "t", createdAt: now.toISOString(), leaseUntil: now.toISOString(), evidenceFingerprint: "x",
  };
  const again = buildQueue({ planning, projects, ledger: [waiting, { ...waiting, id: "r2", key: "other" }], now, config: config() });
  assert.equal(again.occupancy, 3, "p1, p2 and the ledger-only key");
});

test("4c. missing, stale or out-of-window Linear data starts nothing and says why", async t => {
  const cases: [string, (root: string) => Promise<void>, string][] = [
    ["linear_missing", async () => {}, "linear_missing"],
    ["linear_stale", root => setLinear(root, candidateIssues(2), "2026-11-16T01:00:00Z"), "linear_stale"],
    ["linear_window", root => setLinear(root, candidateIssues(2), syncedAt, { window: { from: "2026-11-01", to: "2026-11-10" } }), "linear_window"],
  ];
  for (const [name, prepare, reason] of cases) {
    const root = await makeRoot(t);
    await prepare(root);
    const { deps, launches, models } = fakeDeps();
    const result = await run(context(root), deps);
    assert.equal(result.result, "freshness", name);
    assert.equal(result.admitted, 0, name);
    assert.equal((result.freshness as { reason: string }).reason, reason, name);
    assert.equal(launches.length + models.length, 0, name);
    assert.equal((await states(root)).lastTick?.result, "freshness", "the reason is kept");
  }
  const root = await makeRoot(t);
  await writeFile(path.join(root, "planning.json"), "broken");
  const { deps, launches } = fakeDeps();
  const broken = await run(context(root), deps);
  assert.equal(broken.result, "state_unreadable", "an unreadable source is not an empty queue");
  assert.equal(launches.length, 0);
});

test("4d. Dashboard projects and Linear issues read from disk count once through the tick", async t => {
  const root = await makeRoot(t);
  await setLinear(root, [issue(1, { state: "started", stateName: "In Progress", projectId: "p1" }), ...candidateIssues(0), issue(9)]);
  await setProjects(root, [project("p1", "review"), project("p2", "review"), project("p3", "published")]);
  const { deps, launches } = fakeDeps();
  const result = await run(context(root), deps);
  assert.equal(result.occupancy, 2, "p1 (review in the Dashboard, started in Linear) and p2");
  assert.equal(result.admitted, 1);
  assert.deepEqual(result.admittedKeys, ["linear:i9"]);
  assert.equal(launches.length, 1);
});

test("5. an urgent item falls behind on a blocker, a nearer deadline or a more complete rival", () => {
  const base = (key: string, extra: Partial<RawItem> = {}): RawItem => ({ key, kind: "active", source: "linear", title: key, blockedBy: [], ...extra });
  const order = (items: RawItem[]) => rankItems(items, now).map(i => i.key);
  const urgent = base("urgent", { priority: 1 });
  const medium = base("medium", { priority: 3 });
  assert.deepEqual(order([medium, urgent]), ["urgent", "medium"]);
  const blocked = rankItems([medium, { ...urgent, blockedBy: ["CONTENT-9"] }], now);
  assert.deepEqual(blocked.map(i => i.key), ["medium", "urgent"]);
  assert.ok(blocked[1].reasons.some(r => r.includes("차단됨: CONTENT-9")));
  assert.deepEqual(order([urgent, base("soon", { dueDate: "2026-11-17" })]), ["soon", "urgent"]);
  assert.deepEqual(order([urgent, base("overdue", { dueDate: "2026-11-10" })]), ["overdue", "urgent"]);
  assert.deepEqual(order([urgent, base("nearly", { priority: 2, subIssues: { open: 0, total: 4 } })]), ["nearly", "urgent"]);
  assert.deepEqual(order([urgent, base("farther", { stage: "editing", priority: 1, subIssues: { open: 1, total: 4 } })]), ["farther", "urgent"]);
  // Waiting counts more in the review queue, and ties break by key.
  const waiting = rankItems([base("old", { kind: "review", updatedAt: "2026-11-01T00:00:00Z" }), base("new", { kind: "review", updatedAt: "2026-11-16T00:00:00Z" })], now);
  assert.deepEqual(waiting.map(i => i.key), ["old", "new"]);
  assert.deepEqual(order([base("b"), base("a")]), ["a", "b"]);
});

test("5b. exactly one item is shown for after work, or none", () => {
  const planning = planningOf([
    issue(1, { state: "triage", priority: 1 }),
    issue(2, { state: "started", stateName: "In Review" }),
    issue(3, { state: "started", stateName: "In Progress" }),
  ]);
  const pick = pickToday(buildQueue({ planning, projects: [], ledger: [], now, config: config() }));
  assert.equal(pick?.kind, "review");
  assert.equal(pick?.target.startsWith("https://linear.app/"), true);
  assert.equal(pick?.userDecisionRequired, true);
  assert.ok(pick?.decision && pick.doneWhen && pick.why.length);
  // No review: the first unblocked active item, with its stored next action and a Dashboard id as the target.
  const active = buildQueue({ planning: emptyPlanning(), projects: [project("p1", "editing", { nextAction: "표지 고르기" })], ledger: [], now, config: config() });
  const next = pickToday(active);
  assert.equal(next?.kind, "active");
  assert.equal(next?.target, "project:p1");
  assert.match(next?.decision ?? "", /표지 고르기/);
  // Nothing to look at is "none", never an invented task.
  assert.equal(pickToday(buildQueue({ planning: emptyPlanning(), projects: [], ledger: [], now, config: config() })), null);
  const onlyBlocked = planningOf([issue(1, { state: "started", blockedBy: ["CONTENT-2"] })]);
  assert.equal(pickToday(buildQueue({ planning: onlyBlocked, projects: [], ledger: [], now, config: config() })), null);
});

test("6. a repeated tick on the same input changes nothing and calls nothing", async t => {
  const root = await makeRoot(t);
  await setLinear(root, candidateIssues(2));
  const { deps, launches, models } = fakeDeps();
  const first = await run(context(root), deps);
  assert.equal(first.admitted, 2);
  const second = await run(context(root), deps);
  assert.equal(second.result, "unchanged");
  assert.equal(second.modelCalls, 0);
  assert.equal(second.admitted, 0);
  assert.equal(launches.length, 1);
  assert.equal(models.length, 0);
  const planning = planningOf(candidateIssues(2));
  const same = fingerprint({ planning, projects: [], ledger: [], config: config() });
  assert.equal(same, fingerprint({ planning: structuredClone(planning), projects: [], ledger: [], config: config() }));
  assert.notEqual(same, fingerprint({ planning: planningOf([issue(1, { priority: 1 }), issue(2)]), projects: [], ledger: [], config: config() }));
  assert.notEqual(evidenceFingerprint({ key: "a", kind: "candidate", source: "linear", title: "a", blockedBy: [] }), evidenceFingerprint({ key: "a", kind: "candidate", source: "linear", title: "a", blockedBy: ["X-1"] }));
});

test("6b. dry run changes nothing and starts nothing but reports the same decision and today's item", async t => {
  const root = await makeRoot(t);
  await setLinear(root, [...reviewIssues(1), ...candidateIssues(4)]);
  const { deps, launches } = fakeDeps();
  const dry = await run(context(root), deps, true);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.wouldAdmit, 2);
  assert.equal(dry.admitted, 0);
  assert.equal(dry.modelCalls, 0);
  assert.equal((dry.today as { kind: string }).kind, "review");
  assert.equal(launches.length, 0);
  await assert.rejects(stat(path.join(root, "autopilot", "state.json")), "no state file is created");
  const view = (await status(context(root), deps)) as { autoSlots: number; occupancy: number };
  assert.deepEqual([view.occupancy, view.autoSlots], [1, 2]);
  await assert.rejects(stat(path.join(root, "autopilot", "state.json")), "status is read-only");
});

/** One tick that admits `count` candidates, returning what the executor would be asked to run. */
async function admitted(t: test.TestContext, outputs: (RunOutput | Error)[], count = 2) {
  const root = await makeRoot(t);
  await setLinear(root, candidateIssues(count));
  await writeConfig(root, { execution: { workdir: root } });
  const fake = fakeDeps({ outputs });
  const result = await run(context(root), fake.deps);
  assert.equal(result.admitted, count);
  const token = (await states(root)).reservations[0].token;
  // The executor is started with the run token; `ctx` is what that process sees.
  return { root, ...fake, runId: result.runId as string, token, ctx: context(root, { REELS_AUTOPILOT_RUN_TOKEN: token }) };
}
const verdict = async (root: string) => {
  const state = await states(root);
  return { state, statuses: state.reservations.map(r => r.status), reasons: state.reservations.map(r => r.reason ?? "") };
};

test("6c. an executor result that is null, failed, limited, incomplete or thrown is never a success", async t => {
  const cases: [string, RunOutput | Error, RegExp, boolean][] = [
    ["null", { code: 0, stdout: "null", stderr: "" }, /no_result/, false],
    ["empty", { code: 0, stdout: "", stderr: "" }, /no_result/, false],
    ["not passed", { code: 0, stdout: JSON.stringify({ passed: false, reason: "nope" }), stderr: "" }, /workflow_not_passed: nope/, false],
    ["limit on stderr", { code: 1, stdout: "", stderr: "Claude usage limit reached" }, /limit_reached/, true],
    ["limit on stdout", { code: 1, stdout: "You have hit your rate limit", stderr: "" }, /limit_reached/, true],
    ["incomplete", { code: 0, stdout: JSON.stringify({ passed: false, incomplete: true, items: [] }), stderr: "" }, /workflow_incomplete/, true],
    ["exit code", { code: 2, stdout: JSON.stringify({ passed: true, items: [] }), stderr: "" }, /exit_2/, false],
    ["exception", new Error("spawn claude ENOENT"), /executor_error: spawn claude ENOENT/, false],
    ["timeout", { code: null, stdout: "", stderr: "", timedOut: true }, /executor_timeout/, false],
  ];
  for (const [name, output, reason, pauses] of cases) {
    const { root, deps, runId, models, ctx } = await admitted(t, [output]);
    const done = (await execute(ctx, runId, deps)) as { passed: boolean };
    assert.equal(models.length, 1, name);
    assert.equal(done.passed, false, name);
    const { state, statuses, reasons } = await verdict(root);
    assert.deepEqual(statuses, ["failed", "failed"], name);
    assert.match(reasons[0], reason, name);
    assert.equal(Boolean(state.paused), pauses, name);
    if (pauses) {
      // A paused profile does not restart by itself.
      await setLinear(root, [...candidateIssues(2), issue(77)], "2026-11-16T04:40:00Z");
      const blocked = await run(context(root), deps);
      assert.equal(blocked.result, "paused", name);
      assert.equal(blocked.admitted, 0, name);
      assert.equal(models.length, 1, name);
    }
  }
});

test("6d. a passed workflow with report files waits for review; blocked items fail with the reason", async t => {
  const { root, runId, ctx } = await admitted(t, []);
  const store = new AutopilotStore(root);
  const dir = store.runDir(runId);
  const out = (items: unknown[]) => ({ code: 0, stdout: JSON.stringify({ type: "result", result: `done\n${JSON.stringify({ passed: true, items })}` }), stderr: "" });
  const queued = fakeDeps({ outputs: [out([
    { key: "linear:i1", status: "prepared", summary: "ready", reportPath: path.join(dir, "linear_i1.md"), decision: "approve?" },
    { key: "linear:i2", status: "blocked", summary: "needs access", reportPath: path.join(dir, "linear_i2.md"), decision: "" },
  ])] });
  // The worker writes its report into the run folder.
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "linear_i1.md"), "# report\n");
  const done = (await execute(ctx, runId, queued.deps)) as { passed: boolean; modelCalls: number };
  assert.equal(done.passed, true);
  assert.equal(done.modelCalls, 2);
  const state = await states(root);
  const byKey = Object.fromEntries(state.reservations.map(r => [r.key, r]));
  assert.equal(byKey["linear:i1"].status, "awaiting_review");
  assert.equal(byKey["linear:i1"].reportPath, path.join(dir, "linear_i1.md"));
  assert.equal(byKey["linear:i2"].status, "failed");
  assert.match(byKey["linear:i2"].reason ?? "", /blocked: needs access/);
  assert.equal(state.paused, null);
  const args = JSON.parse(await readFile(path.join(dir, "args.json"), "utf8"));
  assert.equal(args.runId, runId);
  assert.deepEqual(args.items.map((i: { key: string }) => i.key), ["linear:i1", "linear:i2"]);
  assert.deepEqual(queued.models[0].args.slice(0, 3), ["-p", "--strict-mcp-config", "--model"]);
  // The awaiting item now occupies a slot and is today's item; resolving closes it.
  const view = (await status(context(root), queued.deps)) as { occupancy: number; today: { key: string } };
  assert.equal(view.occupancy, 1);
  assert.equal(view.today.key, "linear:i1");
  await resolveKey(context(root), "linear:i1", queued.deps);
  assert.equal((await states(root)).reservations.find(r => r.key === "linear:i1")?.status, "done");
  await assert.rejects(resolveKey(context(root), "linear:i1", queued.deps), /리뷰 대기 예약이 없는 key/);
});

test("6i. a passing result whose report the worker never wrote, or that names an executor file, fails", async t => {
  const { root, runId, ctx } = await admitted(t, []);
  const dir = new AutopilotStore(root).runDir(runId);
  const out = (items: unknown[]) => ({ code: 0, stdout: JSON.stringify({ passed: true, items }), stderr: "" });
  const queued = fakeDeps({ outputs: [out([
    { key: "linear:i1", status: "prepared", summary: "invented", reportPath: path.join(dir, "linear_i1.md"), decision: "d" },
    { key: "linear:i2", status: "prepared", summary: "points at args", reportPath: path.join(dir, "args.json"), decision: "d" },
  ])] });
  await execute(ctx, runId, queued.deps);
  const state = await states(root);
  const byKey = Object.fromEntries(state.reservations.map(r => [r.key, r]));
  assert.deepEqual([byKey["linear:i1"].status, byKey["linear:i1"].reason], ["failed", "report_missing"]);
  assert.deepEqual([byKey["linear:i2"].status, byKey["linear:i2"].reason], ["failed", "report_missing"]);
});

test("6e. a report path outside the run folder is rejected", () => {
  const result = interpretRun(
    { code: 0, stdout: JSON.stringify({ passed: true, items: [{ key: "k", status: "prepared", summary: "s", reportPath: "/elsewhere/k.md", decision: "d" }] }), stderr: "" },
    [{ key: "k" }], "/runs/1",
  );
  assert.deepEqual(result.verdicts, [{ key: "k", status: "failed", reason: "invalid_report_path" }]);
  // Limit words inside a clean result's summary do not pause automation.
  const clean = interpretRun(
    { code: 0, stdout: JSON.stringify({ passed: true, items: [{ key: "k", status: "prepared", summary: "rate limit notes drafted", reportPath: "/runs/1/k.md", decision: "d" }] }), stderr: "" },
    [{ key: "k" }], "/runs/1",
  );
  assert.equal(clean.pause, null);
});

test("6f. the executor rechecks before the model call and removes reservations that no longer fit", async t => {
  const { root, deps, runId, models, ctx } = await admitted(t, [], 2);
  // Three reviews appeared by hand after the tick reserved.
  await setLinear(root, [...candidateIssues(2), ...reviewIssues(3)], "2026-11-16T04:40:00Z");
  const done = (await execute(ctx, runId, deps)) as { started: boolean; removed: { reason: string }[]; modelCalls: number };
  assert.equal(done.started, false);
  assert.equal(done.modelCalls, 0);
  assert.deepEqual(done.removed.map(r => r.reason), ["queue_full_at_start", "queue_full_at_start"]);
  assert.equal(models.length, 0);
  assert.equal((await states(root)).reservations.length, 0, "removed, so nothing is marked as failed evidence");
});

test("6g. pause and resume stop and allow automatic ticks, and a missing config file is not created", async t => {
  const root = await makeRoot(t);
  await setLinear(root, candidateIssues(2));
  const { deps, launches } = fakeDeps();
  await autopilotCommand(["pause", "--reason", "testing"], context(root), {}, deps);
  const paused = await run(context(root), deps);
  assert.equal(paused.result, "paused");
  assert.match(paused.reason as string, /testing/);
  assert.equal(launches.length, 0);
  await autopilotCommand(["resume"], context(root), {}, deps);
  assert.equal((await run(context(root), deps)).admitted, 2);
  await assert.rejects(stat(path.join(root, "autopilot", "config.json")));
  const off = await tick(context(root), { dryRun: false, now: new Date("2026-11-16T14:00:00Z") }, deps);
  assert.equal(off.result, "outside_hours");
});

test("6h. the first tick after the off-work time writes today.md once, without the model", async t => {
  const root = await makeRoot(t);
  await setLinear(root, [...reviewIssues(1)], "2026-11-16T09:40:00Z");
  const { deps, models } = fakeDeps();
  const evening = new Date("2026-11-16T09:45:00Z"); // 18:45 KST
  const first = await tick(context(root), { dryRun: false, now: evening }, deps);
  assert.equal(first.result, "outside_hours");
  assert.deepEqual((first.today as { refreshed: boolean }).refreshed, true);
  const text = await readFile(path.join(root, "autopilot", "today.md"), "utf8");
  assert.match(text, /# 오늘 볼 1개 - 2026-11-16/);
  assert.match(text, /linear\.app\/example\/issue\/CONTENT-100/);
  const second = await tick(context(root), { dryRun: false, now: evening }, deps);
  assert.equal(second.today, undefined);
  assert.equal(models.length, 0);
  assert.equal((await stat(path.join(root, "autopilot", "state.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(root, "autopilot"))).mode & 0o777, 0o700);
});

// 7. The native Workflow source, run against a mock runtime.
const workflowFile = path.join(import.meta.dirname, "../../automation/claude-workflows/afterwork-autopilot.js");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...names: string[]) => (...values: unknown[]) => Promise<any>;
async function runWorkflow(args: unknown, agentImpl: (prompt: string, opts: Record<string, any>, index: number) => unknown) {
  const source = await readFile(workflowFile, "utf8");
  const calls: { prompt: string; opts: Record<string, any> }[] = [];
  const body = source.replace(/^export const meta = /, "const meta = ");
  const fn = new AsyncFunction("agent", "parallel", "log", "phase", "args", body);
  const result = await fn(
    async (prompt: string, opts: Record<string, any>) => { calls.push({ prompt, opts }); return agentImpl(prompt, opts, calls.length - 1); },
    (thunks: (() => Promise<unknown>)[]) => Promise.all(thunks.map(thunk => thunk().catch(() => null))),
    () => {}, () => {}, args,
  );
  return { result, calls };
}
const wfItems = (count: number) => Array.from({ length: count }, (_, i) => ({
  key: `linear:i${i + 1}`, title: `Synthetic ${i + 1}`, kind: "candidate", reasons: ["r"], input: { linear: { identifier: `CONTENT-${i + 1}`, description: `Body ${i + 1}` } },
}));
const wfOk = (items: { key: string }[], extra: Record<string, unknown> = {}) => (_: string, __: unknown, index: number) => ({
  key: items[index].key, status: "prepared", summary: "s", reportPath: `/run/${items[index].key.replace(/[^A-Za-z0-9_-]/g, "_")}.md`, decision: "d",
  sources: ["/p/AGENTS.md"], changes: [], verification: [], ...extra,
});

test("7. the workflow file keeps the registration contract", async () => {
  const source = await readFile(workflowFile, "utf8");
  assert.match(source.split("\n")[0], /^export const meta = \{$/);
  assert.match(source, /name: 'afterwork-autopilot'/);
  assert.match(source, /phases: \[\{ title: 'Progress'/);
  assert.doesNotMatch(source, /Date\.now|Math\.random|new Date\b|require\(|\bimport\b(?!\s*ant)|node:|child_process|readFile/);
});

test("7b. dry run and an empty list start no agent", async () => {
  const none = (): never => { throw new Error("no agent expected"); };
  for (const input of [{ runId: "r1", runDir: "/run", items: wfItems(3), dryRun: true }, { runId: "r1", runDir: "/run", items: [] }, {}]) {
    const { result, calls } = await runWorkflow(input, none);
    assert.deepEqual(result, { passed: true, items: [] });
    assert.equal(calls.length, 0);
  }
});

test("7c. three items run three sonnet/medium agents and return their results", async () => {
  const items = wfItems(3);
  const { result, calls } = await runWorkflow({ runId: "r1", runDir: "/run", items }, wfOk(items));
  assert.equal(calls.length, 3);
  for (const { opts, prompt } of calls) {
    assert.equal(opts.model, "sonnet");
    assert.equal(opts.effort, "medium");
    assert.deepEqual(opts.schema.required, ["key", "status", "summary", "reportPath", "decision", "sources", "changes", "verification"]);
    assert.deepEqual(opts.schema.properties.status.enum, ["progressed", "prepared", "blocked", "needs_user"]);
    assert.match(prompt, /외부 게시·업로드·계정·결제·삭제/);
  }
  assert.equal(result.passed, true);
  assert.deepEqual(result.items.map((i: { key: string }) => i.key), items.map(i => i.key));
  assert.equal(calls[0].prompt.includes("/run/linear_i1.md"), true);
  const four = runWorkflow({ runId: "r1", runDir: "/run", items: wfItems(4) }, () => ({}));
  await assert.rejects(four, /at most 3 items/);
});

test("7d. a null agent result makes the run incomplete instead of dropping the item", async () => {
  const items = wfItems(3);
  const ok = wfOk(items);
  const { result } = await runWorkflow({ runId: "r1", runDir: "/run", items }, (p, o, i) => (i === 1 ? null : ok(p, o, i)));
  assert.equal(result.passed, false);
  assert.equal(result.incomplete, true);
  assert.deepEqual(result.items, []);
  const wrong = await runWorkflow({ runId: "r1", runDir: "/run", items }, (p, o, i) => ({ ...ok(p, o, i), reportPath: "/elsewhere/x.md" }));
  assert.equal(wrong.result.passed, false);
});

test("8. the CLI builtin works without the app and keeps its exit codes", async t => {
  const root = await makeRoot(t);
  // `status` has no --now and reads the wall clock. With the fixed `syncedAt`/`window` it goes
  // stale (staleAfterMinutes) or leaves the window depending on when the suite runs, so this
  // snapshot is synced just now and its window covers both today and the fixed `now` the tick uses.
  const wallClock = new Date();
  const day = (offset: number) => new Date(wallClock.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  const span = { from: [window.from, day(-1)].sort()[0], to: [window.to, day(2)].sort()[1] };
  await setLinear(root, [...reviewIssues(1), ...candidateIssues(2)], wallClock.toISOString(), { window: span });
  const cli = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
    let out = "";
    const code = await runCli(args, { stdin: () => Readable.from([]), stdout: text => { out += text; }, stderr: () => {}, env: { REELS_USER_DATA: root, ...env }, cwd: () => root });
    return { code, document: JSON.parse(out) };
  };
  const status = await cli(["autopilot", "status"]);
  assert.equal(status.code, 0);
  assert.equal(status.document.data.autoSlots, 2);
  assert.equal(status.document.data.today.kind, "review");
  const dry = await cli(["autopilot", "tick", "--dry-run", "--now", now.toISOString()]);
  assert.equal(dry.code, 0);
  assert.equal(dry.document.data.wouldAdmit, 2);
  assert.equal(dry.document.data.modelCalls, 0);
  const help = await cli(["help", "autopilot"]);
  assert.match(help.document.data.help, /Example: reels autopilot tick --dry-run/);
  const posing = await cli(["autopilot", "run", "--manual", "linear:i1"], { REELS_AUTOPILOT_AUTOMATED: "1" });
  assert.equal(posing.code, 2);
  assert.equal(posing.document.error.code, "USAGE");
  assert.equal((await cli(["autopilot", "run", "linear:i1"])).code, 2, "run needs --manual");
  assert.equal((await cli(["autopilot", "nope"])).document.error.didYouMean.includes("tick"), true);
  assert.equal((await cli(["autopilot", "tick", "--now", "x"])).code, 2);
  await assert.rejects(stat(path.join(root, "autopilot", "state.json")), "read-only commands wrote nothing");
});

// ---------------------------------------------------------------------------------------------
// C2: the fingerprint carries meaning, not read times; leases and pids; the starting state.

const mkRes = (id: string, key: string, extra: Partial<Reservation> = {}): Reservation => ({
  id, key, mode: "auto", status: "running", token: "tok", createdAt: "2026-11-16T04:00:00.000Z", leaseUntil: "2026-11-16T09:00:00.000Z", evidenceFingerprint: "old", ...extra,
});
const later = new Date("2026-11-17T05:00:00Z"); // 24 hours on, same clock time

test("C2a. a new snapshot with the same content is fresh but unchanged; changed content goes on", async t => {
  const root = await makeRoot(t);
  await setLinear(root, candidateIssues(2));
  const { deps, launches, models } = fakeDeps();
  assert.equal((await run(context(root), deps)).admitted, 2);
  await setLinear(root, candidateIssues(2), "2026-11-16T04:50:00Z");
  const again = await run(context(root), deps);
  assert.deepEqual([again.result, (again.freshness as { ok: boolean; syncedAt: string }).ok, (again.freshness as { syncedAt: string }).syncedAt], ["unchanged", true, "2026-11-16T04:50:00Z"]);
  assert.equal(again.admitted, 0);
  assert.equal(again.modelCalls, 0);
  assert.equal(launches.length + models.length, 1, "only the first tick started an executor");
  // The meaning changed (a third candidate): the tick reconsiders and starts it.
  await setLinear(root, [...candidateIssues(2), issue(9)], "2026-11-16T04:55:00Z");
  const changed = await run(context(root), deps);
  assert.equal(changed.result, "admitted");
  assert.deepEqual(changed.admittedKeys, ["linear:i9"]);
  const planning = planningOf(candidateIssues(2));
  const resynced: Planning = { ...planning, updatedAt: "2026-11-16T09:00:00.000Z", linear: { ...planning.linear!, syncedAt: "2026-11-16T09:00:00Z" } };
  assert.equal(fingerprint({ planning, projects: [], ledger: [], config: config() }), fingerprint({ planning: resynced, projects: [], ledger: [], config: config() }), "syncedAt and updatedAt are not part of it");
  const starting = [mkRes("a", "k", { status: "starting" })];
  assert.equal(fingerprint({ planning, projects: [], ledger: starting, config: config() }), fingerprint({ planning, projects: [], ledger: [{ ...starting[0], status: "running" }], config: config() }));
  assert.notEqual(fingerprint({ planning, projects: [], ledger: [], config: config() }), fingerprint({ planning: planningOf([issue(1, { title: "Renamed" }), issue(2)]), projects: [], ledger: [], config: config() }), "the title is meaning");
});

test("C2b. days passing alone do not regenerate work; a changed order does", async t => {
  const stable = await makeRoot(t);
  const base = [...reviewIssues(2), issue(1, { priority: 1, updatedAt: "2026-11-10T00:00:00Z" }), issue(2, { priority: 3, updatedAt: "2026-11-10T00:00:00Z" })];
  await setLinear(stable, base);
  const { deps } = fakeDeps();
  assert.equal((await run(context(stable), deps)).admitted, 1, "one slot with two reviews waiting");
  // A day later the days-waited points moved but the order did not.
  await setLinear(stable, base, "2026-11-17T04:30:00Z");
  const same = await tick(context(stable), { dryRun: false, now: later }, deps);
  assert.equal(same.result, "unchanged");
  // Here the deadline crosses a bucket and flips the order: the tick looks again.
  const flipped = await makeRoot(t);
  const flip = [...reviewIssues(2), issue(1, { dueDate: "2026-11-19" }), issue(2, { priority: 1 })];
  await setLinear(flipped, flip);
  const first = await run(context(flipped), deps);
  assert.deepEqual(first.admittedKeys, ["linear:i2"]);
  await setLinear(flipped, flip, "2026-11-17T04:30:00Z");
  const next = await tick(context(flipped), { dryRun: false, now: later }, deps);
  assert.notEqual(next.result, "unchanged");
  const candidatesOf = (result: Record<string, unknown>) => (result.order as { current: { key: string }[] }).current.map(i => i.key).filter(k => !k.startsWith("linear:i10"));
  assert.deepEqual(candidatesOf(first), ["linear:i2", "linear:i1"]);
  assert.deepEqual(candidatesOf(next), ["linear:i1", "linear:i2"], "the deadline moved the order and the tick saw it");
});

test("C2c. a dead or reused pid is reclaimed; an expired lease with a live runner is not", () => {
  const probe = { isAlive: (pid: number) => pid === 4242, startedAt: (pid: number) => (pid === 4242 ? "Mon 14:00" : undefined) };
  const state = {
    ...emptyAutopilotState(),
    reservations: [
      mkRes("dead", "k1", { pid: 9999, leaseUntil: "2026-11-16T04:00:00.000Z" }),
      mkRes("reused", "k2", { pid: 4242, processStartedAt: "Sun 01:00" }),
      mkRes("same", "k3", { pid: 4242, processStartedAt: "Mon 14:00", leaseUntil: "2026-11-16T04:00:00.000Z" }),
      mkRes("unrecorded", "k4", { pid: 4242 }),
      mkRes("nopid", "k5", {}),
    ],
  };
  const result = reclaim(state, now, probe);
  assert.deepEqual(result.reclaimed, ["dead", "reused", "nopid"]);
  assert.deepEqual(result.state.reservations.map(r => r.status), ["failed", "failed", "running", "running", "failed"]);
  assert.deepEqual(result.leaseExpiredAlive, ["k3"], "alive past its lease: kept and reported");
  // A start time that cannot be read is not proof of a different process.
  const blind = reclaim(state, now, { isAlive: probe.isAlive, startedAt: () => undefined });
  assert.deepEqual(blind.reclaimed, ["dead", "nopid"]);
});

test("C2d. a starting reservation holds its slot and key until its deadline passes without a pid", async t => {
  const root = await makeRoot(t);
  await setLinear(root, candidateIssues(4));
  const store = new AutopilotStore(root);
  const startDeadline = (ms: number) => new Date(now.getTime() + ms).toISOString();
  await store.writeState({ ...emptyAutopilotState(), reservations: [mkRes("s", "linear:i1", { status: "starting", startDeadline: startDeadline(60_000), runId: "other" })] });
  const { deps } = fakeDeps();
  const second = await run(context(root), deps);
  assert.equal(second.reclaimed, undefined, "not reclaimed before the deadline");
  assert.deepEqual(second.admittedKeys, ["linear:i2", "linear:i3"], "3 slots - 1 starting, and the same key is not reserved again");
  const kept = (await states(root)).reservations;
  assert.equal(kept.filter(r => r.key === "linear:i1").length, 1);
  assert.equal(kept[0].status, "starting");
  // Past the deadline with no pid: taken back, so the key may run again.
  const dead = await makeRoot(t);
  await setLinear(dead, candidateIssues(1));
  await new AutopilotStore(dead).writeState({ ...emptyAutopilotState(), reservations: [mkRes("s", "linear:i1", { status: "starting", startDeadline: startDeadline(-1000), runId: "other" })] });
  const taken = await run(context(dead), deps);
  assert.equal(taken.reclaimed, 1);
  assert.deepEqual((await states(dead)).reservations.slice(0, 1).map(r => [r.status, r.reason]), [["failed", "start_deadline"]]);
});

test("C2e. a tick saves `starting` before the spawn and `running` with pid, start time and token after it", async t => {
  const root = await makeRoot(t);
  await setLinear(root, candidateIssues(2));
  const fake = fakeDeps();
  const seen: unknown[] = [];
  const launch = fake.deps.launch;
  fake.deps.launch = async run => {
    seen.push((await states(root)).reservations.map(r => [r.status, r.pid ?? null, r.token === run.token]));
    return launch(run);
  };
  await run(context(root), fake.deps);
  assert.deepEqual(seen, [[["starting", null, true], ["starting", null, true]]]);
  assert.deepEqual((await states(root)).reservations.map(r => [r.status, r.pid, r.processStartedAt, r.token === fake.launches[0].token]), [["running", process.pid, "T0", true], ["running", process.pid, "T0", true]]);
  // A failed spawn leaves failed reservations, not ghosts.
  const failing = await makeRoot(t);
  await setLinear(failing, candidateIssues(2));
  const broken = fakeDeps();
  broken.deps.launch = async () => { throw new Error("spawn ENOENT"); };
  const result = await run(context(failing), broken.deps);
  assert.equal(result.result, "spawn_failed");
  assert.deepEqual((await states(failing)).reservations.map(r => [r.status, (r.reason ?? "").slice(0, 12)]), [["failed", "spawn_failed"], ["failed", "spawn_failed"]]);
});

test("C2f. an executor that starts after its reservation was reclaimed, or without the token, does no work", async t => {
  const root = await makeRoot(t);
  await setLinear(root, candidateIssues(2));
  await writeConfig(root, { execution: { workdir: root } });
  const store = new AutopilotStore(root);
  await store.writeState({ ...emptyAutopilotState(), reservations: [mkRes("s", "linear:i1", { status: "starting", token: "late", runId: "run-late", startDeadline: new Date(now.getTime() - 1000).toISOString() })] });
  const { deps, models } = fakeDeps();
  const reclaimedBy = await run(context(root), deps);
  assert.equal(reclaimedBy.reclaimed, 1);
  const before = JSON.stringify(await states(root));
  const late = (await execute(context(root, { REELS_AUTOPILOT_RUN_TOKEN: "late" }), "run-late", deps)) as { started: boolean; modelCalls: number; reason: string };
  assert.deepEqual([late.started, late.modelCalls, late.reason], [false, 0, "reservation_missing"]);
  // The other reservations were started by the tick above; a wrong or missing token touches none of them.
  const live = (await states(root)).reservations.find(r => r.status === "running")!;
  for (const env of [{ REELS_AUTOPILOT_RUN_TOKEN: "wrong" }, {}]) {
    const refused = (await execute(context(root, env), live.runId!, deps)) as { started: boolean; modelCalls: number };
    assert.deepEqual([refused.started, refused.modelCalls], [false, 0]);
  }
  assert.equal(models.length, 0);
  assert.equal(JSON.stringify(await states(root)).includes('"failed"'), true);
  assert.equal(before.includes("start_deadline"), true);
  assert.equal((await states(root)).reservations.find(r => r.id === live.id)?.status, "running");
});

test("C2g. two ticks racing over a reclaim never exceed the slots or reserve a key twice", async t => {
  const root = await makeRoot(t);
  await setLinear(root, candidateIssues(6));
  await new AutopilotStore(root).writeState({
    ...emptyAutopilotState(),
    reservations: [
      mkRes("dead", "linear:i1", { pid: 99_999_999 }),
      mkRes("late", "linear:i2", { status: "starting", startDeadline: new Date(now.getTime() - 1000).toISOString() }),
      mkRes("live", "linear:i3", { pid: process.pid }),
    ],
  });
  const { deps, launches } = fakeDeps({ delayMs: 80 });
  const results = await Promise.all([run(context(root), deps), run(context(root), deps), run(context(root), deps)]);
  assert.equal(results.filter(r => r.result === "busy").length, 2);
  const flight = (await states(root)).reservations.filter(r => r.status === "starting" || r.status === "running");
  assert.ok(flight.length <= 3, `in flight ${flight.length}`);
  assert.equal(new Set(flight.map(r => r.key)).size, flight.length, "no key twice");
  assert.equal(launches.length, 1);
  assert.deepEqual((await states(root)).reservations.slice(0, 2).map(r => r.reason), ["orphaned", "start_deadline"]);
});

// ---------------------------------------------------------------------------------------------
// C3: existing active work is part of the automatic pool.

const startedIssue = (n: number, extra: Partial<Issue> = {}) => issue(n, { state: "started", stateName: "In Progress", ...extra });

test("C3a. an existing active item is admitted ahead of new candidates with the same evidence", async t => {
  const root = await makeRoot(t);
  await setLinear(root, [issue(1), issue(2), startedIssue(3)]);
  const { deps } = fakeDeps();
  const result = await run(context(root), deps);
  assert.equal(result.admitted, 3);
  assert.equal((result.admittedKeys as string[])[0], "linear:i3", "the started item comes first");
  assert.deepEqual((await states(root)).reservations.map(r => r.key), ["linear:i3", "linear:i1", "linear:i2"]);
  // One slot: the started item takes it over the candidates.
  const tight = await makeRoot(t);
  await setLinear(tight, [...reviewIssues(2), issue(1), issue(2), startedIssue(3)]);
  assert.deepEqual((await run(context(tight), deps)).admittedKeys, ["linear:i3"]);
});

test("C3b. an item with a starting or running reservation, or already processed on the same evidence, is not picked again", () => {
  const planning = planningOf([startedIssue(1), issue(2), issue(3), issue(4), issue(5, { blockedBy: ["CONTENT-9"] })]);
  const queue = buildQueue({ planning, projects: [], ledger: [], now, config: config() });
  const evidence = (n: number) => evidenceFingerprint(queue.active.concat(queue.candidates).find(i => i.key === `linear:i${n}`)!);
  const ledger = [
    mkRes("r1", "linear:i1", { status: "starting" }),
    mkRes("r2", "linear:i2", { status: "running" }),
    mkRes("r3", "linear:i3", { status: "done", evidenceFingerprint: evidence(3), outcome: "needs_user" }),
    mkRes("r4", "linear:i4", { status: "failed", evidenceFingerprint: evidence(4) }),
  ];
  const { eligible, skipped } = selectCandidates(queue, ledger);
  assert.deepEqual(eligible, []);
  assert.deepEqual(skipped.map(s => [s.key, s.reason]).sort(), [
    ["linear:i1", "running"], ["linear:i2", "running"], ["linear:i3", "needs_user_unchanged"], ["linear:i4", "failed_unchanged"], ["linear:i5", "blocked"],
  ]);
  // New evidence frees the failed one again.
  const changed = buildQueue({ planning: planningOf([issue(4, { priority: 1 })]), projects: [], ledger: [], now, config: config() });
  assert.deepEqual(selectCandidates(changed, ledger).eligible.map(i => i.key), ["linear:i4"]);
  // A Linear issue and a Dashboard project with one key are one item.
  const both = buildQueue({ planning: planningOf([startedIssue(7, { projectId: "p7" })]), projects: [project("p7", "editing")], ledger: [], now, config: config() });
  assert.deepEqual(selectCandidates(both, []).eligible.map(i => i.key), ["p7"]);
});

test("C3c. review and Inbox items are never in the automatic pool", async t => {
  const planning = planningOf([issue(1, { state: "triage" }), issue(2, { state: "started", stateName: "In Review" }), startedIssue(3), issue(4)]);
  const queue = buildQueue({ planning, projects: [project("p1", "review"), project("p2", "editing"), project("p3", "published")], ledger: [], now, config: config() });
  assert.deepEqual(selectCandidates(queue, []).eligible.map(i => i.key).sort(), ["linear:i3", "linear:i4"]);
  const root = await makeRoot(t);
  await setLinear(root, [issue(1, { state: "triage" }), issue(2, { state: "started", stateName: "In Review" }), issue(4)]);
  const { deps } = fakeDeps();
  const result = await run(context(root), deps);
  assert.deepEqual(result.admittedKeys, ["linear:i4"]);
});

test("K. the automatic pool is the Linear team's items and the cards linked to them; Dashboard-only cards are manual only", async t => {
  // (a) Only Dashboard-only idea/editing cards and no occupancy: nothing is admitted and no model runs.
  const only = await makeRoot(t);
  await setLinear(only, []);
  await setProjects(only, [project("p-idea", "idea"), project("p-edit", "editing"), project("p-cap", "captured")]);
  const a = fakeDeps();
  const none = await run(context(only), a.deps);
  assert.equal(none.admitted, 0);
  assert.equal(none.result, "no_candidates");
  assert.equal(a.launches.length + a.models.length, 0);
  assert.deepEqual((none.skippedCandidates as { reason: string }[]).map(s => s.reason), ["dashboard_only", "dashboard_only", "dashboard_only"], "the reason is recorded");
  assert.equal((none.queue as { active: number }).active, 3, "they still count as the user's in-progress work in the view");
  // (b) A started Linear issue and the Dashboard card linked to it are one automatic item.
  const linked = planningOf([startedIssue(1, { projectId: "p1" }), issue(2)]);
  const queue = buildQueue({ planning: linked, projects: [project("p1", "editing"), project("p-lone", "editing")], ledger: [], now, config: config() });
  const pool = selectCandidates(queue, []);
  assert.deepEqual(pool.eligible.map(i => i.key).sort(), ["linear:i2", "p1"], "one entry for the linked pair, the lone card is not in it");
  assert.equal(pool.eligible.find(i => i.key === "p1")?.source, "both");
  assert.deepEqual(pool.skipped, [{ key: "p-lone", reason: "dashboard_only" }]);
  const root = await makeRoot(t);
  await setLinear(root, [startedIssue(1, { projectId: "p1" })]);
  await setProjects(root, [project("p1", "editing"), project("p-lone", "idea")]);
  const b = fakeDeps();
  assert.deepEqual((await run(context(root), b.deps)).admittedKeys, ["p1"]);
  // (c) Manual runs still take a Dashboard-only card, whatever the occupancy.
  const manualRoot = await makeRoot(t);
  await setLinear(manualRoot, reviewIssues(3));
  await setProjects(manualRoot, [project("p-lone", "idea")]);
  const c = fakeDeps();
  const manual = (await runManual(context(manualRoot), ["p-lone"], c.deps)) as { admitted: { key: string }[] };
  assert.deepEqual(manual.admitted.map(x => x.key), ["p-lone"]);
  assert.equal(c.launches.length, 1);
  // (d) Dashboard-only review cards keep counting toward the occupancy.
  const full = await makeRoot(t);
  await setLinear(full, [...reviewIssues(1), ...candidateIssues(3)]);
  await setProjects(full, [project("r1", "review"), project("r2", "review")]);
  const d = fakeDeps();
  const stopped = await run(context(full), d.deps);
  assert.equal(stopped.occupancy, 3);
  assert.equal(stopped.result, "queue_full");
  assert.equal(d.launches.length, 0);
  const view = computeAutopilotView({ planning: planningOf(candidateIssues(2)), projects: [project("r1", "review"), project("p-lone", "idea")], state: emptyAutopilotState(), config: config(), now, probe: () => false });
  assert.deepEqual([view.counts.occupancy, view.counts.autoSlots], [1, 2], "a lone card is not a slot candidate, the two Linear candidates are");
});

test("C3d. the executor hands the worker the source text, not just a title", async t => {
  const root = await makeRoot(t);
  await setLinear(root, [issue(1, { description: "인트로 훅을 세 가지로 줄이기\n- 기준: 3초 안에 상황 설명" }), startedIssue(2), issue(3, { projectId: "p1" })]);
  await setProjects(root, [project("p1", "editing", {
    nextAction: "표지 문구 고르기", localNotes: "촬영본 02가 가장 좋음", resources: [{ role: "document", path: "/content/p1/script.md", label: "대본" }],
  })]);
  await writeConfig(root, { execution: { workdir: root } });
  const fake = fakeDeps({ outputs: [] });
  const ticked = await run(context(root), fake.deps);
  assert.equal(ticked.admitted, 3);
  const token = (await states(root)).reservations[0].token;
  await execute(context(root, { REELS_AUTOPILOT_RUN_TOKEN: token }), ticked.runId as string, fake.deps);
  const args = JSON.parse(await readFile(path.join(new AutopilotStore(root).runDir(ticked.runId as string), "args.json"), "utf8")) as { items: { key: string; input: any }[] };
  const byKey = Object.fromEntries(args.items.map(i => [i.key, i.input]));
  assert.match(byKey["linear:i1"].linear.description, /인트로 훅을 세 가지로/);
  assert.equal(byKey["linear:i1"].linear.sourceUrl, "https://linear.app/example/issue/CONTENT-1");
  assert.deepEqual(byKey.p1.project, {
    id: "p1", stage: "editing", nextAction: "표지 문구 고르기", localNotes: "촬영본 02가 가장 좋음",
    resources: [{ role: "document", label: "대본", path: "/content/p1/script.md" }], reread: "reels get-project --project-id p1",
  });
  for (const input of Object.values(byKey)) assert.ok(Object.keys(input).length > 0, "never an empty input");
  assert.equal((await stat(path.join(new AutopilotStore(root).runDir(ticked.runId as string), "args.json"))).mode & 0o777, 0o600);
  // Long text is cut with a flag and keeps the source link.
  const long = workflowInput({ key: "k", kind: "candidate", source: "linear", title: "t", url: "https://linear.app/x/issue/A-1", identifier: "A-1", blockedBy: [], score: 0, reasons: [], description: "가".repeat(9000) });
  assert.equal(long.linear?.description?.length, 8000);
  assert.equal(long.linear?.descriptionTruncated, true);
  assert.equal(long.linear?.sourceUrl, "https://linear.app/x/issue/A-1");
});

// ---------------------------------------------------------------------------------------------
// C4: the worker really does the next step; results are told apart.

const evidenceOf = { changes: [{ path: "/content/p1/script.md", summary: "훅 3안으로 교체" }], verification: [{ check: "문서 링크 확인", result: "통과" }] };

test("C4a. progressed without changes or verification is a failure; prepared must have no changes", async () => {
  const items = wfItems(1);
  const ok = (extra: Record<string, unknown>) => runWorkflow({ runId: "r1", runDir: "/run", items }, wfOk(items, extra));
  const good = await ok({ status: "progressed", ...evidenceOf });
  assert.equal(good.result.passed, true);
  assert.equal(good.result.items[0].status, "progressed");
  for (const [name, extra] of [
    ["no changes", { status: "progressed", changes: [], verification: evidenceOf.verification }],
    ["no verification", { status: "progressed", changes: evidenceOf.changes, verification: [] }],
    ["incomplete change", { status: "progressed", changes: [{ path: "", summary: "x" }], verification: evidenceOf.verification }],
    ["unnamed check", { status: "progressed", changes: evidenceOf.changes, verification: [{ result: "ok" }] }],
    ["prepared with changes", { status: "prepared", changes: evidenceOf.changes, verification: [] }],
  ] as const) {
    const { result } = await ok(extra as Record<string, unknown>);
    assert.equal(result.passed, false, name);
    assert.deepEqual(result.items, [], name);
    assert.equal(result.incomplete, false, "a failed check is not an incomplete run");
  }
  assert.equal((await ok({ status: "needs_user" })).result.passed, true);
  assert.equal((await ok({ status: "blocked" })).result.passed, true, "blocked is a reported result; the executor turns it into a failure");
  assert.equal((await ok({ status: "done" })).result.passed, false, "unknown statuses fail");
  await assert.rejects(runWorkflow({ runId: "r1", runDir: "/run", items: [{ key: "k", title: "t", kind: "candidate", reasons: [] }] }, () => ({})), /no input text/);
});

test("C4b. real changes and a report-only preparation are kept apart through to today's item", async t => {
  const out = (items: unknown[]): RunOutput => ({ code: 0, stdout: JSON.stringify({ passed: true, items }), stderr: "" });
  const one = async (status: "progressed" | "prepared" | "needs_user") => {
    const outputs: (RunOutput | Error)[] = [];
    const a = await admitted(t, outputs, 1);
    const report = path.join(new AutopilotStore(a.root).runDir(a.runId), "linear_i1.md");
    await mkdir(path.dirname(report), { recursive: true });
    await writeFile(report, "# report\n");
    outputs.push(out([{ key: "linear:i1", status, summary: "s", reportPath: report, decision: "d", sources: ["/p/AGENTS.md"], changes: status === "progressed" ? evidenceOf.changes : [], verification: status === "progressed" ? evidenceOf.verification : [] }]));
    const done = (await execute(a.ctx, a.runId, a.deps)) as { passed: boolean };
    assert.equal(done.passed, true, status);
    const state = await states(a.root);
    const queue = buildQueue({ planning: await new PlanningStore(a.root).get(), projects: [], ledger: state.reservations, now, config: config() });
    return { reservation: state.reservations[0], text: renderToday("2026-11-16", pickToday(queue), queue), pick: pickToday(queue) };
  };
  const progressed = await one("progressed");
  assert.deepEqual([progressed.reservation.status, progressed.reservation.outcome, progressed.reservation.changes?.length], ["awaiting_review", "progressed", 1]);
  assert.match(progressed.text, /실제 변경을 수행/);
  assert.match(progressed.text, /script\.md: 훅 3안으로 교체/);
  const prepared = await one("prepared");
  assert.deepEqual([prepared.reservation.status, prepared.reservation.outcome, prepared.reservation.changes], ["awaiting_review", "prepared", undefined]);
  assert.match(prepared.text, /변경 없는 준비 보고/);
  assert.doesNotMatch(prepared.text, /수행한 변경/);
  const stopped = await one("needs_user");
  assert.equal(stopped.reservation.outcome, "needs_user");
  assert.match(stopped.pick?.decision ?? "", /근거 부족/);
  // The same result without evidence is a failure even if the workflow check was skipped.
  const bare = interpretRun(out([{ key: "k", status: "progressed", summary: "s", reportPath: "/runs/1/k.md", decision: "d", changes: [], verification: [] }]), [{ key: "k" }], "/runs/1");
  assert.deepEqual(bare.verdicts, [{ key: "k", status: "failed", reason: "progressed_without_evidence" }]);
  const lying = interpretRun(out([{ key: "k", status: "prepared", summary: "s", reportPath: "/runs/1/k.md", decision: "d", changes: evidenceOf.changes, verification: [] }]), [{ key: "k" }], "/runs/1");
  assert.deepEqual(lying.verdicts, [{ key: "k", status: "failed", reason: "prepared_with_changes" }]);
});

test("C4c. the worker prompt carries the forbidden list and the needs_user rule", async () => {
  const items = wfItems(1);
  const { calls } = await runWorkflow({ runId: "r1", runDir: "/run", items }, wfOk(items));
  const prompt = calls[0].prompt;
  for (const phrase of [
    "외부 게시·업로드·계정·결제·삭제", "원본 사진·영상 이동·삭제", "Linear·외부 서비스에 쓰기", "Dashboard 단계·게시 상태 변경", "Edits 앱 조작",
    "범위 밖 앱·회사 업무 저장소 조작", "git commit/push", "경험·취향·사실을 추정",
    "needs_user", "수정하지 않은 채", "입력 원문", "AGENTS.md", "reels get-project", "로컬 다음 작업 1단위", "변경 파일, 검증 근거, 남은 결정 1개",
  ]) assert.ok(prompt.includes(phrase), phrase);
  assert.ok(prompt.includes("Body 1"), "the item's input text is in the prompt");
});

test("C4d. without an execution.workdir nothing runs and automatic ticks stop with the reason", async t => {
  const root = await makeRoot(t);
  await setLinear(root, candidateIssues(2));
  const fake = fakeDeps({ outputs: [] });
  const ticked = await run(context(root), fake.deps);
  assert.equal(ticked.admitted, 2);
  const token = (await states(root)).reservations[0].token;
  const done = (await execute(context(root, { REELS_AUTOPILOT_RUN_TOKEN: token }), ticked.runId as string, fake.deps)) as { started: boolean; modelCalls: number; removed: { reason: string }[] };
  assert.deepEqual([done.started, done.modelCalls, done.removed.map(r => r.reason)], [false, 0, ["workdir_missing", "workdir_missing"]]);
  assert.equal(fake.models.length, 0);
  const state = await states(root);
  assert.equal(state.reservations.length, 0, "removed, so a later fix is not blocked by failed evidence");
  assert.match(state.paused?.reason ?? "", /^workdir_missing/);
  assert.equal((await run(context(root), fake.deps)).result, "paused");
  // A folder that does not exist is the same; a configured one is used as the working directory with edit permissions.
  const missing = await admitted(t, [], 1);
  await writeConfig(missing.root, { execution: { workdir: path.join(missing.root, "nope") } });
  assert.equal(((await execute(missing.ctx, missing.runId, missing.deps)) as { started: boolean }).started, false);
  const ready = await admitted(t, [{ code: 0, stdout: JSON.stringify({ passed: false, reason: "x" }), stderr: "" }], 1);
  await execute(ready.ctx, ready.runId, ready.deps);
  assert.equal(ready.models[0].cwd, ready.root);
  const argv = ready.models[0].args;
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.match(argv[argv.indexOf("--allowedTools") + 1], /^Workflow,Read,Edit,Write,/);
  assert.equal(argv[argv.indexOf("--add-dir") + 1], new AutopilotStore(ready.root).runDir(ready.runId));
  assert.ok(!argv.includes("--dangerously-skip-permissions"));
  assert.equal(autopilotConfigSchema.safeParse({ ...config(), execution: { workdir: "relative/path" } }).success, false);
  assert.equal(config().execution.workdir, undefined, "no personal path in the default");
});

// ---------------------------------------------------------------------------------------------
// C5: a live holder keeps its lock; reclaiming a dead lock cannot remove another taker's lock.

const lockFile = (root: string) => path.join(root, "autopilot", "lock");
const lockStore = (root: string, extra: Record<string, unknown> = {}) => new AutopilotStore(root, {
  now: () => now, isAlive: pid => pid === process.pid, processStart: pid => (pid === process.pid ? "T0" : undefined), ...extra,
});
async function seedLock(root: string, holder: Record<string, unknown>) {
  await mkdir(path.join(root, "autopilot"), { recursive: true });
  await writeFile(lockFile(root), JSON.stringify(holder));
}

test("C5a. a lock whose owner is alive is never taken back, however old", async t => {
  const root = await makeRoot(t);
  const old = { pid: process.pid, at: "2026-11-15T00:00:00.000Z", token: "owner", startedAt: "T0" };
  await seedLock(root, old);
  let ran = false;
  const result = await lockStore(root).withLock(async () => { ran = true; });
  assert.equal(result.busy, true);
  assert.equal(result.busy && result.held?.pid, process.pid);
  assert.ok((result.busy && result.held?.ageMs) as number > 28 * 3_600_000, "the age is reported");
  assert.equal(ran, false);
  assert.equal(await readFile(lockFile(root), "utf8"), JSON.stringify(old));
  // A tick reports it and does nothing.
  await setLinear(root, candidateIssues(2));
  const { deps, launches } = fakeDeps();
  const ticked = await run(context(root), deps);
  assert.equal(ticked.result, "busy");
  assert.match(ticked.reason as string, /^lock_held_alive: pid \d+가 \d+초/);
  assert.ok(((ticked.lockHeld as { ageSeconds: number }).ageSeconds) > 100_000);
  assert.equal(launches.length, 0);
  const view = (await status(context(root), deps)) as { lock: { alive: boolean; pid: number } };
  assert.deepEqual([view.lock.alive, view.lock.pid], [true, process.pid]);
});

test("C5b. a dead owner's lock, or one whose pid was reused, is taken back and nothing stale is left behind", async t => {
  for (const holder of [
    { pid: 99_999_999, at: now.toISOString(), token: "dead" },
    { pid: process.pid, at: now.toISOString(), token: "reused", startedAt: "an older process" },
    { pid: 99_999_998, at: "not a date", token: "odd" },
  ]) {
    const root = await makeRoot(t);
    await seedLock(root, holder);
    let ran = false;
    const result = await lockStore(root).withLock(async () => { ran = true; });
    assert.equal(result.busy, false, holder.token);
    assert.equal(ran, true, holder.token);
    assert.deepEqual((await readdir(path.join(root, "autopilot"))).sort(), []);
  }
  // An unreadable lock is left alone while it may still be being written, and taken back once it is old.
  const root = await makeRoot(t);
  await seedLock(root, {});
  await writeFile(lockFile(root), "{\"pid\":");
  assert.equal((await lockStore(root).withLock(async () => 1)).busy, true);
});

test("C5c. a contender that judged the lock dead too late does not delete the winner's fresh lock", async t => {
  const root = await makeRoot(t);
  await seedLock(root, { pid: 99_999_999, at: now.toISOString(), token: "dead" });
  let openGate!: () => void;
  const gate = new Promise<void>(resolve => { openGate = resolve; });
  let judged!: () => void;
  const bJudged = new Promise<void>(resolve => { judged = resolve; });
  const b = lockStore(root, { beforeReclaim: async () => { judged(); await gate; } });
  const loser = b.withLock(async () => "b ran");
  await bJudged; // b has read the dead lock and is about to take it back
  let aIn!: () => void;
  const aStarted = new Promise<void>(resolve => { aIn = resolve; });
  let finishA!: () => void;
  const hold = new Promise<void>(resolve => { finishA = resolve; });
  const winner = lockStore(root).withLock(async () => { aIn(); await hold; return "a ran"; });
  await aStarted;
  const winnersLock = await readFile(lockFile(root), "utf8");
  openGate();
  const lost = await loser;
  assert.equal(lost.busy, true, "the late contender backs off");
  assert.equal(await readFile(lockFile(root), "utf8"), winnersLock, "the winner's lock file is untouched");
  finishA();
  const won = await winner;
  assert.deepEqual(won.busy ? null : won.value, "a ran");
  assert.deepEqual(await readdir(path.join(root, "autopilot")), []);
});

test("C5d. two contenders reclaiming the same dead lock at the same moment leave exactly one owner at a time", async t => {
  const root = await makeRoot(t);
  await seedLock(root, { pid: 99_999_999, at: now.toISOString(), token: "dead" });
  let openGate!: () => void;
  const gate = new Promise<void>(resolve => { openGate = resolve; });
  let waiting = 0;
  const barrier = async () => { waiting++; await gate; };
  let inside = 0, peak = 0, ran = 0;
  const work = async () => { inside++; peak = Math.max(peak, inside); await new Promise(resolve => setTimeout(resolve, 40)); inside--; ran++; };
  const results = Promise.all([lockStore(root, { beforeReclaim: barrier }).withLock(work, 3000), lockStore(root, { beforeReclaim: barrier }).withLock(work, 3000)]);
  while (waiting < 2) await new Promise(resolve => setTimeout(resolve, 5));
  openGate();
  const [x, y] = await results;
  assert.equal(peak, 1, "never two owners at once");
  assert.deepEqual([x.busy, y.busy, ran], [false, false, 2]);
  assert.deepEqual(await readdir(path.join(root, "autopilot")), []);
});

test("C5e. release deletes only the lock that carries its own token", async t => {
  const root = await makeRoot(t);
  const other = JSON.stringify({ pid: process.pid, at: now.toISOString(), token: "someone-else" });
  const result = await lockStore(root).withLock(async () => { await writeFile(lockFile(root), other); });
  assert.equal(result.busy, false);
  assert.equal(await readFile(lockFile(root), "utf8"), other, "another token's lock stays");
  const mine = await makeRoot(t);
  await lockStore(mine).withLock(async () => {});
  await assert.rejects(stat(lockFile(mine)), "its own lock is removed");
});

// ---------------------------------------------------------------------------------------------
// G: first-round notes.

test("G1. limit words in a clean run never pause; only a failed run with a clear limit signal does", () => {
  const prepared = (summary: string) => JSON.stringify({ passed: true, items: [{ key: "k", status: "prepared", summary, reportPath: "/runs/1/k.md", decision: "d", changes: [] }] });
  const clean = interpretRun({ code: 0, stdout: prepared("quota notes"), stderr: "warn: quota almost used, retry 429 later" }, [{ key: "k" }], "/runs/1");
  assert.equal(clean.pause, null);
  assert.equal(clean.verdicts[0].status, "awaiting_review");
  const bare = interpretRun({ code: 1, stdout: "", stderr: "quota check 429 retry" }, [{ key: "k" }], "/runs/1");
  assert.equal(bare.pause, null, "bare words with a failed exit are not a limit signal");
  assert.equal(bare.verdicts[0].reason, "exit_1");
  for (const stderr of ["Claude AI usage limit reached", "Error: rate limit exceeded", "HTTP 429 Too Many Requests", "You've hit your limit", "사용량 한도에 도달했어요"]) {
    const hit = interpretRun({ code: 1, stdout: "", stderr }, [{ key: "k" }], "/runs/1");
    assert.equal(hit.pause, "limit_reached", stderr);
  }
  const notPassed = interpretRun({ code: 0, stdout: JSON.stringify({ passed: false, reason: "x" }), stderr: "usage limit reached" }, [{ key: "k" }], "/runs/1");
  assert.equal(notPassed.pause, "limit_reached", "passed:false together with a limit signal pauses");
});

test("G2. a dry run says what it could reserve, never that it did", async t => {
  const root = await makeRoot(t);
  await setLinear(root, candidateIssues(3));
  const { deps } = fakeDeps();
  const dry = await run(context(root), deps, true);
  assert.equal(dry.result, "admitted");
  assert.match(dry.reason as string, /예약할 수 있어요 3개/);
  assert.doesNotMatch(dry.reason as string, /예약했어요/);
  assert.equal(dry.wouldAdmit, 3);
});

// ---------------------------------------------------------------------------------------------
// Interfaces for the Linear refresh and the Dashboard card.

test("C6. computeAutopilotView gives one item or none and counts issues without a due date", () => {
  const planning = planningOf([issue(1, { state: "triage" }), startedIssue(2), issue(3), issue(4)]);
  const state = { ...emptyAutopilotState(), reservations: [mkRes("r", "linear:i3", { pid: process.pid })] };
  const view = computeAutopilotView({ planning, projects: [project("p1", "editing")], state, config: config(), now, probe: { isAlive: pid => pid === process.pid } });
  assert.deepEqual(view.counts, { active: 2, review: 1, candidates: 2, occupancy: 1, runningReservations: 1, autoSlots: 1 });
  assert.equal(view.today?.kind, "review");
  assert.equal(view.freshness.ok, true);
  assert.equal(view.enabled, true);
  const empty = computeAutopilotView({ planning: emptyPlanning(), projects: [], state: emptyAutopilotState(), config: config(), now, probe: () => false });
  assert.equal(empty.today, null);
  assert.equal(empty.freshness.ok, false);
  assert.equal(empty.counts.autoSlots, 0, "no automatic slots without a fresh copy");
  // A dead runner is previewed as reclaimed, not counted.
  const dead = computeAutopilotView({ planning, projects: [], state, config: config(), now, probe: () => false });
  assert.equal(dead.counts.runningReservations, 0);
});

test("C7. a refresh hook before the gate: a failure means zero automatic runs and a kept reason, a success goes on", async t => {
  const root = await makeRoot(t);
  await setLinear(root, candidateIssues(2), "2026-11-16T01:00:00Z"); // stale
  const calls: string[] = [];
  const failing = fakeDeps();
  failing.deps.refreshPlanning = async () => { calls.push("fail"); return { ok: false, reason: "linear_auth_missing" }; };
  const blocked = await run(context(root), failing.deps);
  assert.equal(blocked.result, "freshness");
  assert.equal(blocked.admitted, 0);
  assert.match(blocked.reason as string, /linear_auth_missing/);
  assert.equal(failing.launches.length, 0);
  assert.match((await states(root)).lastTick?.reason ?? "", /linear_auth_missing/);
  const thrown = fakeDeps();
  thrown.deps.refreshPlanning = async () => { throw new Error("network down"); };
  assert.match(((await run(context(root), thrown.deps)).reason as string), /refresh_error \(network down\)/);
  const working = fakeDeps();
  working.deps.refreshPlanning = async () => { calls.push("ok"); await setLinear(root, candidateIssues(2), "2026-11-16T04:50:00Z"); return { ok: true, refreshed: true }; };
  const done = await run(context(root), working.deps);
  assert.equal(done.admitted, 2);
  // A dry run does not refresh.
  const dryDeps = fakeDeps();
  dryDeps.deps.refreshPlanning = async () => { calls.push("dry"); return { ok: true, refreshed: false }; };
  await run(context(root), dryDeps.deps, true);
  assert.deepEqual(calls, ["fail", "ok"]);
});

// ---------------------------------------------------------------------------------------------
// H: manual batches over three items, and the outer prompt.

const argsLine = (prompt: string) => {
  const lines = prompt.split("\n");
  return lines[lines.indexOf("<args-json>") + 1];
};

test("H1. a manual batch of five becomes runs of 3 and 2, each reserved and started, and the Workflow limit is never hit", async t => {
  const root = await makeRoot(t);
  await setLinear(root, [...reviewIssues(3), ...candidateIssues(5)]);
  await writeConfig(root, { execution: { workdir: root } });
  const fake = fakeDeps({ outputs: [] });
  const refs = [1, 2, 3, 4, 5].map(n => `linear:i${n}`);
  const result = (await runManual(context(root), refs, fake.deps)) as { runs: { runId: string; keys: string[]; pid?: number }[]; modelCalls: number; admitted: { key: string }[] };
  assert.equal(fake.launches.length, 2, "one executor per run");
  assert.deepEqual(result.runs.map(r => r.keys.length), [3, 2]);
  assert.deepEqual(result.admitted.map(a => a.key), refs, "all five are reserved and requested");
  assert.equal(result.modelCalls, 5);
  assert.equal(new Set(result.runs.map(r => r.runId)).size, 2, "separate run ids");
  const reservations = (await states(root)).reservations;
  assert.equal(reservations.length, 5);
  assert.ok(reservations.every(r => r.mode === "manual" && r.status === "running"));
  assert.equal(new Set(reservations.map(r => r.token)).size, 2, "a token per run");
  assert.deepEqual(fake.launches.map(l => l.runId), result.runs.map(r => r.runId));
  // Each executor takes only its own run and hands the Workflow at most three items.
  for (const run of result.runs) {
    const token = reservations.find(r => r.runId === run.runId)!.token;
    const done = (await execute(context(root, { REELS_AUTOPILOT_RUN_TOKEN: token }), run.runId, fake.deps)) as { started: boolean; modelCalls: number };
    assert.deepEqual([done.started, done.modelCalls], [true, run.keys.length]);
    const args = JSON.parse(await readFile(path.join(new AutopilotStore(root).runDir(run.runId), "args.json"), "utf8")) as { runId: string; runDir: string; items: { key: string; kind: string; reasons: string[] }[] };
    assert.deepEqual(args.items.map(i => i.key), run.keys);
    const safe = (key: string) => key.replace(/[^A-Za-z0-9_-]/g, "_");
    const flow = await runWorkflow(args, (_p, _o, index) => ({
      key: args.items[index].key, status: "prepared", summary: "s", reportPath: `${args.runDir}/${safe(args.items[index].key)}.md`, decision: "d", sources: [], changes: [], verification: [],
    }));
    assert.equal(flow.result.passed, true, "no MAX_ITEMS error");
  }
  assert.equal(fake.models.length, 2);
  // Four and one: also split; one run for three or fewer is unchanged.
  const small = await makeRoot(t);
  await setLinear(small, candidateIssues(4));
  const s = fakeDeps();
  const four = (await runManual(context(small), ["linear:i1", "linear:i2", "linear:i3", "linear:i4"], s.deps)) as { runs: unknown[] };
  assert.equal(four.runs.length, 2);
  const three = await makeRoot(t);
  await setLinear(three, candidateIssues(3));
  const th = fakeDeps();
  assert.equal(((await runManual(context(three), ["linear:i1", "linear:i2", "linear:i3"], th.deps)) as { runs: unknown[] }).runs.length, 1);
  // Automatic admission is untouched: three slots, one run.
  const auto = await makeRoot(t);
  await setLinear(auto, candidateIssues(5));
  const a = fakeDeps();
  assert.equal((await run(context(auto), a.deps)).admitted, 3);
  assert.equal(a.launches.length, 1);
});

test("H1b. a failed spawn of one run fails only its reservations; the other run still starts", async t => {
  const root = await makeRoot(t);
  await setLinear(root, candidateIssues(5));
  const fake = fakeDeps();
  const launch = fake.deps.launch;
  let count = 0;
  fake.deps.launch = async r => { if (++count === 2) throw new Error("spawn ENOENT"); return launch(r); };
  const result = (await runManual(context(root), [1, 2, 3, 4, 5].map(n => `linear:i${n}`), fake.deps)) as { runs: { failure?: string }[]; admitted: unknown[] };
  assert.deepEqual(result.runs.map(r => Boolean(r.failure)), [false, true]);
  assert.equal(result.admitted.length, 3, "only the started run is reported as admitted");
  assert.deepEqual((await states(root)).reservations.map(r => r.status), ["running", "running", "running", "failed", "failed"]);
});

test("H2. the outer prompt carries the Workflow args as JSON itself and allows no file read", async t => {
  const root = await makeRoot(t);
  await setLinear(root, [issue(1, { description: "원문 설명 하나" }), issue(2)]);
  await writeConfig(root, { execution: { workdir: root } });
  const fake = fakeDeps({ outputs: [] });
  const ticked = await run(context(root), fake.deps);
  const token = (await states(root)).reservations[0].token;
  await execute(context(root, { REELS_AUTOPILOT_RUN_TOKEN: token }), ticked.runId as string, fake.deps);
  const prompt = fake.models[0].input;
  const dir = new AutopilotStore(root).runDir(ticked.runId as string);
  const fromFile = JSON.parse(await readFile(path.join(dir, "args.json"), "utf8"));
  const inPrompt = JSON.parse(argsLine(prompt));
  assert.deepEqual(inPrompt, fromFile, "the args in the prompt are exactly what was recorded");
  assert.equal(inPrompt.runDir, dir);
  assert.equal(inPrompt.items.length, 2);
  assert.match(inPrompt.items[0].input.linear.description ?? inPrompt.items[1].input.linear.description, /원문 설명 하나/);
  assert.match(prompt, /name: afterwork-autopilot/);
  assert.match(prompt, /Workflow 도구 한 번 외에는 어떤 도구도 쓰지 않고/);
  // Nothing tells the model to open a file it is not allowed to read.
  assert.doesNotMatch(prompt, /args\.json/);
  assert.doesNotMatch(prompt, /파일의 JSON 내용|파일을 읽어|Read 도구로/);
  assert.match(prompt, /파일을 읽을 필요가 없다/);
  // A description with quotes, newlines and a code fence still round-trips.
  const tricky = outerPrompt({ runId: "r", runDir: "/x", items: [{ key: "k", input: { linear: { description: 'a "b"\n```\n</args-json>' } } }] });
  assert.equal(JSON.parse(argsLine(tricky)).items[0].input.linear.description, 'a "b"\n```\n</args-json>');
});

test("H2b. past the size limit, long descriptions go to run files the worker reads, and the prompt says where", async t => {
  const root = await makeRoot(t);
  const big = (n: number) => "나".repeat(5000) + ` 끝${n}`;
  await setLinear(root, [1, 2, 3].map(n => issue(n, { description: big(n) })));
  await writeConfig(root, { execution: { workdir: root } });
  const fake = fakeDeps({ outputs: [] });
  const ticked = await run(context(root), fake.deps);
  const token = (await states(root)).reservations[0].token;
  await execute(context(root, { REELS_AUTOPILOT_RUN_TOKEN: token }), ticked.runId as string, fake.deps);
  const dir = new AutopilotStore(root).runDir(ticked.runId as string);
  const inPrompt = JSON.parse(argsLine(fake.models[0].input)) as { items: { key: string; input: { linear: { description: string; descriptionPath: string } } }[] };
  assert.ok(argsLine(fake.models[0].input).length < 12_000, "the prompt stays small");
  for (const item of inPrompt.items) {
    const { description, descriptionPath } = item.input.linear;
    assert.ok(descriptionPath.startsWith(`${dir}/input-`), descriptionPath);
    assert.ok(description.length < 600, "only a preview inline");
    const full = await readFile(descriptionPath, "utf8");
    assert.ok(full.length > 5000 && full.includes("끝"), "the whole text is in the file");
    assert.equal((await stat(descriptionPath)).mode & 0o777, 0o600);
  }
  // The registered worker prompt allows exactly that Read.
  const items = wfItems(1).map(item => ({ ...item, input: { linear: { identifier: "A-1", description: "preview", descriptionPath: `${dir}/input-x.md` } } }));
  const { calls } = await runWorkflow({ runId: "r1", runDir: dir, items }, wfOk(items));
  assert.match(calls[0].prompt, /descriptionPath가 있으면[\s\S]*Read 도구로[\s\S]*이 Read는 허용된다/);
  assert.ok(calls[0].prompt.includes(`${dir}/input-x.md`));
  // Short inputs are left alone.
  const short = await spillLongInput([{ key: "k", input: { linear: { description: "x".repeat(2000) } } }], dir, { runId: "r" });
  assert.equal((short[0].input.linear as { descriptionPath?: string }).descriptionPath, undefined);
});

test("open Linear issues do not bring back a Dashboard project that is done, complete or only scheduled", () => {
  const projects = [
    project("p-done", "done", { publications: [{ channel: "naver-clip", status: "draft", url: "" }] }),
    project("p-sched", "review", { publications: [{ channel: "youtube", status: "scheduled", url: "", scheduledAt: "2026-11-20T15:56:00+09:00" }] }),
    project("p-live", "published", { publications: [{ channel: "blog", status: "published", url: "", publishedAt: "2026-11-13" }] }),
    project("p-open", "published", { publications: [{ channel: "blog", status: "draft", url: "" }] }),
  ];
  const issues = [
    issue(1, { projectId: "p-done", state: "triage" }),
    issue(2, { projectId: "p-sched", state: "started" }),
    issue(3, { projectId: "p-live", state: "unstarted" }),
    issue(4, { projectId: "p-open", state: "started" }),
  ];
  const queue = buildQueue({ planning: planningOf(issues), projects, ledger: [], now, config: config() });
  const keys = [...queue.review, ...queue.active, ...queue.candidates].map((i) => i.key).sort();
  assert.deepEqual(keys, ["p-open"]);
  assert.equal(queue.review.find((i) => i.key === "p-open")?.kind, "review", "a draft channel waits for a person");
});
