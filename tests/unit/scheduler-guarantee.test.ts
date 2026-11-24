import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Scheduler } from "../../src/desktop/scheduler";
import { ScheduleFileStore, SchedulerDb } from "../../src/desktop/scheduler-store";
import { dayIn } from "../../src/features/scheduler";
import { exampleSchedule, FakeRunner } from "../fixtures/scheduler";

const MINUTE = 60_000;
const TZ = "Asia/Seoul";
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
/** 18:10-23:10 in Asia/Seoul (UTC+9, no DST) as minutes of the KST day. */
const inWindow = (at: Date) => {
  const kst = new Date(at.getTime() + 9 * 60 * MINUTE);
  const minutes = kst.getUTCHours() * 60 + kst.getUTCMinutes() + kst.getUTCSeconds() / 60;
  return minutes >= 18 * 60 + 10 && minutes <= 23 * 60 + 10;
};

for (const seed of [20261125, 7, 42]) {
  test(`30 days of on/off, sleep, clock steps, edits, manual runs and twin instances (seed ${seed})`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "scheduler-guarantee-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const files = new ScheduleFileStore(root);
    await files.update(() => ({ schedules: [exampleSchedule()], result: undefined }));
    const rand = random(seed);
    const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
    let real = Date.parse("2026-11-01T00:00:00Z");
    const end = real + 30 * 24 * 60 * MINUTE;
    let offset = 0; // the wall clock may be set back
    const clock = () => new Date(real - offset);
    const live = new Set<number>();
    let nextPid = 100;
    const instances: Scheduler[] = [];
    const launch = () => {
      const pid = nextPid++;
      live.add(pid);
      instances.push(
        new Scheduler({
          root,
          runner: new FakeRunner(() => ({ status: "ok" })),
          now: clock,
          hostPid: pid,
          hostPidStarted: `start-${pid}`,
          isAlive: (p) => live.has(p),
          processStart: (p) => (live.has(p) ? `start-${p}` : undefined),
          log: () => {},
        }),
      );
      return pid;
    };
    const pids = new Map<Scheduler, number>();
    const stop = async (instance: Scheduler) => {
      await instance.dispose();
      live.delete(pids.get(instance)!);
      instances.splice(instances.indexOf(instance), 1);
    };
    const start = () => {
      const pid = launch();
      pids.set(instances[instances.length - 1], pid);
    };
    start();
    let sleepingUntil = 0;
    let maxSeen = 0;
    const windowTicks = new Set<string>(); // KST days with an in-window tick on a clock that did not go back
    const anyWindowTicks = new Set<string>(); // ...on any clock
    const monotonicTicks: number[] = [];
    const counts = { off: 0, sleep: 0, clock: 0, edit: 0, manual: 0, twin: 0 };
    while (real < end) {
      real += between(7, 13) * MINUTE;
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
          await instances[between(0, instances.length - 1)].runNow({ id: "example-loop" }).catch(() => undefined);
        } else if (r < 0.03) {
          counts.twin++;
          if (instances.length > 1) await stop(instances[0]);
          else start();
        }
      }
      const now = clock();
      await Promise.all(instances.map((instance) => instance.tick()));
      await Promise.all(instances.map((instance) => instance.idle()));
      const monotonic = now.getTime() >= maxSeen;
      maxSeen = Math.max(maxSeen, now.getTime());
      if (monotonic) monotonicTicks.push(now.getTime());
      if (inWindow(now)) {
        anyWindowTicks.add(dayIn(now, TZ));
        if (monotonic) windowTicks.add(dayIn(now, TZ));
      }
    }
    for (const instance of [...instances]) await stop(instance);
    assert.ok(Object.values(counts).every((n) => n > 0), `every kind of event happened: ${JSON.stringify(counts)}`);

    const db = new SchedulerDb(root);
    t.after(() => db.close());
    const rows = db.db.prepare("SELECT * FROM runs").all() as unknown as { trigger: string; status: string; started_at: string | null; scheduled_at: string }[];
    const startedByDay = new Map<string, typeof rows>();
    for (const row of rows.filter((r) => r.started_at)) {
      const day = dayIn(new Date(row.started_at!), TZ);
      startedByDay.set(day, [...(startedByDay.get(day) ?? []), row]);
    }
    for (const [day, list] of startedByDay) assert.ok(list.length <= 1, `${day}: ${list.length} runs started`);
    for (const day of windowTicks) assert.equal(startedByDay.get(day)?.length, 1, `${day}: ticked in the window but no run`);
    const occurrence = (day: string) => new Date(`${day}T18:10:00+09:00`).getTime();
    let quietDays = 0;
    for (let at = Date.parse("2026-11-01T09:10:00Z"); at < end - 24 * 60 * MINUTE; at += 24 * 60 * MINUTE) {
      const day = dayIn(new Date(at), TZ);
      if (anyWindowTicks.has(day)) continue;
      quietDays++;
      const scheduled = rows.filter((r) => Date.parse(r.scheduled_at) === occurrence(day) && r.trigger !== "manual");
      assert.ok(!scheduled.some((r) => r.started_at), `${day}: a cron run started without an in-window tick`);
      const seenLater = monotonicTicks.some((tick) => tick > occurrence(day) + 300 * MINUTE && tick < occurrence(day) + 6 * 24 * 60 * MINUTE);
      if (seenLater) assert.deepEqual(scheduled.map((r) => r.status), ["missed"], `${day}: missed row`);
    }
    assert.ok(windowTicks.size >= 5 && quietDays >= 3, `both kinds of days occurred (${windowTicks.size} run days, ${quietDays} quiet days)`);
  });
}
