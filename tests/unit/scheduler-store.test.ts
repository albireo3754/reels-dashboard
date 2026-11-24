import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ScheduleFileStore, SchedulerDb } from "../../src/desktop/scheduler-store";
import { definitionHash } from "../../src/features/scheduler";

const trigger = { type: "cron" as const, expr: "10 18 * * *", timezone: "Asia/Seoul" };
const at = (iso: string) => new Date(iso);

async function root(t: test.TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "scheduler-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const planOnce = (db: SchedulerDb, key: string, now: Date) =>
  db.plan(
    "example-loop",
    () => ({
      cursor: { lastCheckedAt: now, definitionHash: definitionHash(trigger) },
      run: { key, trigger: "cron", at: at("2026-11-25T09:10:00Z"), deadline: at("2026-11-25T14:10:00Z") },
      missed: [],
    }),
    now,
  );
const claimOptions = (now: Date, hostPid = 1) => ({ now, timezone: "Asia/Seoul", maxRunsPerDay: 1, hostPid, hostPidStarted: "s" });

test("two connections inserting the same occurrence: exactly one wins", async (t) => {
  const dir = await root(t);
  const a = new SchedulerDb(dir);
  const b = new SchedulerDb(dir);
  t.after(() => (a.close(), b.close()));
  const now = at("2026-11-25T09:10:30Z");
  const results = [planOnce(a, "cron:2026-11-25T09:10:00.000Z", now), planOnce(b, "cron:2026-11-25T09:10:00.000Z", now)];
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(a.list({ limit: 10 }).length, 1);
  const runId = results.find(Boolean)!;
  const claims = [a.claim(runId, claimOptions(now, 1)), b.claim(runId, claimOptions(now, 2))];
  assert.deepEqual(claims.map((c) => c.kind).sort(), ["claimed", "gone"]);
});

test("a second running run of a schedule is skipped; the aside lock keeps others pending", async (t) => {
  const dir = await root(t);
  const db = new SchedulerDb(dir);
  t.after(() => db.close());
  const now = at("2026-11-25T09:10:30Z");
  const first = planOnce(db, "cron:a", now)!;
  const second = planOnce(db, "cron:b", now)!;
  assert.equal(db.claim(first, { ...claimOptions(now), maxRunsPerDay: 5 }).kind, "claimed");
  assert.deepEqual(db.claim(second, { ...claimOptions(now), maxRunsPerDay: 5 }), { kind: "skipped", reason: "already-running" });
  const other = db.insertManual("other-loop", now, at("2026-11-25T09:20:30Z"));
  assert.equal(db.claim(other, claimOptions(now)).kind, "locked");
  assert.equal(db.get(other)?.status, "pending");
  db.finish(first, { status: "ok" }, now);
  assert.equal(db.claim(other, claimOptions(now)).kind, "claimed");
});

test("the partial unique indexes reject two running rows even without the checks", async (t) => {
  const dir = await root(t);
  const db = new SchedulerDb(dir);
  t.after(() => db.close());
  const now = at("2026-11-25T09:10:30Z");
  const a = planOnce(db, "cron:a", now)!;
  const b = planOnce(db, "cron:b", now)!;
  db.db.prepare("UPDATE runs SET status = 'running' WHERE run_id = ?").run(a);
  assert.throws(() => db.db.prepare("UPDATE runs SET status = 'running' WHERE run_id = ?").run(b), /UNIQUE/);
  const c = db.insertManual("other-loop", now, now);
  assert.throws(() => db.db.prepare("UPDATE runs SET status = 'running' WHERE run_id = ?").run(c), /UNIQUE/);
});

test("the daily limit counts started runs on the schedule's calendar day, manual included", async (t) => {
  const dir = await root(t);
  const db = new SchedulerDb(dir);
  t.after(() => db.close());
  const morning = at("2026-11-25T01:00:00Z"); // 10:00 KST
  const manual = db.insertManual("example-loop", morning, at("2026-11-25T01:10:00Z"));
  assert.equal(db.claim(manual, claimOptions(morning)).kind, "claimed");
  db.finish(manual, { status: "failed", reason: "exit" }, morning);
  const evening = at("2026-11-25T09:10:30Z");
  const cron = planOnce(db, "cron:2026-11-25T09:10:00.000Z", evening)!;
  assert.deepEqual(db.claim(cron, claimOptions(evening)), { kind: "skipped", reason: "daily-limit" });
  // 00:30 KST next day is a new day.
  const nextDay = db.insertManual("example-loop", at("2026-11-25T15:30:00Z"), at("2026-11-25T15:40:00Z"));
  assert.equal(db.claim(nextDay, claimOptions(at("2026-11-25T15:30:00Z"))).kind, "claimed");
});

test("files are private: directory 0700, database and schedules 0600", async (t) => {
  const dir = await root(t);
  const db = new SchedulerDb(dir);
  t.after(() => db.close());
  const files = new ScheduleFileStore(dir);
  await files.update(() => ({
    schedules: [
      {
        id: "example-loop",
        name: "Example",
        enabled: true,
        trigger,
        misfire: { catchUpWithinMinutes: 300 },
        limits: { timeoutMinutes: 45, maxRunsPerDay: 1 },
        action: { kind: "aside", skill: "example-skill", params: {} },
        createdAt: "2026-11-25T00:00:00.000Z",
        updatedAt: "2026-11-25T00:00:00.000Z",
      },
    ],
    result: undefined,
  }));
  const mode = async (file: string) => (await stat(file)).mode & 0o777;
  assert.equal(await mode(path.join(dir, "scheduler")), 0o700);
  assert.equal(await mode(path.join(dir, "scheduler/scheduler.sqlite")), 0o600);
  assert.equal(await mode(path.join(dir, "scheduler/schedules.json")), 0o600);
});

test("an invalid hand edit keeps the last good definitions and reports the error", async (t) => {
  const dir = await root(t);
  const files = new ScheduleFileStore(dir);
  assert.deepEqual(await files.read(), []);
  await files.update(() => ({
    schedules: [
      {
        id: "example-loop",
        name: "Example",
        enabled: true,
        trigger,
        misfire: { catchUpWithinMinutes: 300 },
        limits: { timeoutMinutes: 45, maxRunsPerDay: 1 },
        action: { kind: "aside", skill: "example-skill", params: {} },
        createdAt: "2026-11-25T00:00:00.000Z",
        updatedAt: "2026-11-25T00:00:00.000Z",
      },
    ],
    result: undefined,
  }));
  assert.equal((await files.read()).length, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(files.path, JSON.stringify({ version: 1, schedules: [{ id: "x", asideBin: "/tmp/evil" }] }));
  assert.equal((await files.read())[0].id, "example-loop");
  assert.match(files.lastError ?? "", /^SCHEDULES_INVALID/);
});

test("retention keeps 200 rows per schedule and drops old missed/skipped rows", async (t) => {
  const dir = await root(t);
  const db = new SchedulerDb(dir);
  t.after(() => db.close());
  const insert = db.db.prepare(
    "INSERT INTO runs(run_id, schedule_id, occurrence_key, trigger, scheduled_at, deadline_at, status, created_at) VALUES(?, 'example-loop', ?, 'cron', ?, ?, ?, ?)",
  );
  const base = Date.parse("2026-01-01T00:00:00Z");
  for (let i = 0; i < 260; i++) {
    const when = new Date(base + i * 3600_000).toISOString();
    insert.run(`r_${i}`, `cron:${when}`, when, when, i < 5 ? "missed" : "ok", when);
  }
  db.prune(at("2026-11-25T00:00:00Z"));
  const rows = db.list({ limit: 50 });
  assert.equal((db.db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number }).n, 200);
  assert.equal(rows[0].run_id, "r_259");
  assert.equal(db.db.prepare("SELECT 1 FROM runs WHERE status = 'missed'").get(), undefined);
});
