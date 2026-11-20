import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  admission, buildQueue, buildReviewInbox, defaultAutopilotConfig, pickToday, type Reservation,
} from "../../src/shared/autopilot";
import { emptyPlanning, linearImportSchema, type Planning } from "../../src/shared/planning";
import type { Project, Stage } from "../../src/shared/contracts";
import { AutopilotStore } from "../../src/shared/lib/autopilot-store";
import { autopilotCommand, resolveKey, type AutopilotContext, type AutopilotDeps, type CommandScope } from "../../src/app/cli/autopilot";
import { run as runCli } from "../../src/app/cli/run";

// Synthetic fixtures only: no production profile, no copy of real items.
const now = new Date("2026-11-16T05:00:00Z"); // Monday 14:00 KST
const window = { from: "2026-11-09", to: "2026-11-23" };
const syncedAt = "2026-11-16T04:30:00Z";
type Issue = ReturnType<typeof linearImportSchema.parse>["issues"][number];
const issue = (n: number, extra: Partial<Issue> = {}): Issue => ({
  id: `i${n}`, identifier: `CONTENT-${n}`, title: `Synthetic issue ${n}`, url: `https://linear.app/example/issue/CONTENT-${n}`,
  dueDate: null, state: "unstarted", ...extra,
});
const linear = (issues: Issue[], at = syncedAt) => linearImportSchema.parse({ url: "https://linear.app/example/team/CONTENT/all", syncedAt: at, window, issues });
const planningOf = (issues: Issue[], at = syncedAt): Planning => ({ ...emptyPlanning(), linear: linear(issues, at) });
const project = (id: string, stage: Stage, extra: Partial<Project> = {}): Project => ({
  id, title: `Synthetic project ${id}`, date: "2026-11-10", nextAction: "", stage, publicURL: "", shared: false, ...extra,
});
const res = (id: string, key: string, extra: Partial<Reservation> = {}): Reservation => ({
  id, key, mode: "auto", status: "awaiting_review", token: "tok", createdAt: "2026-11-16T03:00:00.000Z",
  leaseUntil: "2026-11-16T09:00:00.000Z", evidenceFingerprint: "e", ...extra,
});
const config = (maxSlots = 3) => ({ ...defaultAutopilotConfig(), maxSlots });
const inboxOf = (planning: Planning, projects: Project[], ledger: Reservation[] = [], maxSlots = 3) =>
  buildReviewInbox({ planning, projects, ledger, now, config: config(maxSlots) });
const queueOf = (planning: Planning, projects: Project[], ledger: Reservation[] = []) =>
  buildQueue({ planning, projects, ledger, now, config: config() });
const kinds = (sources: { kind: string; contributesReview: boolean }[]) => sources.map(s => `${s.kind}:${s.contributesReview}`);

test("inbox 1. an empty queue or one with only active items lists nothing, while today still picks the active item", () => {
  const empty = inboxOf(emptyPlanning(), []);
  assert.deepEqual(empty.items, []);
  assert.equal(empty.summary.reviewCount, 0);
  assert.equal(empty.summary.needToFree, 0);
  assert.equal(empty.version, 1);
  assert.equal(empty.readOnly, true);
  assert.match(empty.text, /리뷰 대기 항목 없음/);
  const planning = planningOf([issue(1, { state: "started", stateName: "In Progress" })]);
  const projects = [project("p1", "editing", { nextAction: "표지 고르기" })];
  const activeOnly = inboxOf(planning, projects);
  assert.deepEqual(activeOnly.items, []);
  assert.equal(pickToday(queueOf(planning, projects))?.kind, "active", "today keeps its own active pick; the inbox does not borrow it");
});

test("inbox 2. several reviews keep the queue's order, keys and count, and the first is today's item", () => {
  const planning = planningOf([
    issue(1, { state: "triage", dueDate: "2026-11-15" }),
    issue(2, { state: "started", stateName: "In Review", priority: 1 }),
    issue(3, { state: "unstarted" }),
    issue(4, { state: "backlog", stateName: "Inbox" }),
    issue(5, { state: "started", stateName: "In Progress", projectId: "p9" }),
  ]);
  const projects = [project("p1", "review"), project("p2", "published", { publications: [{ channel: "blog", status: "draft", url: "" }] }), project("p9", "editing")];
  const ledger = [res("r1", "linear:i3", { outcome: "prepared", reportPath: "/runs/a/r.md" })];
  const queue = queueOf(planning, projects, ledger);
  const inbox = inboxOf(planning, projects, ledger);
  assert.equal(inbox.items.length, 6);
  assert.deepEqual(inbox.items.map(i => i.key), queue.review.map(i => i.key));
  assert.deepEqual(inbox.items.map(i => i.rank), [1, 2, 3, 4, 5, 6]);
  assert.equal(inbox.items[0].key, pickToday(queue)?.key);
  const today = pickToday(queue)!;
  assert.deepEqual([inbox.items[0].decision, inbox.items[0].doneWhen, inbox.items[0].target, inbox.items[0].why], [today.decision, today.doneWhen, today.target, today.why]);
  assert.equal(inbox.summary.occupancy, queue.occupancy);
  assert.equal(inbox.items.every(i => i.sources.some(s => s.contributesReview)), true, "every listed item names what holds it");
});

test("inbox 3. a Dashboard review, a Dashboard channel still owed and a Linear review alone cannot be resolved locally", () => {
  const stage = inboxOf(emptyPlanning(), [project("p1", "review")]).items[0];
  assert.deepEqual(kinds(stage.sources), ["dashboard:true"]);
  assert.equal(stage.sources[0].ref, "project:p1");
  assert.match(stage.sources[0].closeBy ?? "", /review 밖으로/);
  assert.equal(stage.resolution.localResolveAvailable, false);
  assert.deepEqual(stage.resolution.reservationIds, []);
  assert.equal(stage.resolution.afterLocalResolve.stillInReview, true);
  assert.deepEqual(stage.resolution.afterLocalResolve.remainingReviewSources, [{ kind: "dashboard", ref: "project:p1" }]);

  const channel = inboxOf(emptyPlanning(), [project("p2", "published", { publications: [{ channel: "blog", status: "draft", url: "" }] })]).items[0];
  assert.deepEqual(kinds(channel.sources), ["dashboard:true"]);
  assert.match(channel.sources[0].reason, /채널 남음/);
  assert.match(channel.sources[0].closeBy ?? "", /게시하고 Dashboard 채널 상태/);
  assert.equal(channel.resolution.localResolveAvailable, false);

  const named = inboxOf(planningOf([issue(7, { state: "started", stateName: "In Review" })]), []).items[0];
  assert.deepEqual(kinds(named.sources), ["linear:true"]);
  assert.equal(named.sources[0].ref, "CONTENT-7");
  assert.match(named.sources[0].reason, /검토·Inbox 이름/);
  assert.match(named.sources[0].closeBy ?? "", /Linear에서 CONTENT-7/);
  assert.equal(named.resolution.localResolveAvailable, false);
  const triage = inboxOf(planningOf([issue(8, { state: "triage" })]), []).items[0];
  assert.match(triage.sources[0].reason, /triage/);
});

test("inbox 4. a reservation alone can be resolved and leaves review, computed in memory without touching the input", () => {
  const planning = planningOf([issue(1)]);
  const ledger = [res("r1", "linear:i1", { outcome: "prepared", reportPath: "/runs/a/r1.md" })];
  const before = structuredClone(ledger);
  const inbox = inboxOf(planning, [], ledger);
  const [item] = inbox.items;
  assert.deepEqual(kinds(item.sources), ["linear:false", "reservation:true"]);
  assert.equal(item.resolution.localResolveAvailable, true);
  assert.deepEqual(item.resolution.reservationIds, ["r1"]);
  assert.deepEqual(item.resolution.afterLocalResolve, { stillInReview: false, remainingReviewSources: [], occupancyAfter: 0 });
  assert.deepEqual(ledger, before, "the ledger passed in is not changed");
  assert.match(inbox.text, /resolve하면 리뷰에서 빠짐/);
});

test("inbox 5. a reservation on top of a Dashboard or Linear review leaves that review and frees no slot", () => {
  const dash = inboxOf(emptyPlanning(), [project("p1", "review")], [res("r1", "p1", { outcome: "progressed", changes: [{ path: "/c/a.md", summary: "s" }] })]);
  const [d] = dash.items;
  assert.deepEqual(kinds(d.sources), ["dashboard:true", "reservation:true"]);
  assert.equal(d.resolution.localResolveAvailable, true);
  assert.equal(d.resolution.afterLocalResolve.stillInReview, true);
  assert.deepEqual(d.resolution.afterLocalResolve.remainingReviewSources, [{ kind: "dashboard", ref: "project:p1" }]);
  assert.equal(d.resolution.afterLocalResolve.occupancyAfter, dash.summary.occupancy);
  assert.equal(dash.summary.freedByResolveAll, 0);
  assert.match(d.doneWhen, /Linear\/Dashboard도 검토 대기면/, "today's wording no longer says resolve alone closes it");
  assert.match(dash.text, /resolve 뒤에도 남음: Dashboard/);

  const lin = inboxOf(planningOf([issue(2, { state: "started", stateName: "In Review" })]), [], [res("r2", "linear:i2")]);
  const [l] = lin.items;
  assert.deepEqual(kinds(l.sources), ["linear:true", "reservation:true"]);
  assert.deepEqual(l.resolution.afterLocalResolve.remainingReviewSources, [{ kind: "linear", ref: "CONTENT-2" }]);
  assert.equal(l.resolution.afterLocalResolve.stillInReview, true);
  assert.equal(lin.summary.freedByResolveAll, 0);
});

test("inbox 6. one key from both sources counts once, and only the source that is really in review is marked", () => {
  const linearReview = inboxOf(planningOf([issue(3, { state: "started", stateName: "In Review", projectId: "p3" })]), [project("p3", "editing")]);
  assert.equal(linearReview.items.length, 1);
  assert.equal(linearReview.items[0].key, "p3");
  assert.deepEqual(kinds(linearReview.items[0].sources), ["dashboard:false", "linear:true"]);
  const dashReview = inboxOf(planningOf([issue(4, { state: "started", stateName: "In Progress", projectId: "p4" })]), [project("p4", "review")]);
  assert.equal(dashReview.items.length, 1);
  assert.deepEqual(kinds(dashReview.items[0].sources), ["dashboard:true", "linear:false"]);
  assert.deepEqual(dashReview.items[0].resolution.afterLocalResolve.remainingReviewSources, [{ kind: "dashboard", ref: "project:p4" }]);
});

test("inbox 7. a complete or fully scheduled linked project hides its open Linear issue; a left-over reservation still shows", () => {
  const projects = [
    project("p-done", "done"),
    project("p-sched", "review", { publications: [{ channel: "youtube", status: "scheduled", url: "", scheduledAt: "2026-11-20T15:56:00+09:00" }] }),
  ];
  const planning = planningOf([
    issue(1, { projectId: "p-done", state: "triage", createdAt: "2026-09-01T00:00:00Z" }),
    issue(2, { projectId: "p-sched", state: "started", stateName: "In Review" }),
  ]);
  assert.deepEqual(inboxOf(planning, projects).items, []);
  assert.deepEqual(queueOf(planning, projects).review, []);
  const kept = inboxOf(planning, projects, [res("r1", "p-done")]);
  assert.deepEqual(kept.items.map(i => i.key), queueOf(planning, projects, [res("r1", "p-done")]).review.map(i => i.key));
  assert.deepEqual(kinds(kept.items[0].sources), ["dashboard:false", "linear:false", "reservation:true"]);
  assert.match(kept.items[0].sources[0].reason, /완료/);
  assert.equal(kept.items[0].resolution.afterLocalResolve.stillInReview, false);
  assert.match(kept.items[0].doneWhen, /원천 항목은 이미 큐에 없음/);
  // A reservation whose source left the copy says the record is missing instead of dropping it.
  const gone = inboxOf(planningOf([]), [], [res("r2", "linear:i42")]).items[0];
  assert.deepEqual(gone.sources.map(s => [s.kind, s.present]), [["linear", false], ["reservation", true]]);
});

test("inbox 8. several awaiting reservations on one key are what resolve closes; running ones are not", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inbox-resolve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ledger = [
    res("r1", "linear:i1", { outcome: "prepared" }),
    res("r2", "linear:i1", { outcome: "needs_user" }),
    res("r3", "linear:i1", { status: "running", pid: process.pid, processStartedAt: "T0" }),
    res("r4", "linear:i1", { status: "done" }),
    res("r5", "linear:i2"),
  ];
  const planning = planningOf([issue(1), issue(2)]);
  const inbox = inboxOf(planning, [], ledger);
  const item = inbox.items.find(i => i.key === "linear:i1")!;
  assert.deepEqual(item.resolution.reservationIds, ["r1", "r2"]);
  assert.equal(inbox.summary.runningReservations, 1);
  // The real command on the same ledger closes exactly those.
  const store = new AutopilotStore(root);
  await store.writeState({ schemaVersion: 1, lastTick: null, paused: null, reservations: ledger, order: null, previousOrder: null });
  const deps = { now: () => now, isAlive: () => true, processStart: () => "T0" } as unknown as AutopilotDeps;
  await resolveKey({ root, env: {} }, "linear:i1", deps);
  const after = await store.readState();
  assert.deepEqual(after.reservations.filter(r => r.status === "done" && r.reason === "resolved").map(r => r.id), item.resolution.reservationIds);
  assert.equal(after.reservations.find(r => r.id === "r3")?.status, "running");
  assert.equal(item.resolution.afterLocalResolve.stillInReview, false);
});

test("inbox 9. only a needs_user result is a fact question; progressed and prepared stay unclassified", () => {
  const planning = planningOf([issue(1), issue(2), issue(3)]);
  const ledger = [
    res("r1", "linear:i1", { outcome: "needs_user", reportPath: "/runs/a/1.md" }),
    res("r2", "linear:i2", { outcome: "progressed", reportPath: "/runs/a/2.md", changes: [{ path: "/c/a.md", summary: "x" }, { path: "/c/b.md", summary: "y" }] }),
    res("r3", "linear:i3", { outcome: "prepared", reportPath: "/runs/a/3.md" }),
  ];
  const inbox = inboxOf(planning, [], ledger);
  const by = (key: string) => inbox.items.find(i => i.key === key)!;
  assert.equal(by("linear:i1").decisionAssessment.kind, "needs_user_fact");
  assert.match(by("linear:i1").decisionAssessment.basis, /r1/);
  assert.equal(by("linear:i2").decisionAssessment.kind, "unclassified_review");
  assert.equal(by("linear:i3").decisionAssessment.kind, "unclassified_review");
  assert.deepEqual(by("linear:i2").evidence, [{ reservationId: "r2", outcome: "progressed", changeCount: 2, hasReport: true }]);
  assert.equal(JSON.stringify(inbox.items).includes("/runs/a/"), false, "no report path or change path in the inbox");
  assert.equal(JSON.stringify(inbox.items).includes("/c/a.md"), false);
  assert.match(inbox.text, /\[사실 입력 필요\]/);
  assert.equal(inbox.items.some(i => (i.decisionAssessment.kind as string) === "no_user_decision"), false);
});

test("inbox 10. the summary follows admission: occupancy 7 and limit 3 need 5 to leave, and resolve counts are exact", () => {
  const seven = planningOf(Array.from({ length: 7 }, (_, i) => issue(100 + i, { state: "triage" })));
  const idle = inboxOf(seven, []);
  assert.deepEqual([idle.summary.occupancy, idle.summary.maxSlots, idle.summary.runningReservations, idle.summary.needToFree], [7, 3, 0, 5]);
  const fits = (occupancy: number, running: number) => admission({ occupancy, runningReservations: running, mode: "auto", maxSlots: 3 }) > 0;
  assert.equal(fits(7 - 5, 0) && !fits(7 - 4, 0), true, "needToFree is the least that admission accepts");
  const oneRunning = inboxOf(seven, [], [res("run", "linear:i1", { status: "running", pid: process.pid })]);
  assert.equal(oneRunning.summary.needToFree, 6);
  const full = inboxOf(seven, [], ["a", "b", "c"].map(id => res(id, `linear:x${id}`, { status: "running", pid: process.pid })));
  assert.equal(full.summary.needToFree, null);
  assert.match(full.text, /실행 중 예약만으로 한도가 차서/);
  assert.equal(inboxOf(seven, [], [], 2).summary.maxSlots, 2);
  // Two resolvable items: one only a reservation, one also a Dashboard review.
  const mixed = inboxOf(planningOf([issue(1)]), [project("p1", "review")], [res("r1", "linear:i1"), res("r2", "p1")]);
  assert.deepEqual([mixed.summary.resolvableNow, mixed.summary.freedByResolveAll], [2, 1]);
});

test("inbox 11. a stale or missing Linear copy is reported, not hidden as an empty queue", () => {
  const stale = inboxOf(planningOf([issue(1, { state: "triage" })], "2026-11-15T20:00:00Z"), []);
  assert.equal(stale.summary.freshness.ok, false);
  assert.equal(stale.summary.freshness.ok === false && stale.summary.freshness.reason, "linear_stale");
  assert.equal(stale.items.length, 1, "the stored copy is still listed");
  assert.match(stale.text, /최신성 미확인/);
  const missing = inboxOf(emptyPlanning(), [project("p1", "review")]);
  assert.equal(missing.summary.freshness.ok === false && missing.summary.freshness.reason, "linear_missing");
  assert.equal(missing.items.length, 1);
  assert.match(missing.text, /최신성 미확인/);
});

// ---------------------------------------------------------------------------------------------
// CLI: one JSON document, read-only, no side effects.

async function makeRoot(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "inbox-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function snapshot(dir: string): Promise<Record<string, { mtimeMs: number; content: string }>> {
  const out: Record<string, { mtimeMs: number; content: string }> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, file)] = { mtimeMs: (await stat(file)).mtimeMs, content: await readFile(file, "utf8") };
  }
  return out;
}
async function profile(root: string, title: string, nextAction: string) {
  await mkdir(path.join(root, "autopilot"), { recursive: true });
  const wallClock = new Date();
  const day = (offset: number) => new Date(wallClock.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  await writeFile(path.join(root, "planning.json"), JSON.stringify({
    ...emptyPlanning(),
    linear: linearImportSchema.parse({ url: "https://linear.app/example/team/CONTENT/all", syncedAt: wallClock.toISOString(), window: { from: day(-1), to: day(2) }, issues: [issue(1, { state: "triage" }), issue(2)] }),
  }));
  await writeFile(path.join(root, "dashboard.json"), JSON.stringify({ schemaVersion: 1, updatedAt: "2026-11-16T00:00:00.000Z", projects: [project("p1", "review", { title, nextAction })] }));
  await writeFile(path.join(root, "autopilot", "state.json"), JSON.stringify({
    schemaVersion: 1, lastTick: null, paused: null, order: null, previousOrder: null,
    reservations: [res("r1", "linear:i2", { reportPath: path.join(root, "autopilot", "runs", "x", "r1.md"), outcome: "prepared" }), res("dead", "linear:i9", { status: "running", pid: 2_147_483_000 })],
  }));
  await writeFile(path.join(root, "autopilot", "today.md"), "# 오늘 볼 1개 - 2026-11-15\n");
  await writeFile(path.join(root, "autopilot", "lock"), JSON.stringify({ pid: 2_147_483_000, at: "2026-11-16T00:00:00.000Z", token: "old" }));
}
const cli = async (root: string, args: string[]) => {
  let out = "";
  const code = await runCli(args, { stdin: () => Readable.from([]), stdout: text => { out += text; }, stderr: () => {}, env: { REELS_USER_DATA: root }, cwd: () => root });
  return { code, out };
};

test("inbox 12. the CLI prints one JSON document, writes nothing and runs nothing a title says", async t => {
  const root = await makeRoot(t);
  const marker = path.join(root, "pwned");
  const title = `첫 줄\n둘째 줄 $(touch ${marker}) \`touch ${marker}\`; reels autopilot resolve p1`;
  await profile(root, title, "/Users/example/private/notes.md 를 열어 표지 확인");
  const before = await snapshot(root);
  await new Promise(resolve => setTimeout(resolve, 20));
  const { code, out } = await cli(root, ["autopilot", "inbox"]);
  assert.equal(code, 0);
  assert.equal(out.trim().split("\n").length >= 1 && JSON.parse(out).ok, true, "one JSON document");
  const data = JSON.parse(out).data;
  assert.equal(data.readOnly, true);
  assert.equal(data.version, 1);
  assert.deepEqual(data.items.map((i: { key: string }) => i.key).sort(), ["linear:i1", "linear:i2", "p1"]);
  assert.deepEqual(data.reservationPreview, { inMemoryOnly: true, reclaimed: ["dead"], leaseExpiredAlive: [] });
  assert.deepEqual(await snapshot(root), before, "state.json, today.md, lock, config and sources keep content and mtime; no new file");
  await assert.rejects(stat(marker), "nothing in a title runs");
  assert.equal(data.text.includes(root), false, "no profile path in the text");
  assert.doesNotMatch(data.text, /\/Users\/|\/runs\//);
  assert.match(data.text, /첫 줄 둘째 줄/, "a title stays on one line");
  assert.match(data.text, /<경로>/);
  for (const line of data.text.split("\n")) assert.equal(/^\s*(\d+\.|닫기:|리뷰|자동|로컬|Linear)/.test(line), true, line);
  assert.equal(JSON.stringify(data).includes(path.join(root, "autopilot", "runs")), false, "no report path anywhere");
  // Help, usage and completion know the command; extra arguments are a usage error.
  const help = JSON.parse((await cli(root, ["help", "autopilot"])).out).data.help;
  assert.match(help, /inbox\s+Every review item/);
  assert.match(help, /<status\|inbox\|tick/);
  const completion = await cli(root, ["completion", "zsh"]);
  assert.equal(completion.code, 0);
  assert.match(completion.out, /\binbox\b/);
  const extra = await cli(root, ["autopilot", "inbox", "p1"]);
  assert.equal(extra.code, 2);
  assert.deepEqual(await snapshot(root), before);
});

test("inbox 12b. no Keychain, network, model or launch is reached, and the scope is read-only", async t => {
  const root = await makeRoot(t);
  await profile(root, "t", "");
  const calls: string[] = [];
  const refuse = (name: string) => (..._: unknown[]) => { calls.push(name); throw new Error(`${name} must not be called`); };
  const deps = {
    now: () => now, isAlive: () => false, processStart: () => undefined, newId: refuse("newId"),
    launch: refuse("launch"), runModel: refuse("runModel"), refreshPlanning: refuse("refreshPlanning"),
    linear: { runner: refuse("keychain"), fetch: refuse("fetch") },
  } as unknown as AutopilotDeps;
  const scope: CommandScope = {};
  const ctx: AutopilotContext = { root, env: { REELS_USER_DATA: root } };
  const { data } = await autopilotCommand(["inbox"], ctx, scope, deps) as { data: { items: unknown[] } };
  assert.equal(scope.readOnly, true);
  assert.deepEqual(calls, []);
  assert.ok(data.items.length > 0);
});

test("inbox 12c. an unreadable state, Linear copy or Dashboard file is an error, never an empty inbox", async t => {
  for (const file of ["autopilot/state.json", "planning.json", "dashboard.json"]) {
    const root = await makeRoot(t);
    await profile(root, "t", "");
    await writeFile(path.join(root, file), "{ not json");
    const { code, out } = await cli(root, ["autopilot", "inbox"]);
    const document = JSON.parse(out);
    assert.equal(code, 11, file);
    assert.equal(document.ok, false, file);
    assert.equal(document.error.code, "STORE_UNREADABLE", file);
  }
});
