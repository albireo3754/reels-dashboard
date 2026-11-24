import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Scheduler, schedulerEnabled } from "../../src/desktop/scheduler";
import { SchedulerDb, ScheduleFileStore } from "../../src/desktop/scheduler-store";
import { setScheduleInput } from "../../src/features/scheduler";
import { exampleSchedule, FakeRunner } from "../fixtures/scheduler";
import type { Schedule } from "../../src/features/scheduler";

const ok = () => ({ status: "ok" as const, counts: { accepted: 1, visited: 1, commented: 1, liked: 1 } });

async function setup(t: test.TestContext, schedule: Schedule | null = exampleSchedule()) {
  const root = await mkdtemp(path.join(tmpdir(), "scheduler-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (schedule) await new ScheduleFileStore(root).update(() => ({ schedules: [schedule], result: undefined }));
  const clock = { now: new Date("2026-11-25T03:00:00Z") }; // 12:00 KST
  const notices: { title: string; body: string }[] = [];
  const live = new Set<number>();
  const make = (runner: FakeRunner, hostPid = 1001) => {
    live.add(hostPid);
    const scheduler = new Scheduler({
      root,
      runner,
      now: () => clock.now,
      hostPid,
      hostPidStarted: `start-${hostPid}`,
      isAlive: (pid) => live.has(pid),
      processStart: (pid) => (live.has(pid) ? `start-${pid}` : undefined),
      notify: (notice) => notices.push(notice),
      log: () => {},
      startDelayMs: 0,
    });
    t.after(() => scheduler.dispose());
    return scheduler;
  };
  const set = (iso: string) => (clock.now = new Date(iso));
  return { root, clock, set, make, notices, live };
}
const started = (scheduler: Scheduler) => scheduler.db.list({ limit: 50 }).filter((r) => r.started_at);

test("the 18:10 run starts once on time; a second tick in the same minute does nothing", async (t) => {
  const { make, set } = await setup(t);
  const runner = new FakeRunner(ok);
  const scheduler = make(runner);
  await scheduler.tick(); // first activation at 12:00 KST: cursor only
  set("2026-11-25T09:10:20Z");
  await scheduler.tick();
  await scheduler.tick();
  await scheduler.idle();
  set("2026-11-25T09:11:20Z");
  await scheduler.tick();
  const runs = scheduler.db.list({ limit: 10 });
  assert.equal(runner.starts.length, 1);
  assert.deepEqual(runs.map((r) => [r.trigger, r.status, r.session_id]), [["cron", "ok", "Sess1"]]);
});

test("app closed 17:00-19:30 runs one catch-up after it opens", async (t) => {
  const { make, set } = await setup(t);
  const before = make(new FakeRunner(ok));
  set("2026-11-25T08:00:00Z");
  await before.tick();
  await before.dispose();
  set("2026-11-25T10:30:00Z");
  const runner = new FakeRunner(ok);
  const after = make(runner, 1002);
  await after.tick();
  await after.idle();
  assert.deepEqual(after.db.list({ limit: 10 }).map((r) => [r.trigger, r.status]), [["catchup", "ok"]]);
});

test("opened after the catch-up window: recorded as missed, nothing runs", async (t) => {
  const { make, set } = await setup(t);
  const first = make(new FakeRunner(ok));
  set("2026-11-25T08:00:00Z");
  await first.tick();
  await first.dispose();
  set("2026-11-25T14:30:00Z"); // 23:30 KST, past 23:10
  const runner = new FakeRunner(ok);
  const second = make(runner, 1002);
  await second.tick();
  assert.equal(runner.starts.length, 0);
  assert.deepEqual(second.db.list({ limit: 10 }).map((r) => [r.status, r.reason]), [["missed", "expired"]]);
});

test("two app instances on one profile ticking together start the run once", async (t) => {
  const { make, set } = await setup(t);
  const a = new FakeRunner(ok);
  const b = new FakeRunner(ok);
  const one = make(a, 2001);
  const two = make(b, 2002);
  await Promise.all([one.tick(), two.tick()]);
  set("2026-11-25T09:10:20Z");
  await Promise.all([one.tick(), two.tick(), one.tick(), two.tick()]);
  await Promise.all([one.idle(), two.idle()]);
  assert.equal(a.starts.length + b.starts.length, 1);
  assert.equal(started(one).length, 1);
});

test("waking from sleep ticks at once and catches up", async (t) => {
  const { make, set } = await setup(t);
  const runner = new FakeRunner(ok);
  const scheduler = make(runner);
  set("2026-11-25T09:00:00Z");
  await scheduler.tick();
  set("2026-11-25T11:45:00Z"); // asleep through 18:10, awake at 20:45 KST
  await scheduler.wake();
  await scheduler.idle();
  assert.deepEqual(scheduler.db.list({ limit: 10 }).map((r) => [r.trigger, r.status]), [["catchup", "ok"]]);
});

test("while a run is running the next occurrence is skipped", async (t) => {
  const { make, set } = await setup(t, exampleSchedule({ trigger: { type: "cron", expr: "* * * * *", timezone: "Asia/Seoul" }, limits: { timeoutMinutes: 45, maxRunsPerDay: 24 } }));
  const runner = new FakeRunner();
  const scheduler = make(runner);
  set("2026-11-25T09:00:30Z");
  await scheduler.tick();
  set("2026-11-25T09:01:30Z");
  await scheduler.tick();
  assert.equal(runner.starts.length, 1);
  set("2026-11-25T09:02:30Z");
  await scheduler.tick();
  assert.equal(runner.starts.length, 1);
  const statuses = scheduler.db.list({ limit: 10 }).map((r) => [r.status, r.reason]);
  assert.deepEqual(statuses, [["skipped", "already-running"], ["running", null]]);
  runner.handles[0].finish(ok());
  await scheduler.idle();
});

test("timeout stops the run and records failed/timeout", async (t) => {
  const { make, set, notices } = await setup(t);
  const runner = new FakeRunner();
  const scheduler = make(runner);
  await scheduler.tick();
  set("2026-11-25T09:10:20Z");
  await scheduler.tick();
  set("2026-11-25T09:40:00Z");
  await scheduler.tick();
  assert.equal(runner.handles[0].stopped, false);
  set("2026-11-25T09:56:00Z"); // 45 min after start
  await scheduler.tick();
  await scheduler.idle();
  assert.equal(runner.handles[0].stopped, true);
  const [run] = scheduler.db.list({ limit: 1 });
  assert.deepEqual([run.status, run.reason], ["failed", "timeout"]);
  assert.match(notices.at(-1)!.title, /실패/);
});

test("preflight failure waits, rechecks every 10 minutes, notifies once and ends blocked", async (t) => {
  const { make, set, notices } = await setup(t);
  const runner = new FakeRunner(ok);
  runner.preflightFailure = "host-disconnected";
  const scheduler = make(runner);
  await scheduler.tick();
  set("2026-11-25T09:10:20Z");
  await scheduler.tick();
  assert.deepEqual(scheduler.db.list({ limit: 1 }).map((r) => [r.status, r.reason]), [["pending", "host-disconnected"]]);
  set("2026-11-25T09:15:00Z");
  await scheduler.tick();
  assert.equal(runner.preflights, 1);
  set("2026-11-25T09:21:00Z");
  await scheduler.tick();
  assert.equal(runner.preflights, 2);
  assert.equal(notices.length, 1);
  set("2026-11-25T14:11:00Z"); // past the 23:10 KST deadline
  await scheduler.tick();
  assert.equal(runner.starts.length, 0);
  assert.deepEqual(scheduler.db.list({ limit: 1 }).map((r) => [r.status, r.reason]), [["blocked", "host-disconnected"]]);
  assert.equal(notices.length, 2);
  assert.match(notices[1].title, /막힘/);
  assert.doesNotMatch(JSON.stringify(notices), /example-blog/);
});

test("a manual run uses up the day: the 18:10 run is skipped with daily-limit", async (t) => {
  const { make, set } = await setup(t);
  const runner = new FakeRunner(ok);
  const scheduler = make(runner);
  await scheduler.tick();
  const { runId } = await scheduler.runNow({ id: "example-loop" });
  await scheduler.tick();
  await scheduler.idle();
  assert.equal(scheduler.db.get(runId)?.status, "ok");
  await assert.rejects(scheduler.runNow({ id: "example-loop" }), /DAILY_LIMIT/);
  set("2026-11-25T09:10:20Z");
  await scheduler.tick();
  assert.equal(runner.starts.length, 1);
  assert.deepEqual(scheduler.db.list({ limit: 1 }).map((r) => [r.trigger, r.status, r.reason]), [["cron", "skipped", "daily-limit"]]);
});

test("run now while running is ALREADY_RUNNING", async (t) => {
  const { make } = await setup(t, exampleSchedule({ limits: { timeoutMinutes: 45, maxRunsPerDay: 3 } }));
  const runner = new FakeRunner();
  const scheduler = make(runner);
  await scheduler.runNow({ id: "example-loop" });
  await scheduler.tick();
  await assert.rejects(scheduler.runNow({ id: "example-loop" }), /ALREADY_RUNNING/);
  runner.handles[0].finish(ok());
  await scheduler.idle();
});

test("a captcha stop pauses the schedule; the next day has no run", async (t) => {
  const { make, set, notices, root } = await setup(t);
  const runner = new FakeRunner(() => ({ status: "failed", reason: "blocked:captcha", pause: "captcha" }));
  const scheduler = make(runner);
  await scheduler.tick();
  set("2026-11-25T09:10:20Z");
  await scheduler.tick();
  await scheduler.idle();
  const [schedule] = await new ScheduleFileStore(root).read();
  assert.equal(schedule.enabled, false);
  assert.match(schedule.pausedReason ?? "", /^blocked:captcha/);
  assert.ok(notices.some((n) => /일시정지/.test(n.title)));
  set("2026-11-26T09:10:20Z");
  await scheduler.tick();
  assert.equal(runner.starts.length, 1);
  assert.equal(scheduler.db.list({ limit: 10 }).length, 1);
  // Re-enabling clears the reason and does not replay the paused day.
  set("2026-11-26T10:00:00Z");
  const { schedule: resumed } = (await scheduler.setSchedule({ id: "example-loop", enabled: true })) as { schedule: Schedule };
  assert.equal(resumed.pausedReason, undefined);
  await scheduler.tick();
  assert.equal(runner.starts.length, 1);
});

test("reclaim: a live other instance is left alone; orphans of a gone host are stopped or recorded", async (t) => {
  const { make, set, live, root } = await setup(t);
  const runner = new FakeRunner(ok);
  const scheduler = make(runner, 3001);
  set("2026-11-25T09:30:00Z");
  const db = new SchedulerDb(root);
  t.after(() => db.close());
  const row = (id: string, schedule: string, values: { host: number; pid?: number; pidStarted?: string; session?: string }) => {
    db.db
      .prepare(
        `INSERT INTO runs(run_id, schedule_id, occurrence_key, trigger, scheduled_at, deadline_at, status, lock_key, host_pid, host_pid_started, pid, pid_started, session_id, created_at, started_at)
         VALUES(?, ?, ?, 'manual', ?, ?, 'running', NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, schedule, `manual:${id}`, "2026-11-25T09:00:00Z", "2026-11-25T09:10:00Z", values.host, `start-${values.host}`, values.pid ?? null, values.pidStarted ?? null, values.session ?? null, "2026-11-25T09:00:00Z", "2026-11-25T09:00:00Z");
  };
  live.add(4000); // another live app instance
  row("r_other", "a-loop", { host: 4000, pid: 4001, pidStarted: "start-4001" });
  live.add(5001); // orphan child of a dead host, same start time
  row("r_orphan", "b-loop", { host: 5000, pid: 5001, pidStarted: "start-5001", session: "SessOrphan" });
  live.add(6001); // pid reused by an unrelated process
  row("r_reused", "c-loop", { host: 6000, pid: 6001, pidStarted: "start-older" });
  row("r_dead", "d-loop", { host: 7000, pid: 7001, pidStarted: "start-7001", session: "SessDead" });
  await scheduler.tick();
  const status = (id: string) => [scheduler.db.get(id)?.status, scheduler.db.get(id)?.reason];
  assert.deepEqual(status("r_other"), ["running", null]);
  assert.deepEqual(status("r_orphan"), ["interrupted", "orphan-stopped"]);
  assert.deepEqual(status("r_reused"), ["interrupted", "pid-reused"]);
  assert.deepEqual(status("r_dead"), ["interrupted", "host-exited"]);
  assert.deepEqual(runner.orphans, [{ pid: 5001, sessionId: "SessOrphan" }]);
  assert.deepEqual(runner.stoppedSessions, ["SessDead"]);
});

test("dispose stops a running run and records interrupted", async (t) => {
  const { make, set, root } = await setup(t);
  const runner = new FakeRunner();
  const scheduler = make(runner);
  await scheduler.tick();
  set("2026-11-25T09:10:20Z");
  await scheduler.tick();
  assert.equal(scheduler.running(), 1);
  const runId = scheduler.db.list({ limit: 1 })[0].run_id;
  await scheduler.dispose();
  assert.equal(runner.handles[0].stopped, true);
  const reopened = new SchedulerDb(root);
  t.after(() => reopened.close());
  assert.deepEqual([reopened.get(runId)?.status, reopened.get(runId)?.reason], ["interrupted", "app-quit"]);
});

test("start() ticks after the start delay and every interval", async (t) => {
  const { make, set } = await setup(t);
  mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  t.after(() => mock.timers.reset());
  const scheduler = make(new FakeRunner(ok));
  const checked = () => scheduler.db.cursor("example-loop")?.lastCheckedAt.toISOString();
  const settle = async (expected: string) => {
    for (let i = 0; i < 200 && checked() !== expected; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  scheduler.start();
  assert.equal(checked(), undefined);
  mock.timers.tick(0);
  await settle("2026-11-25T03:00:00.000Z");
  assert.equal(checked(), "2026-11-25T03:00:00.000Z", "start tick planned the schedule");
  set("2026-11-25T03:01:00Z");
  mock.timers.tick(60_000);
  await settle("2026-11-25T03:01:00.000Z");
  assert.equal(checked(), "2026-11-25T03:01:00.000Z", "the interval ticked");
});

test("background QA starts the scheduler only with a fake aside; demo never", () => {
  assert.equal(schedulerEnabled({}), true);
  assert.equal(schedulerEnabled({ REELS_BACKGROUND_QA: "1" }), false);
  assert.equal(schedulerEnabled({ REELS_BACKGROUND_QA: "1", REELS_ASIDE_BIN: "/tmp/fake-aside" }), true);
  assert.equal(schedulerEnabled({ REELS_DEMO: "1" }), false);
});

test("set_schedule rejects executable paths and path pieces in skill, and needs a skill for a new id", async (t) => {
  assert.equal(setScheduleInput.safeParse({ id: "example-loop", action: { asideBin: "/tmp/x" } }).success, false);
  assert.equal(setScheduleInput.safeParse({ id: "example-loop", asideBin: "/tmp/x" }).success, false);
  assert.equal(setScheduleInput.safeParse({ id: "example-loop", action: { skill: "../escape" } }).success, false);
  assert.equal(setScheduleInput.safeParse({ id: "example-loop", action: { usageCommand: ["sh"] } }).success, false);
  assert.equal(setScheduleInput.safeParse({ id: "example-loop", action: { params: { x: "y".repeat(201) } } }).success, false);
  assert.equal(setScheduleInput.safeParse({ id: "Example Loop" }).success, false);
  const { make, root } = await setup(t, null);
  const scheduler = make(new FakeRunner(ok));
  await assert.rejects(scheduler.setSchedule({ id: "example-loop" }), /SCHEDULE_INCOMPLETE/);
  const created = (await scheduler.setSchedule({ id: "example-loop", action: { skill: "example-skill", params: { maxVisit: 2 } } })) as { schedule: Schedule; nextRunAt: string };
  assert.deepEqual(created.schedule.trigger, { type: "cron", expr: "10 18 * * *", timezone: "Asia/Seoul" });
  assert.deepEqual(created.schedule.misfire, { catchUpWithinMinutes: 300 });
  assert.deepEqual(created.schedule.limits, { timeoutMinutes: 45, maxRunsPerDay: 1 });
  assert.equal(created.nextRunAt, "2026-11-25T09:10:00.000Z");
  const changed = (await scheduler.setSchedule({ id: "example-loop", trigger: { expr: "30 18 * * *" }, action: { hostProfile: "abc-123" } })) as { schedule: Schedule };
  assert.equal(changed.schedule.trigger.expr, "30 18 * * *");
  assert.equal(changed.schedule.action.hostProfile, "abc-123");
  assert.deepEqual(changed.schedule.action.params, { maxVisit: 2 });
  const cleared = (await scheduler.setSchedule({ id: "example-loop", action: { hostProfile: null } })) as { schedule: Schedule };
  assert.equal(cleared.schedule.action.hostProfile, undefined);
  assert.equal((await new ScheduleFileStore(root).read()).length, 1);
});

test("a trigger change restarts catch-up at now instead of replaying", async (t) => {
  const { make, set } = await setup(t);
  const runner = new FakeRunner(ok);
  const scheduler = make(runner);
  set("2026-11-25T08:00:00Z");
  await scheduler.tick();
  set("2026-11-25T10:00:00Z"); // 19:00 KST: 18:10 passed; the trigger moves to 18:30 at the same moment
  await scheduler.setSchedule({ id: "example-loop", trigger: { expr: "30 18 * * *" } });
  await scheduler.tick();
  await scheduler.idle();
  assert.equal(runner.starts.length, 0);
});

test("the repository example is a valid set_schedule input with public values only", async () => {
  const raw = await readFile("automation/scheduler/blog-neighbor-loop.example.json", "utf8");
  const input = setScheduleInput.parse(JSON.parse(raw));
  assert.equal(input.trigger?.expr, "10 18 * * *");
  assert.equal(input.action?.params?.expectedBlogId, "example-blog");
});
