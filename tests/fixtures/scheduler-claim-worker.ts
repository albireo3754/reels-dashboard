/**
 * One OS process racing others on the same scheduler database (scheduler-store.test.ts).
 * argv: root, start time (ms), occurrence count. Prints what this process created and claimed.
 */
import { SchedulerDb } from "../../src/desktop/scheduler-store";
import { definitionHash } from "../../src/features/scheduler";

const [root, startAt, count] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4])];
const trigger = { type: "cron" as const, expr: "10 18 * * *", timezone: "Asia/Seoul" };
const at = new Date("2026-11-25T09:10:00Z");
const now = new Date("2026-11-25T09:10:30Z");
const db = new SchedulerDb(root);
const created: string[] = [];
const claimed: string[] = [];
const errors: string[] = [];
while (Date.now() < startAt);
for (let i = 0; i < count; i++) {
  const scheduleId = `race-${i}`;
  try {
    const runId = db.plan(
      scheduleId,
      () => ({
        cursor: { lastCheckedAt: now, definitionHash: definitionHash(trigger) },
        run: { key: `cron:${at.toISOString()}`, trigger: "cron", at, deadline: new Date(at.getTime() + 300 * 60_000) },
        missed: [],
      }),
      now,
    );
    if (runId) created.push(runId);
    const row = db.db.prepare("SELECT run_id FROM runs WHERE schedule_id = ?").get(scheduleId) as { run_id: string };
    for (;;) {
      const result = db.claim(row.run_id, { now, timezone: "Asia/Seoul", maxRunsPerDay: 1, hostPid: process.pid, hostPidStarted: "worker" });
      if (result.kind === "locked") continue; // another process holds the aside lock for a moment
      if (result.kind === "claimed") {
        claimed.push(row.run_id);
        db.finish(row.run_id, { status: "ok" }, now);
      }
      break;
    }
  } catch (error) {
    errors.push(String(error));
  }
}
db.close();
process.stdout.write(JSON.stringify({ created, claimed, errors }));
