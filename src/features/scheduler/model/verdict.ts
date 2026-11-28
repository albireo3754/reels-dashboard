import { parseNaverPostUrl } from "../../../shared/blog-comments";
import { asideResultSchema, pausingBlockedCodes, type AsideResult } from "./schema";

/**
 * Aside CLI failure messages. Several of them come with exit code 0, so the exit code alone
 * never makes a run successful. Only checked in the CLI's own text: before the "created new
 * session" line when there is one (after it the output echoes files and pages the model read,
 * which may quote these phrases), and never inside the final JSON block.
 */
export const asideCliErrors = [
  /unknown option/i,
  /Session not found/i,
  /Chrome extension not connected/i,
  /Operation not permitted/i,
] as const;

/** The part of the exec output written by the Aside CLI itself, before the session started. */
export function asideCliText(outside: string) {
  // eslint-disable-next-line no-control-regex
  const plain = outside.replace(/\x1b\[[0-9;]*m/g, "");
  const session = /^\s*created new session:/m.exec(plain);
  return session ? plain.slice(0, session.index) : plain;
}

/** The last ```json fenced block and the text around it. */
export function lastJsonBlock(stdout: string): { json?: string; outside: string } {
  const pattern = /```json[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;
  let match: RegExpExecArray | null;
  let last: RegExpExecArray | undefined;
  while ((match = pattern.exec(stdout))) last = match;
  if (!last) return { outside: stdout };
  return {
    json: last[1],
    outside: stdout.slice(0, last.index) + stdout.slice(last.index + last[0].length),
  };
}

export type VerdictStatus = "ok" | "partial" | "failed";
export interface RecordFact {
  postedAt?: string;
  note?: string;
  /** Comment status in the app store; a draft was never posted. */
  status?: string;
  /** Last write to the record (ISO). It must fall inside this run. */
  updatedAt?: string;
}
export interface VerdictInput {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  runId: string;
  /** Calendar days (schedule timezone) the run started and finished on; a record may carry either. */
  days: string[];
  /** Upper bound of records for one run (params.maxVisit), when known. */
  maxRecords?: number;
  /** When the run started (ISO): a record must have been written at or after it. */
  startedAt: string;
  /** App comment records by canonical post URL, read after the process ended. */
  records: ReadonlyMap<string, RecordFact>;
}
export interface Verdict {
  status: VerdictStatus;
  reason?: string;
  result?: AsideResult;
  /** Set when the run met an account-level stop; the schedule pauses itself. */
  pause?: (typeof pausingBlockedCodes)[number];
  /** Records that passed the comparison with the app's comment store. */
  matched: number;
}

/** Canonical post URL or undefined; uses the same normalization as the comment store. */
export function canonicalPostUrl(value: string) {
  try {
    return parseNaverPostUrl(value).url;
  } catch {
    return undefined;
  }
}

/**
 * Pure verdict for one aside run. failed: the process or its report cannot be trusted.
 * partial: the report is valid but something stopped or does not match the app's records.
 * ok: exit 0, no CLI error, a valid report for this run and every record confirmed.
 */
export function judgeAsideRun(input: VerdictInput): Verdict {
  const fail = (reason: string, extra: Partial<Verdict> = {}): Verdict => ({ status: "failed", reason, matched: 0, ...extra });
  if (input.signal || input.exitCode !== 0) return fail("exit");
  const { json, outside } = lastJsonBlock(input.stdout);
  const cliText = asideCliText(outside);
  if (asideCliErrors.some((pattern) => pattern.test(cliText))) return fail("cli-error");
  if (json === undefined) return fail("no-result");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fail("schema");
  }
  const checked = asideResultSchema.safeParse(parsed);
  if (!checked.success) return fail("schema");
  const result = checked.data;
  if (result.runId !== input.runId) return fail("run-id-mismatch");
  const pause = result.blocked && (pausingBlockedCodes as readonly string[]).includes(result.blocked.code)
    ? (result.blocked.code as Verdict["pause"])
    : undefined;
  const processed = result.accepted + result.visited + result.commented + result.liked;
  if (result.blocked && processed === 0) return fail(`blocked:${result.blocked.code}`, { result, pause });
  if (result.accountVerified !== true) return fail("account-unverified", { result, pause });
  const startedAt = Date.parse(input.startedAt);
  // One app record confirms one post: the same post reported twice is counted once.
  const seen = new Set<string>();
  let duplicate = false;
  let matched = 0;
  for (const record of result.records) {
    const url = canonicalPostUrl(record.postUrl);
    if (url && seen.has(url)) {
      duplicate = true;
      continue;
    }
    if (url) seen.add(url);
    const fact = url ? input.records.get(url) : undefined;
    if (
      fact &&
      fact.status !== undefined &&
      fact.status !== "draft" &&
      fact.updatedAt !== undefined &&
      Date.parse(fact.updatedAt) >= startedAt &&
      fact.postedAt &&
      input.days.includes(fact.postedAt) &&
      input.days.some((day) => fact.note?.includes(`[${day} 루프]`))
    )
      matched++;
  }
  const partial = (reason: string): Verdict => ({ status: "partial", reason, result, pause, matched });
  if (result.blocked) return partial(`blocked:${result.blocked.code}`);
  if (input.maxRecords !== undefined && result.records.length > input.maxRecords) return partial("over-limit");
  if (duplicate) return partial("duplicate-record");
  if (matched !== result.records.length) return partial("record-mismatch");
  if (result.commented !== matched) return partial("count-mismatch");
  return { status: "ok", result, matched };
}
