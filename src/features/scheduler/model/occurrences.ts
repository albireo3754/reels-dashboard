import { Cron } from "croner";
import { createHash } from "node:crypto";
import type { RunTrigger, Schedule, ScheduleTrigger } from "./schema";

const MINUTE = 60_000;
/** Scan at most this far back; older times are neither run nor recorded. */
export const LOOKBACK_MS = 7 * 24 * 60 * MINUTE;
export const MAX_SCANNED = 500;
export const MAX_MISSED_ROWS = 50;
/** A cron time found this long after it is a catch-up, not an on-time run. Also the window when catch-up is 0. */
export const ON_TIME_MS = 2 * MINUTE;
/** A clock that moved back further than this resets the cursor instead of waiting for it. */
export const CLOCK_SKEW_MS = 5 * MINUTE;

/** croner is only a calculator here: paused, no timers, `nextRun(from)` is strictly after `from`. */
export function cronOf(trigger: ScheduleTrigger) {
  return new Cron(trigger.expr, { timezone: trigger.timezone, paused: true });
}
export function nextRunAt(trigger: ScheduleTrigger, from: Date): Date | null {
  return cronOf(trigger).nextRun(from) ?? null;
}

/** The catch-up cursor restarts when the trigger (expression or timezone) changes. */
export function definitionHash(trigger: ScheduleTrigger) {
  return createHash("sha256").update(JSON.stringify([trigger.type, trigger.expr, trigger.timezone])).digest("hex").slice(0, 16);
}

export const catchUpWindowMs = (schedule: Pick<Schedule, "misfire">) =>
  Math.max(schedule.misfire.catchUpWithinMinutes * MINUTE, ON_TIME_MS);
export const deadlineFor = (at: Date, schedule: Pick<Schedule, "misfire">) => new Date(at.getTime() + catchUpWindowMs(schedule));
export const MANUAL_DEADLINE_MS = 10 * MINUTE;

export const occurrenceKey = (at: Date) => `cron:${at.toISOString()}`;

export interface Cursor {
  lastCheckedAt: Date;
  definitionHash: string;
}
export interface DueOccurrences {
  /** The time to run now (the latest past time, when still inside the catch-up window). */
  run?: { at: Date; trigger: RunTrigger };
  /** Past times that will not run; at most MAX_MISSED_ROWS, newest kept. */
  missed: { at: Date; reason: "superseded" | "expired" }[];
  /** Why the cursor moved without looking at the past, if it did. */
  reset?: "first" | "definition" | "clock";
  /** Always `now`: everything up to here has been handled. */
  cursor: Cursor;
}

/**
 * Times of a cron schedule that passed since the cursor, as a pure function of
 * (schedule, cursor, now). Only the latest one may run, and only within the
 * catch-up window; days spent switched off are never replayed in a burst.
 */
export function dueOccurrences(
  schedule: Pick<Schedule, "trigger" | "misfire">,
  cursor: Cursor | undefined,
  now: Date,
): DueOccurrences {
  const hash = definitionHash(schedule.trigger);
  const next: Cursor = { lastCheckedAt: now, definitionHash: hash };
  if (!cursor) return { missed: [], reset: "first", cursor: next };
  if (cursor.definitionHash !== hash) return { missed: [], reset: "definition", cursor: next };
  const last = cursor.lastCheckedAt.getTime();
  if (now.getTime() < last - CLOCK_SKEW_MS) return { missed: [], reset: "clock", cursor: next };
  if (now.getTime() <= last) return { missed: [], cursor: { ...cursor } };
  const cron = cronOf(schedule.trigger);
  const scan = (start: number, limit: number) => {
    const found: Date[] = [];
    let from = new Date(start);
    for (let i = 0; i < limit; i++) {
      const at = cron.nextRun(from);
      if (!at || at.getTime() > now.getTime()) break;
      found.push(at);
      from = at;
    }
    return found;
  };
  let times = scan(Math.max(last, now.getTime() - LOOKBACK_MS), MAX_SCANNED);
  // A frequent expression can exhaust the scan long before now; the newest time still has to be found.
  if (times.length === MAX_SCANNED)
    times = times.concat(scan(Math.max(times[times.length - 1].getTime(), now.getTime() - catchUpWindowMs(schedule)), 1000));
  if (!times.length) return { missed: [], cursor: next };
  const latest = times[times.length - 1];
  const late = now.getTime() - latest.getTime();
  const missed: DueOccurrences["missed"] = times
    .slice(0, -1)
    .slice(-MAX_MISSED_ROWS)
    .map((at) => ({ at, reason: "superseded" as const }));
  if (late <= catchUpWindowMs(schedule))
    return { run: { at: latest, trigger: late > ON_TIME_MS ? "catchup" : "cron" }, missed, cursor: next };
  return { missed: [...missed, { at: latest, reason: "expired" as const }].slice(-MAX_MISSED_ROWS), cursor: next };
}

/** Calendar day (YYYY-MM-DD) of `at` in `timezone`. */
export function dayIn(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
