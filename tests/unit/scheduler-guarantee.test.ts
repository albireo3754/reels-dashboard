import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Scheduler, type ActionHandle } from "../../src/desktop/scheduler";
import { ScheduleFileStore, SchedulerDb } from "../../src/desktop/scheduler-store";
import { dayIn } from "../../src/features/scheduler";
import { exampleSchedule, FakeRunner } from "../fixtures/scheduler";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const TZ = "Asia/Seoul";
const CATCH_UP = 300;
/** mulberry32: a fixed seed makes the timeline reproducible. */
function random(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs end when the timeline says so (they may span ticks); the preflight yields like a real one. */
class TimelineRunner extends FakeRunner {
  violations: string[] = [];
  constructor(private state: { disposed: boolean }) {
    super();
  }
  override async preflight() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return super.preflight();
  }
  override async start(context: Parameters<FakeRunner["start"]>[0]): Promise<ActionHandle> {
    if (this.state.disposed) this.violations.push(`${context.run.run_id} started after the quit began`);
    return super.start(context);
  }
}

const configs = [
  { name: "18:10", expr: "10 18 * * *", time: "18:10" },
  { name: "22:00, catch-up across midnight", expr: "0 22 * * *", time: "22:00" },
];

for (const config of configs)
  for (const seed of [20261125, 7, 42]) {
    test(`30 days of on/off, sleep, clock steps, edits, manual runs, long runs and twin instances (${config.name}, seed ${seed})`, async (t) => {
      const root = await mkdtemp(path.join(tmpdir(), "scheduler-guarantee-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      const files = new ScheduleFileStore(root);
      await files.update(() => ({
        schedules: [exampleSchedule({ trigger: { type: "cron", expr: config.expr, timezone: TZ }, misfire: { catchUpWithinMinutes: CATCH_UP } })],
        result: undefined,
      }));
      const occurrence = (day: string) => new Date(`${day}T${config.time}:00+09:00`).getTime();
      /** The occurrence day whose catch-up window holds `at`, if any. The deadline itself is outside. */
      const windowDay = (at: Date) =>
        [dayIn(at, TZ), dayIn(new Date(at.getTime() - DAY), TZ)].find(
          (day) => at.getTime() >= occurrence(day) && at.getTime() < occurrence(day) + CATCH_UP * MINUTE,
        );
      const rand = random(seed);
      const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
      let real = Date.parse("2026-11-01T00:00:00Z");
      const end = real + 30 * DAY;
      let offset = 0; // the wall clock may be set back
      const clock = () => new Date(real - offset);
      const live = new Set<number>();
      let nextPid = 100;
      const instances: { scheduler: Scheduler; pid: number; runner: TimelineRunner; state: { disposed: boolean } }[] = [];
      const runners: TimelineRunner[] = [];
      const start = () => {
        const pid = nextPid++;
        live.add(pid);
        const state = { disposed: false };
        const runner = new TimelineRunner(state);
        runners.push(runner);
        instances.push({
          pid,
          runner,
          state,
          scheduler: new Scheduler({
            root,
            runner,
            now: clock,
            hostPid: pid,
            hostPidStarted: `start-${pid}`,
            isAlive: (p) => live.has(p),
            processStart: (p) => (live.has(p) ? `start-${p}` : undefined),
            log: () => {},
          }),
        });
      };
      const stop = async (instance: (typeof instances)[number]) => {
        instance.state.disposed = true;
        await instance.scheduler.dispose();
        live.delete(instance.pid);
        instances.splice(instances.indexOf(instance), 1);
      };
      const settle = async () => {
        for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      };
      start();
      let sleepingUntil = 0;
      let maxSeen = 0;
      const windowTicks = new Set<string>(); // occurrence days with a completed in-window tick on a clock that did not go back
      const anyWindowTicks = new Set<string>(); // ...any in-window tick, on any clock
      const manualDays = new Set<string>(); // days a manual run was accepted
      const monotonicTicks: number[] = [];
      const counts = { off: 0, quitMidTick: 0, sleep: 0, clock: 0, edit: 0, manual: 0, twin: 0, longRun: 0 };
      while (real < end) {
        real += between(7, 13) * MINUTE;
        // Runs end at their own pace: some within the tick, some several ticks later (or at the timeout).
        for (const runner of runners)
          for (const handle of runner.handles)
            if (rand() < 0.6) handle.finish({ status: "ok" });
            else counts.longRun++;
        await settle();
        if (!instances.length) {
          if (rand() < 0.012) {
            start();
            if (rand() < 0.3) start();
          } else continue;
        } else if (real < sleepingUntil) continue;
        else {
          const r = rand();
          if (r < 0.01) {
            counts.off++;
            if (rand() < 0.5) {
              // Quit while a tick (maybe a preflight) is in flight.
              counts.quitMidTick++;
              const now = clock();
              const ticking = Promise.all(instances.map((i) => i.scheduler.tick()));
              for (const instance of [...instances]) await stop(instance);
              await ticking;
              const day = windowDay(now);
              if (day) anyWindowTicks.add(day);
              continue;
            }
            for (const instance of [...instances]) await stop(instance);
            continue;
          } else if (r < 0.016) {
            counts.sleep++;
            sleepingUntil = real + between(30, 600) * MINUTE;
            continue;
          } else if (r < 0.019) {
            counts.clock++;
            offset += between(10, 40) * MINUTE;
          } else if (r < 0.022) {
            counts.edit++;
            const file = JSON.parse(await readFile(files.path, "utf8"));
            file.schedules[0].name = `Example loop ${between(1, 999)}`;
            file.schedules[0].action.params.maxVisit = between(1, 5);
            await writeFile(files.path, JSON.stringify(file, null, 2));
          } else if (r < 0.026) {
            counts.manual++;
            const accepted = await instances[between(0, instances.length - 1)].scheduler.runNow({ id: "example-loop" }).then(
              () => true,
              () => false,
            );
            if (accepted) manualDays.add(dayIn(clock(), TZ));
          } else if (r < 0.03) {
            counts.twin++;
            if (instances.length > 1) await stop(instances[0]);
            else start();
          }
        }
        const now = clock();
        await Promise.all(instances.map((instance) => instance.scheduler.tick()));
        await settle();
        const monotonic = now.getTime() >= maxSeen;
        maxSeen = Math.max(maxSeen, now.getTime());
        if (monotonic) monotonicTicks.push(now.getTime());
        const day = windowDay(now);
        if (day) {
          anyWindowTicks.add(day);
          if (monotonic) windowTicks.add(day);
        }
      }
      for (const instance of [...instances]) await stop(instance);
      assert.ok(Object.values(counts).every((n) => n > 0), `every kind of event happened: ${JSON.stringify(counts)}`);
      assert.deepEqual(runners.flatMap((r) => r.violations), [], "no run starts once the quit began");

      const db = new SchedulerDb(root);
      t.after(() => db.close());
      const rows = db.db.prepare("SELECT * FROM runs").all() as unknown as { trigger: string; status: string; started_at: string | null; scheduled_at: string }[];
      assert.ok(!rows.some((r) => r.status === "running" || r.status === "pending"), "every run ended");
      // The daily limit counts a run on the day it was due (a catch-up after midnight belongs to the day before).
      const startedByDay = new Map<string, typeof rows>();
      for (const row of rows.filter((r) => r.started_at)) {
        const day = dayIn(new Date(row.scheduled_at), TZ);
        startedByDay.set(day, [...(startedByDay.get(day) ?? []), row]);
      }
      for (const [day, list] of startedByDay) assert.ok(list.length <= 1, `${day}: ${list.length} runs started`);
      let cronDays = 0;
      for (const day of windowTicks) {
        const started = startedByDay.get(day) ?? [];
        assert.equal(started.length, 1, `${day}: ticked in the window but no run`);
        // A manual run that day may stand in for the cron run; otherwise it must be the cron run itself.
        if (!manualDays.has(day)) {
          assert.notEqual(started[0].trigger, "manual", `${day}: the cron run is missing`);
          assert.equal(Date.parse(started[0].scheduled_at), occurrence(day), `${day}: the run is that day's occurrence`);
          cronDays++;
        }
      }
      let quietDays = 0;
      for (let at = occurrence("2026-11-01"); at < end - DAY; at += DAY) {
        const day = dayIn(new Date(at), TZ);
        if (anyWindowTicks.has(day)) continue;
        quietDays++;
        const scheduled = rows.filter((r) => Date.parse(r.scheduled_at) === occurrence(day) && r.trigger !== "manual");
        assert.ok(!scheduled.some((r) => r.started_at), `${day}: a cron run started without an in-window tick`);
        const seenLater = monotonicTicks.some((tick) => tick > occurrence(day) + CATCH_UP * MINUTE && tick < occurrence(day) + 6 * DAY);
        if (seenLater) assert.deepEqual(scheduled.map((r) => r.status), ["missed"], `${day}: missed row`);
      }
      assert.ok(cronDays >= 5 && quietDays >= 3, `both kinds of days occurred (${cronDays} cron run days, ${quietDays} quiet days)`);
    });
  }
