import test from "node:test";
import assert from "node:assert/strict";
import { Cron } from "croner";
import {
  dayIn,
  deadlineFor,
  definitionHash,
  dueOccurrences,
  nextRunAt,
  occurrenceKey,
  type Cursor,
} from "../../src/features/scheduler";
import { cronTriggerSchema, scheduleSchema } from "../../src/features/scheduler/model/schema";

const trigger = { type: "cron" as const, expr: "10 18 * * *", timezone: "Asia/Seoul" };
const schedule = { trigger, misfire: { catchUpWithinMinutes: 300 } };
const at = (iso: string) => new Date(iso);
const cursorAt = (iso: string, t = trigger): Cursor => ({ lastCheckedAt: at(iso), definitionHash: definitionHash(t) });

test("croner nextRun(from) is strictly after from, and 18:10 Asia/Seoul is 09:10Z", () => {
  const cron = new Cron("10 18 * * *", { timezone: "Asia/Seoul", paused: true });
  assert.equal(cron.nextRun(at("2026-11-25T00:00:00Z"))?.toISOString(), "2026-11-25T09:10:00.000Z");
  assert.equal(cron.nextRun(at("2026-11-25T09:10:00Z"))?.toISOString(), "2026-11-26T09:10:00.000Z");
  assert.equal(cron.nextRun(at("2026-11-25T09:09:59.999Z"))?.toISOString(), "2026-11-25T09:10:00.000Z");
  assert.equal(nextRunAt(trigger, at("2026-11-25T09:10:00.500Z"))?.toISOString(), "2026-11-26T09:10:00.000Z");
});

test("the 18:10 tick on time yields one run, marked cron", () => {
  const due = dueOccurrences(schedule, cursorAt("2026-11-25T09:09:30Z"), at("2026-11-25T09:10:30Z"));
  assert.equal(due.run?.at.toISOString(), "2026-11-25T09:10:00.000Z");
  assert.equal(due.run?.trigger, "cron");
  assert.deepEqual(due.missed, []);
  assert.equal(due.cursor.lastCheckedAt.toISOString(), "2026-11-25T09:10:30.000Z");
});

test("asleep before 18:10 and awake at 21:00 runs once as a catch-up", () => {
  const due = dueOccurrences(schedule, cursorAt("2026-11-25T08:55:00Z"), at("2026-11-25T12:00:00Z"));
  assert.equal(due.run?.at.toISOString(), "2026-11-25T09:10:00.000Z");
  assert.equal(due.run?.trigger, "catchup");
});

test("next morning the evening time is expired: one missed row, no run", () => {
  const due = dueOccurrences(schedule, cursorAt("2026-11-25T08:00:00Z"), at("2026-11-26T00:00:00Z"));
  assert.equal(due.run, undefined);
  assert.deepEqual(due.missed.map((m) => [m.at.toISOString(), m.reason]), [["2026-11-25T09:10:00.000Z", "expired"]]);
});

test("three days off runs only the latest and supersedes the rest", () => {
  const due = dueOccurrences(schedule, cursorAt("2026-11-22T08:00:00Z"), at("2026-11-25T10:00:00Z"));
  assert.equal(due.run?.at.toISOString(), "2026-11-25T09:10:00.000Z");
  assert.deepEqual(due.missed.map((m) => [m.at.toISOString(), m.reason]), [
    ["2026-11-22T09:10:00.000Z", "superseded"],
    ["2026-11-23T09:10:00.000Z", "superseded"],
    ["2026-11-24T09:10:00.000Z", "superseded"],
  ]);
});

test("catch-up 0 still allows the two-minute on-time window", () => {
  const strict = { trigger, misfire: { catchUpWithinMinutes: 0 } };
  assert.equal(dueOccurrences(strict, cursorAt("2026-11-25T09:00:00Z"), at("2026-11-25T09:11:30Z")).run?.trigger, "cron");
  const late = dueOccurrences(strict, cursorAt("2026-11-25T09:00:00Z"), at("2026-11-25T09:13:00Z"));
  assert.equal(late.run, undefined);
  assert.equal(late.missed[0].reason, "expired");
  assert.equal(deadlineFor(at("2026-11-25T09:10:00Z"), strict).toISOString(), "2026-11-25T09:12:00.000Z");
  assert.equal(deadlineFor(at("2026-11-25T09:10:00Z"), schedule).toISOString(), "2026-11-25T14:10:00.000Z");
});

test("first activation and a changed definition never replay the past", () => {
  const first = dueOccurrences(schedule, undefined, at("2026-11-25T12:00:00Z"));
  assert.equal(first.reset, "first");
  assert.equal(first.run, undefined);
  const other = { ...trigger, expr: "0 9 * * *" };
  const changed = dueOccurrences(schedule, cursorAt("2026-11-20T00:00:00Z", other), at("2026-11-25T12:00:00Z"));
  assert.equal(changed.reset, "definition");
  assert.equal(changed.run, undefined);
  assert.deepEqual(changed.missed, []);
  assert.equal(changed.cursor.definitionHash, definitionHash(trigger));
});

test("a clock that went back pulls the cursor to now; a small step back waits", () => {
  const back = dueOccurrences(schedule, cursorAt("2026-11-25T10:00:00Z"), at("2026-11-25T09:00:00Z"));
  assert.equal(back.reset, "clock");
  assert.equal(back.cursor.lastCheckedAt.toISOString(), "2026-11-25T09:00:00.000Z");
  const small = dueOccurrences(schedule, cursorAt("2026-11-25T10:00:00Z"), at("2026-11-25T09:58:00Z"));
  assert.equal(small.reset, undefined);
  assert.equal(small.cursor.lastCheckedAt.toISOString(), "2026-11-25T10:00:00.000Z");
});

test("only the last 7 days are scanned, at most 500 times and 50 missed rows", () => {
  const month = dueOccurrences(schedule, cursorAt("2026-10-01T00:00:00Z"), at("2026-11-25T10:00:00Z"));
  assert.equal(month.missed.length, 6);
  assert.equal(month.missed[0].at.toISOString(), "2026-11-19T09:10:00.000Z");
  const everyMinute = { trigger: { ...trigger, expr: "* * * * *" }, misfire: { catchUpWithinMinutes: 300 } };
  const burst = dueOccurrences(everyMinute, cursorAt("2026-11-20T00:00:00Z", everyMinute.trigger), at("2026-11-25T00:00:00Z"));
  assert.equal(burst.missed.length, 50);
  assert.equal(burst.run?.at.toISOString(), "2026-11-25T00:00:00.000Z", "the newest time is found past the 500 cap");
});

test("UTC storage and the KST calendar day agree across midnight and month end", () => {
  assert.equal(dayIn(at("2026-11-30T14:59:59Z"), "Asia/Seoul"), "2026-11-30");
  assert.equal(dayIn(at("2026-11-30T15:00:00Z"), "Asia/Seoul"), "2026-12-01");
  assert.equal(occurrenceKey(at("2026-11-30T09:10:00Z")), "cron:2026-11-30T09:10:00.000Z");
  const endOfMonth = { type: "cron" as const, expr: "30 23 31 * *", timezone: "Asia/Seoul" };
  assert.equal(nextRunAt(endOfMonth, at("2026-11-01T00:00:00Z"))?.toISOString(), "2026-12-31T14:30:00.000Z");
});

test("schedule schema: five-field cron and a real timezone, defaults filled", () => {
  assert.throws(() => cronTriggerSchema.parse({ type: "cron", expr: "*/10 * * * * *" }));
  assert.throws(() => cronTriggerSchema.parse({ type: "cron", expr: "nope" }));
  assert.throws(() => cronTriggerSchema.parse({ type: "cron", expr: "0 18 * * *", timezone: "Mars/Base" }));
  const parsed = scheduleSchema.parse({
    id: "example-loop",
    name: "Example",
    enabled: true,
    trigger: { type: "cron", expr: "10 18 * * *" },
    action: { kind: "aside", skill: "example-skill" },
    createdAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
  });
  assert.equal(parsed.trigger.timezone, "Asia/Seoul");
  assert.deepEqual(parsed.misfire, { catchUpWithinMinutes: 300 });
  assert.deepEqual(parsed.limits, { timeoutMinutes: 45, maxRunsPerDay: 1 });
});
