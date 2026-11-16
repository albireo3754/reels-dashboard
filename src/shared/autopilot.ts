import { z } from "zod";
import type { Project } from "./contracts";
import { seoulDate, type Planning } from "./planning";
import { isActiveState, projectState } from "./project-state";

/**
 * After-work autopilot: pure queue, ranking and admission logic.
 * No React, Electron or Node dependency, so the renderer, the CLI and tests share it.
 * Nothing here talks to Linear or any model; callers pass in snapshots they already read.
 */

/** Automation never keeps more than this many items waiting for the user. */
export const maxAutoSlots = 3;

/** Local read/edit tools and the `reels` CLI. Publishing, uploads and git writes are not allowed. */
export const defaultAllowedTools = ["Workflow", "Read", "Edit", "Write", "Glob", "Grep", "Bash(reels:*)", "Bash(git status:*)", "Bash(git diff:*)"] as const;

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM");
export const autopilotConfigSchema = z.strictObject({
  enabled: z.boolean(),
  /** What the scheduler should use as its period. The tick itself is cheap and does not enforce it. */
  intervalMinutes: z.number().int().min(5).max(1440),
  /** KST window in which an automatic tick may start work: from inclusive, to exclusive. */
  activeHours: z.strictObject({ from: clock, to: clock }),
  /** KST time after which the first tick refreshes today.md. */
  offWorkAt: clock,
  staleAfterMinutes: z.number().int().min(5).max(10080),
  /** A value above 3 is a configuration error, not something to clamp. */
  maxSlots: z.number().int().min(1).max(maxAutoSlots),
  leaseMinutes: z.number().int().min(5).max(1440),
  executor: z.strictObject({
    command: z.string().min(1),
    args: z.array(z.string()),
    timeoutMinutes: z.number().int().min(1).max(1440),
  }),
  /** Which Linear team the model-free refresh reads, and the workspace its issue links must belong to. */
  linear: z.strictObject({
    teamKey: z.string().regex(/^[A-Za-z0-9]{1,10}$/, "Use the team key, e.g. P").default("P"),
    workspaceUrlKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/, "Use the workspace URL key").default("rosy-trip2"),
  }).default(() => ({ teamKey: "P", workspaceUrlKey: "rosy-trip2" })),
  /** Where and with which permissions the worker runs. Only read from the user-data config. */
  execution: z.strictObject({
    /** The content project folder. A personal path, so it has no default and the executor refuses to run without it. */
    workdir: z.string().min(1).refine(value => value.startsWith("/") && !value.split("/").includes(".."), "Use an absolute path").optional(),
    permissionMode: z.enum(["acceptEdits", "default"]).default("acceptEdits"),
    allowedTools: z.array(z.string().min(1)).default(() => [...defaultAllowedTools]),
  }),
});
export type AutopilotConfig = z.infer<typeof autopilotConfigSchema>;
export const autopilotConfigFileSchema = autopilotConfigSchema.partial();
export const defaultAutopilotConfig = (): AutopilotConfig => ({
  enabled: true,
  intervalMinutes: 30,
  activeHours: { from: "09:00", to: "18:30" },
  offWorkAt: "18:30",
  staleAfterMinutes: 180,
  maxSlots: maxAutoSlots,
  leaseMinutes: 90,
  executor: {
    command: "claude",
    args: ["-p", "--strict-mcp-config", "--model", "sonnet", "--output-format", "json"],
    timeoutMinutes: 60,
  },
  linear: { teamKey: "P", workspaceUrlKey: "rosy-trip2" },
  execution: { permissionMode: "acceptEdits", allowedTools: [...defaultAllowedTools] },
});

const orderEntry = z.strictObject({
  key: z.string().min(1),
  score: z.number(),
  reasons: z.array(z.string()),
  kind: z.enum(["review", "active", "candidate"]).optional(),
});
const order = z.strictObject({ at: z.string().datetime(), items: z.array(orderEntry) });
export const reservationSchema = z.strictObject({
  id: z.string().min(1),
  key: z.string().min(1),
  mode: z.enum(["auto", "manual"]),
  /** `starting` is stored before the executor is spawned: it holds the slot while no pid exists yet. */
  status: z.enum(["starting", "running", "awaiting_review", "failed", "done"]),
  /** Groups the reservations one executor process works on. */
  runId: z.string().min(1).optional(),
  /** Shared by the reservations of one run. Only the executor that was started with it may work on them. */
  token: z.string().min(1),
  pid: z.number().int().positive().optional(),
  /** Start time of `pid`, so a reused pid is not mistaken for the executor. */
  processStartedAt: z.string().min(1).optional(),
  /** A `starting` reservation without a pid is taken back after this time. */
  startDeadline: z.string().datetime().optional(),
  leaseUntil: z.string().datetime(),
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
  reason: z.string().optional(),
  reportPath: z.string().optional(),
  /** What the finished run did: real changes (`progressed`), a report only (`prepared`) or a stop for the user. */
  outcome: z.enum(["progressed", "prepared", "needs_user"]).optional(),
  changes: z.array(z.strictObject({ path: z.string().max(500), summary: z.string().max(300) })).max(20).optional(),
  evidenceFingerprint: z.string().min(1),
});
export type Reservation = z.infer<typeof reservationSchema>;
export const autopilotStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  lastTick: z.strictObject({
    at: z.string().datetime(),
    fingerprint: z.string().optional(),
    result: z.string(),
    reason: z.string(),
  }).nullable(),
  paused: z.strictObject({ at: z.string().datetime(), reason: z.string() }).nullable(),
  reservations: z.array(reservationSchema),
  order: order.nullable(),
  previousOrder: order.nullable(),
  /** The KST day whose today.md was last written after offWorkAt. */
  todayDate: z.string().optional(),
});
export type AutopilotState = z.infer<typeof autopilotStateSchema>;
export const emptyAutopilotState = (): AutopilotState => ({
  schemaVersion: 1, lastTick: null, paused: null, reservations: [], order: null, previousOrder: null,
});

export type LinearIssue = NonNullable<Planning["linear"]>["issues"][number];
export type LinearClass = "active" | "review" | "candidate" | "ignore";
export type QueueKind = "review" | "active" | "candidate";

const reviewName = /review|검토|리뷰/i;
const inboxName = /^\s*in\s*box\s*$|인박스/i;
/**
 * Linear state to autopilot queue. A closed type (completed, canceled, duplicate) is ignored whatever its name.
 * Every other type (triage, backlog, unstarted, started) whose state name says Inbox or review waits for the
 * user, so a team that names its Inbox column on an unstarted or backlog state still counts toward occupancy
 * and never feeds the automatic pool. Then triage is review, started is active, backlog and unstarted are candidates.
 */
export function classifyLinear(issue: Pick<LinearIssue, "state" | "stateName">): LinearClass {
  if (issue.state !== "triage" && issue.state !== "backlog" && issue.state !== "unstarted" && issue.state !== "started") return "ignore";
  if (issue.stateName && (inboxName.test(issue.stateName) || reviewName.test(issue.stateName))) return "review";
  switch (issue.state) {
    case "triage": return "review";
    case "started": return "active";
    default: return "candidate";
  }
}

export interface RawItem {
  key: string;
  kind: QueueKind;
  source: "linear" | "dashboard" | "both" | "ledger";
  title: string;
  url?: string;
  identifier?: string;
  projectId?: string;
  stage?: Project["stage"];
  stateName?: string;
  nextAction?: string;
  dueDate?: string | null;
  priority?: number;
  /** The Dashboard project's own working order (1 first), set by the user. */
  order?: number;
  blockedBy: string[];
  subIssues?: { open: number; total: number };
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  /** Linear's own description as the last refresh stored it; handed to the worker as input evidence. */
  description?: string;
  localNotes?: string;
  resources?: { role: string; label: string; path: string }[];
  /** Set when a ledger reservation waits for the user's review of this item. */
  reservationId?: string;
  reportPath?: string;
  outcome?: Reservation["outcome"];
  changes?: Reservation["changes"];
}
export interface QueueItem extends RawItem { score: number; reasons: string[]; }

export type Freshness =
  | { ok: true; syncedAt: string }
  | { ok: false; reason: "linear_missing" | "linear_stale" | "linear_window"; detail: string; syncedAt?: string };
export interface Queue {
  active: QueueItem[];
  review: QueueItem[];
  candidates: QueueItem[];
  /** Distinct review-queue keys, including reservations that wait for review. */
  occupancy: number;
  freshness: Freshness;
}

const kindRank: Record<QueueKind, number> = { review: 3, active: 2, candidate: 1 };
const earlier = (a?: string | null, b?: string | null) => (a && b ? (a < b ? a : b) : (a ?? b ?? null));

/** The one key a Linear issue and a Dashboard project share. */
export const linearKey = (issue: Pick<LinearIssue, "id" | "projectId">) => issue.projectId ?? `linear:${issue.id}`;

const defined = <T extends object>(value: T) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
/** Two entries for one key: fields of the first win, gaps fill from the second, the stronger kind stays. */
function merge(first: RawItem, second: RawItem): RawItem {
  return {
    ...defined(second), ...defined(first),
    key: first.key,
    kind: kindRank[second.kind] > kindRank[first.kind] ? second.kind : first.kind,
    source: first.source === second.source ? first.source : "both",
    dueDate: earlier(first.dueDate, second.dueDate),
    blockedBy: [...new Set([...first.blockedBy, ...second.blockedBy])],
  };
}

export interface QueueInput {
  planning: Planning;
  projects: Project[];
  ledger: readonly Reservation[];
  now: Date;
  config: Pick<AutopilotConfig, "staleAfterMinutes">;
}

export function freshnessOf(planning: Planning, now: Date, config: Pick<AutopilotConfig, "staleAfterMinutes">): Freshness {
  const linear = planning.linear;
  if (!linear) return { ok: false, reason: "linear_missing", detail: "Linear 가져오기 결과가 없어요." };
  const age = now.getTime() - Date.parse(linear.syncedAt);
  if (age > config.staleAfterMinutes * 60_000)
    return { ok: false, reason: "linear_stale", syncedAt: linear.syncedAt, detail: `Linear 조회가 ${Math.floor(age / 60_000)}분 전이라 ${config.staleAfterMinutes}분 기준을 넘었어요.` };
  const today = seoulDate(now);
  if (!(linear.window.from <= today && today < linear.window.to))
    return { ok: false, reason: "linear_window", syncedAt: linear.syncedAt, detail: `Linear 조회 구간 ${linear.window.from}~${linear.window.to}에 오늘(${today})이 없어요.` };
  return { ok: true, syncedAt: linear.syncedAt };
}

/** Source items before ranking, one per key. Review wins over active over candidate. */
function sourceItems(planning: Planning, projects: Project[], now: Date = new Date()): RawItem[] {
  const items = new Map<string, RawItem>();
  const add = (item: RawItem) => items.set(item.key, items.has(item.key) ? merge(items.get(item.key)!, item) : item);
  /** Linked projects with nothing left to do here: complete, or scheduled on every remaining channel. */
  const published = new Set<string>();
  for (const project of projects) {
    const view = projectState(project, now);
    if (!isActiveState(view.state)) { published.add(project.id); continue; }
    add({
      key: project.id, kind: view.needsUserReview ? "review" : "active", source: "dashboard",
      title: project.title, projectId: project.id, stage: project.stage, nextAction: project.nextAction, blockedBy: [],
      ...(project.priority !== undefined ? { order: project.priority } : {}),
      ...(project.localNotes ? { localNotes: project.localNotes } : {}),
      ...(project.resources?.length ? { resources: project.resources.map(({ role, label, path }) => ({ role, label, path })) } : {}),
    });
  }
  for (const issue of planning.linear?.issues ?? []) {
    const kind = classifyLinear(issue);
    if (kind === "ignore") continue;
    const key = linearKey(issue);
    // The Dashboard is the state of record: a linked project that is complete or only waiting on a booked
    // publish time does not come back through a Linear issue that is still open, whatever its kind.
    if (published.has(key)) continue;
    add({
      key, kind, source: "linear", title: issue.title, url: issue.url, identifier: issue.identifier,
      ...(issue.projectId ? { projectId: issue.projectId } : {}),
      ...(issue.stateName ? { stateName: issue.stateName } : {}),
      dueDate: issue.dueDate, ...(issue.priority !== undefined ? { priority: issue.priority } : {}),
      blockedBy: issue.blockedBy ?? [],
      ...(issue.subIssues ? { subIssues: issue.subIssues } : {}),
      ...(issue.createdAt ? { createdAt: issue.createdAt } : {}),
      ...(issue.updatedAt ? { updatedAt: issue.updatedAt } : {}),
      ...(issue.startedAt ? { startedAt: issue.startedAt } : {}),
      ...(issue.description ? { description: issue.description } : {}),
    });
  }
  return [...items.values()];
}

/** Keys of reservations waiting for review that no longer exist in Linear or the Dashboard. */
export function settledKeys(planning: Planning, projects: Project[], ledger: readonly Reservation[], now: Date = new Date()): string[] {
  const present = new Set(sourceItems(planning, projects, now).map(item => item.key));
  return ledger.filter(r => r.status === "awaiting_review" && !present.has(r.key)).map(r => r.key);
}

export function buildQueue({ planning, projects, ledger, now, config }: QueueInput): Queue {
  const items = new Map(sourceItems(planning, projects, now).map(item => [item.key, item]));
  for (const reservation of ledger) {
    if (reservation.status !== "awaiting_review") continue;
    const existing = items.get(reservation.key);
    const waiting = {
      reservationId: reservation.id,
      ...(reservation.reportPath ? { reportPath: reservation.reportPath } : {}),
      ...(reservation.outcome ? { outcome: reservation.outcome } : {}),
      ...(reservation.changes ? { changes: reservation.changes } : {}),
    };
    items.set(reservation.key, existing
      ? { ...existing, kind: "review", ...waiting }
      : { key: reservation.key, kind: "review", source: "ledger", title: reservation.key, blockedBy: [], ...waiting });
  }
  const ranked = rankItems([...items.values()], now);
  const review = ranked.filter(item => item.kind === "review");
  return {
    active: ranked.filter(item => item.kind === "active"),
    review,
    candidates: ranked.filter(item => item.kind === "candidate"),
    occupancy: review.length,
    freshness: freshnessOf(planning, now, config),
  };
}

export const queueItems = (queue: Queue): QueueItem[] => [...queue.review, ...queue.active, ...queue.candidates];
/** Finds an item by its key or, when unambiguous, its Linear identifier. */
export function findItem(queue: Queue, ref: string): QueueItem | undefined {
  const all = queueItems(queue);
  const exact = all.find(item => item.key === ref);
  if (exact) return exact;
  const byIdentifier = all.filter(item => item.identifier?.toLowerCase() === ref.toLowerCase());
  return byIdentifier.length === 1 ? byIdentifier[0] : undefined;
}

const stageScore: Record<Project["stage"], number> = { idea: 0, captured: 4, selected: 8, editing: 12, review: 14, done: 0, published: 0 };
const priorityScore = [0, 30, 20, 10, 0];
const priorityName = ["", "Urgent", "High", "Medium", "Low"];
const dayMs = 86_400_000;
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / dayMs;

/**
 * Scores items from facts the snapshots show. Linear priority is one weight among several,
 * so an urgent item can fall behind a blocked-free one with a nearer deadline or less left to do.
 */
export function rankItems(items: readonly RawItem[], now: Date): QueueItem[] {
  const today = seoulDate(now);
  const ranked = items.map((item): QueueItem => {
    let score = 0;
    const reasons: string[] = [];
    const gain = (points: number, reason: string) => { score += points; reasons.push(reason); };
    if (item.dueDate) {
      const days = dayNumber(item.dueDate) - dayNumber(today);
      if (days < 0) gain(60 + Math.min(20, -days * 2), `마감 ${-days}일 경과 (${item.dueDate})`);
      else if (days === 0) gain(55, "오늘 마감");
      else if (days <= 2) gain(40, `마감 ${days}일 전 (${item.dueDate})`);
      else if (days <= 7) gain(20, `마감 ${days}일 전 (${item.dueDate})`);
      else gain(5, `마감 ${item.dueDate}`);
    }
    if (item.blockedBy.length) gain(-80, `차단됨: ${item.blockedBy.join(", ")}`);
    if (item.subIssues && item.subIssues.total > 0) {
      if (item.subIssues.open === 0) gain(15, "남은 하위 이슈 없음");
      else if (item.subIssues.open <= 4) gain(12 - item.subIssues.open * 3, `남은 하위 이슈 ${item.subIssues.open}개`);
    }
    if (item.priority && item.priority >= 1 && item.priority <= 4 && priorityScore[item.priority] > 0)
      gain(priorityScore[item.priority], `Linear 우선순위 ${priorityName[item.priority]}`);
    // The user's own order is one weight too: #1 counts like Urgent, fading by 2 per place.
    if (item.order !== undefined) gain(Math.max(2, 32 - item.order * 2), `작업 순번 ${item.order}`);
    const since = item.updatedAt ?? item.createdAt;
    if (since && Number.isFinite(Date.parse(since))) {
      const waited = Math.max(0, Math.floor((now.getTime() - Date.parse(since)) / dayMs));
      const points = item.kind === "review" ? Math.min(20, waited * 2) : Math.min(5, Math.floor(waited / 2));
      if (points > 0) gain(points, `${waited}일째 기다림`);
    }
    if (item.stage && stageScore[item.stage] > 0) gain(stageScore[item.stage], `진척: ${item.stage}`);
    return { ...item, score, reasons: reasons.length ? reasons : ["특별한 근거 없음"] };
  });
  return ranked.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
}

export interface AdmissionInput {
  occupancy: number;
  /** Running reservations, automatic and manual. */
  runningReservations: number;
  mode: "auto" | "manual";
  maxSlots?: number;
  /** Eligible candidate count; the result never exceeds it. */
  candidates?: number;
}
/** How many new runs may start now. Manual has no limit; callers name the items themselves. */
export function admission({ occupancy, runningReservations, mode, maxSlots = maxAutoSlots, candidates }: AdmissionInput): number {
  if (mode === "manual") return candidates ?? Number.POSITIVE_INFINITY;
  const limit = Math.min(maxSlots, maxAutoSlots);
  if (occupancy >= limit) return 0;
  const free = Math.max(0, limit - occupancy - runningReservations);
  return Math.min(free, candidates ?? free, maxAutoSlots);
}

const hash53 = (text: string, seed: number) => {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
};
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
/** Non-cryptographic, stable digest. Only used to tell "same input" from "changed input". */
export const digest = (value: unknown) => hash53(stable(value), 0) + hash53(stable(value), 1);

export interface FingerprintInput {
  planning: Planning;
  projects: readonly Project[];
  ledger: readonly Reservation[];
  /** Only what changes the ranking or the slot count; intervals, leases and executor settings do not. */
  config: Pick<AutopilotConfig, "maxSlots">;
  /**
   * Keys in rank order. Time moves some ranking reasons (days waited, days to a deadline); folding in
   * the resulting order rather than those numbers means a tick reconsiders only when the order really
   * changed, not every day or every sync.
   */
  order?: readonly string[];
}
/**
 * The semantic input of a tick: what the items say, not when they were read. `syncedAt`, `updatedAt`,
 * tick times and `lastTick` are left out on purpose, so re-reading an unchanged Linear team keeps the
 * fingerprint. Freshness is judged separately from `syncedAt` by {@link freshnessOf}.
 */
export function fingerprint({ planning, projects, ledger, config, order }: FingerprintInput): string {
  return digest({
    linear: planning.linear && [...planning.linear.issues].sort((a, b) => (a.id < b.id ? -1 : 1)).map(i => ({
      id: i.id, title: i.title, state: i.state, stateName: i.stateName, priority: i.priority, dueDate: i.dueDate,
      blockedBy: i.blockedBy, subIssues: i.subIssues, projectId: i.projectId,
    })),
    projects: projects.map(p => ({ id: p.id, stage: p.stage, nextAction: p.nextAction })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    // `starting` becomes `running` without any change in meaning.
    ledger: ledger.map(r => ({ key: r.key, status: r.status === "starting" ? "running" : r.status, mode: r.mode, evidence: r.evidenceFingerprint }))
      .sort((a, b) => (a.key + a.status < b.key + b.status ? -1 : 1)),
    maxSlots: config.maxSlots,
    order,
  });
}

/** What changed about one item, so a failed or finished run is not repeated on the same evidence. */
export const evidenceFingerprint = (item: RawItem) => digest({
  kind: item.kind, stateName: item.stateName, priority: item.priority, dueDate: item.dueDate,
  blockedBy: item.blockedBy, subIssues: item.subIssues, stage: item.stage, nextAction: item.nextAction,
});

export interface Skipped { key: string; reason: "blocked" | "running" | "awaiting_review" | "failed_unchanged" | "done_unchanged" | "needs_user_unchanged" | "dashboard_only"; }
/** Extra score for continuing started work over starting something new when the evidence is otherwise equal. */
export const progressWeight = 3;
export const inFlight = (r: Reservation) => r.status === "starting" || r.status === "running";
/**
 * What automation may work on, in one ranking: existing runnable `active` items (Linear started without a
 * review or Inbox name) and new `candidate`s (backlog/unstarted). Linear is where the user's work lives, so the
 * pool is the Linear team's items plus the Dashboard cards linked to them by `projectId` (one item per key).
 * A Dashboard card with no Linear link is never picked automatically (manual runs still take it) and is listed
 * as `dashboard_only`. Review/Inbox items wait for the user and are never in the pool. Skipped items keep their
 * reason so `status` can say why.
 */
export function selectCandidates(queue: Queue, ledger: readonly Reservation[]): { eligible: QueueItem[]; skipped: Skipped[] } {
  const pool = [...queue.active, ...queue.candidates]
    .map(item => ({ item, rank: item.score + (item.kind === "active" ? progressWeight : 0) }))
    .sort((a, b) => b.rank - a.rank || a.item.key.localeCompare(b.item.key))
    .map(({ item }) => item);
  const eligible: QueueItem[] = [];
  const skipped: Skipped[] = [];
  for (const item of pool) {
    if (item.source === "dashboard") { skipped.push({ key: item.key, reason: "dashboard_only" }); continue; }
    const mine = ledger.filter(r => r.key === item.key);
    if (mine.some(inFlight)) { skipped.push({ key: item.key, reason: "running" }); continue; }
    if (mine.some(r => r.status === "awaiting_review")) { skipped.push({ key: item.key, reason: "awaiting_review" }); continue; }
    if (item.blockedBy.length) { skipped.push({ key: item.key, reason: "blocked" }); continue; }
    const evidence = evidenceFingerprint(item);
    const seen = mine.filter(r => (r.status === "failed" || r.status === "done") && r.evidenceFingerprint === evidence)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    if (seen) {
      skipped.push({ key: item.key, reason: seen.status === "failed" ? "failed_unchanged" : seen.outcome === "needs_user" ? "needs_user_unchanged" : "done_unchanged" });
      continue;
    }
    eligible.push(item);
  }
  return { eligible, skipped };
}

export interface TodayPick {
  key: string;
  kind: "review" | "active";
  title: string;
  /** The exact Linear URL, or the Dashboard project id when there is no link. */
  target: string;
  why: string[];
  /** The one decision or action needed. */
  decision: string;
  doneWhen: string;
  /** Taste, real experience or credentials are never guessed, so the user must decide. */
  userDecisionRequired: boolean;
  reportPath?: string;
  /** What the automatic run did, so real changes and a report-only preparation are shown apart. */
  outcome?: Reservation["outcome"];
  changes?: Reservation["changes"];
}
/** The single item to look at after work, or null when nothing needs the user. Never invents work. */
export function pickToday(queue: Queue): TodayPick | null {
  const review = queue.review[0];
  if (review) {
    const target = review.url ?? (review.projectId ? `project:${review.projectId}` : review.key);
    return {
      key: review.key, kind: "review", title: review.title, target, why: review.reasons,
      decision: review.outcome === "needs_user"
        ? "자동 작업이 근거 부족으로 멈췄어요. 보고서의 빈칸에 필요한 사실·취향·인증을 채워 주세요"
        : review.reportPath
          ? review.outcome === "progressed" ? "수행된 변경과 검증 근거를 보고 승인할지, 되돌릴지 결정" : "준비된 보고서를 보고 승인할지, 고칠 점을 남길지 결정"
          : "검토 후 승인 또는 수정 요청을 결정",
      doneWhen: review.reservationId
        ? `결정을 마치고 \`reels autopilot resolve ${review.key}\`로 닫기, 또는 Linear/Dashboard 상태가 바뀌어 큐에서 빠짐`
        : "Linear/Dashboard에서 검토 결과가 반영돼 리뷰 대기에서 빠짐",
      userDecisionRequired: true,
      ...(review.reportPath ? { reportPath: review.reportPath } : {}),
      ...(review.outcome ? { outcome: review.outcome } : {}),
      ...(review.changes ? { changes: review.changes } : {}),
    };
  }
  const active = queue.active.find(item => item.blockedBy.length === 0);
  if (!active) return null;
  const target = active.url ?? (active.projectId ? `project:${active.projectId}` : active.key);
  return {
    key: active.key, kind: "active", title: active.title, target, why: active.reasons,
    decision: active.nextAction?.trim() ? `다음 행동: ${active.nextAction.trim()}` : "저장된 다음 행동이 없어요. 다음 행동을 정해 주세요.",
    doneWhen: "다음 행동을 끝내거나 Linear/Dashboard 상태에 반영",
    userDecisionRequired: true,
  };
}

/** What the renderer may ask for: a read-only summary, never a way to start or change anything. */
export interface AutopilotBridge { get(): Promise<AutopilotView>; }

export interface AutopilotView {
  enabled: boolean;
  paused: AutopilotState["paused"];
  lastTick: AutopilotState["lastTick"];
  freshness: Freshness;
  /** Exactly one item or null; never invented. */
  today: TodayPick | null;
  counts: { active: number; review: number; candidates: number; occupancy: number; runningReservations: number; autoSlots: number };
}
/**
 * Read-only summary for a screen: what to look at today and how full the queue is. Counts include
 * issues without a due date (the calendar's week list hides those). Reclaim is previewed in memory only.
 */
export function computeAutopilotView({ planning, projects, state, config, now, probe }: {
  planning: Planning; projects: Project[]; state: AutopilotState; config: AutopilotConfig; now: Date; probe: ProcessProbe | ((pid: number) => boolean);
}): AutopilotView {
  const ledger = reclaim(state, now, probe).state.reservations;
  const queue = buildQueue({ planning, projects, ledger, now, config });
  const running = ledger.filter(inFlight).length;
  const limit = Math.min(config.maxSlots, maxAutoSlots);
  const { eligible } = selectCandidates(queue, ledger);
  return {
    enabled: config.enabled, paused: state.paused, lastTick: state.lastTick, freshness: queue.freshness, today: pickToday(queue),
    counts: {
      active: queue.active.length, review: queue.review.length, candidates: queue.candidates.length, occupancy: queue.occupancy, runningReservations: running,
      autoSlots: queue.freshness.ok ? admission({ occupancy: queue.occupancy, runningReservations: running, mode: "auto", maxSlots: limit, candidates: eligible.length }) : 0,
    },
  };
}

/** How a reservation's runner is checked. `startedAt` is optional: without it a live pid counts as the runner. */
export interface ProcessProbe {
  isAlive(pid: number): boolean;
  /** Start time of the process, in whatever form it was recorded; undefined when it cannot be read. */
  startedAt?(pid: number): string | undefined;
}
/** The recorded process is alive and, where both start times are known, is the same one (not a reused pid). */
export function runnerAlive(r: Pick<Reservation, "pid" | "processStartedAt">, probe: ProcessProbe): boolean {
  if (r.pid === undefined || !probe.isAlive(r.pid)) return false;
  if (!r.processStartedAt) return true;
  const current = probe.startedAt?.(r.pid);
  // An unreadable start time is not proof of a different process, so stay on the safe side.
  return current === undefined || current === r.processStartedAt;
}
/** How long a `starting` reservation may hold a slot without a pid. */
export const startDeadlineMs = 2 * 60_000;

/**
 * Gives slots back only when no runner exists: a `starting` reservation with no pid past its deadline,
 * or a `running` one whose process is dead (or is a different process under a reused pid). A lease that
 * has run out while the process is alive is not a reason to reclaim, because a second run of the same
 * key could then start beside the first; it is reported as `leaseExpiredAlive` and keeps its slot.
 */
export function reclaim(state: AutopilotState, now: Date, probeOrAlive: ProcessProbe | ((pid: number) => boolean)): { state: AutopilotState; reclaimed: string[]; leaseExpiredAlive: string[] } {
  const probe: ProcessProbe = typeof probeOrAlive === "function" ? { isAlive: probeOrAlive } : probeOrAlive;
  const reclaimed: string[] = [];
  const leaseExpiredAlive: string[] = [];
  const settle = (r: Reservation, reason: string): Reservation => {
    reclaimed.push(r.id);
    return { ...r, status: "failed", finishedAt: now.toISOString(), reason };
  };
  const reservations = state.reservations.map((r): Reservation => {
    if (r.status === "starting" && r.pid === undefined) {
      const deadline = r.startDeadline ? Date.parse(r.startDeadline) : Date.parse(r.createdAt) + startDeadlineMs;
      return deadline <= now.getTime() ? settle(r, "start_deadline") : r;
    }
    if (r.status !== "starting" && r.status !== "running") return r;
    if (!runnerAlive(r, probe)) return settle(r, "orphaned");
    if (Date.parse(r.leaseUntil) <= now.getTime()) leaseExpiredAlive.push(r.key);
    return r;
  });
  return { state: { ...state, reservations }, reclaimed, leaseExpiredAlive };
}

/** Drops finished bookkeeping older than a month; failed and done rows older than that no longer guard anything. */
export function prune(reservations: Reservation[], now: Date): Reservation[] {
  const cutoff = now.getTime() - 30 * dayMs;
  return reservations.filter(r => !((r.status === "failed" || r.status === "done") && Date.parse(r.finishedAt ?? r.createdAt) < cutoff));
}

export function seoulClock(at: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}
export const inActiveHours = (config: AutopilotConfig, now: Date) => {
  const time = seoulClock(now);
  return config.activeHours.from <= time && time < config.activeHours.to;
};
export const afterOffWork = (config: AutopilotConfig, now: Date) => seoulClock(now) >= config.offWorkAt;

export type TickResult =
  | "disabled" | "paused" | "outside_hours" | "state_unreadable" | "freshness" | "busy"
  | "queue_full" | "unchanged" | "no_candidates" | "no_slots" | "admitted" | "spawn_failed";
export interface TickInput {
  state: AutopilotState;
  planning: Planning;
  projects: Project[];
  config: AutopilotConfig;
  now: Date;
  probe: ProcessProbe | ((pid: number) => boolean);
  newId: () => string;
}
export interface TickPlan {
  result: Extract<TickResult, "queue_full" | "unchanged" | "no_candidates" | "no_slots" | "admitted">;
  reason: string;
  state: AutopilotState;
  queue: Queue;
  admitted: Reservation[];
  runId?: string;
  autoSlots: number;
  skipped: Skipped[];
  reclaimed: string[];
  /** Keys whose lease ran out while the runner is alive: not reclaimed, still holding a slot. */
  leaseExpiredAlive: string[];
}

const stampOrder = (queue: Queue, now: Date) => ({
  at: now.toISOString(),
  items: queueItems(queue).slice(0, 50).map(({ key, score, reasons, kind }) => ({ key, score, reasons, kind })),
});

const newReservations = (items: readonly QueueItem[], mode: Reservation["mode"], now: Date, config: AutopilotConfig, newId: () => string) => {
  const runId = newId();
  const token = newId();
  const leaseUntil = new Date(now.getTime() + config.leaseMinutes * 60_000).toISOString();
  const startDeadline = new Date(now.getTime() + startDeadlineMs).toISOString();
  const reservations = items.map((item): Reservation => ({
    id: newId(), key: item.key, mode, status: "starting", runId, token, startDeadline, leaseUntil,
    createdAt: now.toISOString(), evidenceFingerprint: evidenceFingerprint(item),
  }));
  return { runId, reservations };
};

/**
 * The decision part of an automatic tick, from reclaim to reservation. Pure: the caller holds the
 * lock, persists `state` and starts the executor, so a dry run is the same call without those steps.
 * New reservations are `starting`; the caller turns them into `running` once the executor has a pid.
 */
export function planTick({ state, planning, projects, config, now, probe, newId }: TickInput): TickPlan {
  const reclaimed = reclaim(state, now, probe);
  let next = reclaimed.state;
  const settle = new Set(settledKeys(planning, projects, next.reservations));
  if (settle.size)
    next = { ...next, reservations: next.reservations.map(r => r.status === "awaiting_review" && settle.has(r.key)
      ? { ...r, status: "done" as const, finishedAt: now.toISOString(), reason: "left_queue" } : r) };
  const queue = buildQueue({ planning, projects, ledger: next.reservations, now, config });
  const running = next.reservations.filter(inFlight).length;
  const order = queueItems(queue).map(item => item.key);
  const finish = (result: TickPlan["result"], reason: string, extra: Partial<TickPlan> = {}): TickPlan => {
    const reservations = prune([...next.reservations, ...(extra.admitted ?? [])], now);
    const settled: AutopilotState = { ...next, reservations };
    const expired = reclaimed.leaseExpiredAlive;
    const said = expired.length ? `lease_expired_alive: ${expired.join(", ")} 실행기가 살아 있어 회수하지 않았어요. ${reason}` : reason;
    return {
      result, queue, admitted: [], autoSlots: 0, skipped: [], reclaimed: reclaimed.reclaimed, leaseExpiredAlive: expired, ...extra,
      reason: said,
      state: {
        ...settled,
        lastTick: { at: now.toISOString(), fingerprint: fingerprint({ planning, projects, ledger: reservations, config, order }), result, reason: said },
      },
    };
  };
  const limit = Math.min(config.maxSlots, maxAutoSlots);
  if (queue.occupancy >= limit)
    return finish("queue_full", `기존 리뷰 대기 ${queue.occupancy}개가 한도 ${limit}개 이상이에요. 자동 실행은 시작하지 않아요.`);
  const before = fingerprint({ planning, projects, ledger: next.reservations, config, order });
  if (state.lastTick?.fingerprint === before)
    return finish("unchanged", "지난 tick 이후 순위·상태 입력이 같아요. 모델을 호출하지 않아요.");
  next = { ...next, previousOrder: next.order, order: stampOrder(queue, now) };
  const { eligible, skipped } = selectCandidates(queue, next.reservations);
  const slots = admission({ occupancy: queue.occupancy, runningReservations: running, mode: "auto", maxSlots: limit });
  const count = admission({ occupancy: queue.occupancy, runningReservations: running, mode: "auto", maxSlots: limit, candidates: eligible.length });
  if (count === 0)
    return finish(eligible.length === 0 ? "no_candidates" : "no_slots",
      eligible.length === 0 ? "시작할 수 있는 후보가 없어요." : `실행 중 예약 ${running}개가 남은 자리를 쓰고 있어요.`,
      { autoSlots: slots, skipped });
  const { runId, reservations } = newReservations(eligible.slice(0, count), "auto", now, config, newId);
  return finish("admitted", `후보 ${reservations.length}개를 예약했어요.`, { admitted: reservations, runId, autoSlots: slots, skipped });
}

/** The registered Workflow takes at most this many items per call, so a bigger manual batch is split into runs of this size. */
export const maxItemsPerRun = 3;
export interface ManualRun { runId: string; token: string; reservations: Reservation[]; }
export interface ManualPlan {
  state: AutopilotState;
  /** Every reservation made, across all runs. */
  admitted: Reservation[];
  /** The first run's id; see `runs` for all of them. */
  runId: string;
  /** One run per {@link maxItemsPerRun} items, each with its own id and token. */
  runs: ManualRun[];
  rejected: { ref: string; reason: string }[];
  items: QueueItem[];
}
/**
 * Manual runs ignore the slot limit and only start the items the caller names. There is no count limit
 * either: more than {@link maxItemsPerRun} items become several runs, each reserved and started like a single one.
 */
export function planManual({ state, queue, refs, config, now, probe, newId }: {
  state: AutopilotState; queue: Queue; refs: string[]; config: AutopilotConfig; now: Date; probe: ProcessProbe | ((pid: number) => boolean); newId: () => string;
}): ManualPlan {
  const next = reclaim(state, now, probe).state;
  const rejected: ManualPlan["rejected"] = [];
  const items: QueueItem[] = [];
  const keys = new Set<string>();
  for (const ref of refs) {
    const item = findItem(queue, ref);
    if (!item) { rejected.push({ ref, reason: "unknown_key" }); continue; }
    if (next.reservations.some(r => r.key === item.key && inFlight(r)) || keys.has(item.key)) {
      rejected.push({ ref, reason: "already_running" });
      continue;
    }
    keys.add(item.key);
    items.push(item);
  }
  const runs: ManualRun[] = [];
  for (let i = 0; i < items.length; i += maxItemsPerRun) {
    const { runId, reservations } = newReservations(items.slice(i, i + maxItemsPerRun), "manual", now, config, newId);
    runs.push({ runId, token: reservations[0].token, reservations });
  }
  const admitted = runs.flatMap(run => run.reservations);
  return { state: { ...next, reservations: [...next.reservations, ...admitted] }, admitted, runId: runs[0]?.runId ?? "", runs, rejected, items };
}

/**
 * Clear usage-limit signals only. Bare words such as "quota" or a number like 429 appear in ordinary
 * output, so they count only in the shapes a CLI or HTTP error uses.
 */
export const limitTrace = /usage[ _-]?limit|rate[ _-]?limit(?:ed)?|limit (?:reached|exceeded)|hit your (?:\w+ )?limit|quota (?:exceeded|exhausted)|exceeded (?:your |the )?quota|too many requests|(?:http|status|error)[ :]*429|사용량 (?:한도|제한)|한도(?:에)? 도달/i;

export interface RunOutput { code: number | null; stdout: string; stderr: string; timedOut?: boolean; error?: string; }
export interface RunVerdict {
  key: string; status: "awaiting_review" | "failed"; reason?: string; reportPath?: string;
  outcome?: NonNullable<Reservation["outcome"]>; changes?: NonNullable<Reservation["changes"]>;
}

/** Finds the last JSON object in `text` that has a boolean `passed`, tolerating prose around it. */
export function workflowResult(text: string): Record<string, unknown> | null {
  const found: Record<string, unknown>[] = [];
  const consider = (value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) found.push(value as Record<string, unknown>);
  };
  try { consider(JSON.parse(text.trim())); } catch { /* not a bare document */ }
  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) { try { consider(JSON.parse(text.slice(start, i + 1))); } catch { /* skip */ } break; }
    }
  }
  const direct = found.filter(v => typeof v.passed === "boolean");
  if (direct.length) return direct[direct.length - 1];
  // `claude -p --output-format json` wraps the answer as a string in `result`.
  for (const value of found.reverse())
    if (typeof value.result === "string" && value.result !== text) {
      const inner = workflowResult(value.result);
      if (inner) return inner;
    }
  return null;
}

/**
 * Turns the executor's output into per-reservation verdicts. A missing, null, partial, errored or
 * limit-hit result is never a success. `pause` asks the caller to stop automatic restarts.
 * A run that passed cleanly (exit 0, `passed: true`) is never paused for what its text says about limits;
 * a limit counts only together with a failed exit, `passed: false`, an error or a timeout.
 */
export function interpretRun(output: RunOutput, expected: { key: string }[], runDir: string): { verdicts: RunVerdict[]; pause: string | null; detail: string } {
  const failAll = (reason: string, pause: string | null = null) => ({
    verdicts: expected.map(({ key }): RunVerdict => ({ key, status: "failed", reason })), pause, detail: reason,
  });
  const result = output.error || output.timedOut ? null : workflowResult(output.stdout);
  const clean = result?.passed === true && output.code === 0 && result.incomplete !== true;
  const limited = !clean && limitTrace.test(`${output.stderr}\n${output.stdout}\n${output.error ?? ""}`);
  const limit = "limit_reached";
  if (output.error) return failAll(`executor_error: ${output.error.slice(0, 200)}`, limited ? limit : null);
  if (output.timedOut) return failAll("executor_timeout", limited ? limit : null);
  if (limited) return failAll("limit_reached", limit);
  if (!result) return failAll(output.code === 0 ? "no_result" : `exit_${output.code}`);
  if (result.incomplete === true) return failAll("workflow_incomplete", "workflow_incomplete");
  if (result.passed !== true) return failAll(`workflow_not_passed${typeof result.reason === "string" ? `: ${result.reason.slice(0, 200)}` : ""}`);
  if (output.code !== 0) return failAll(`exit_${output.code}`);
  const items = Array.isArray(result.items) ? result.items as Record<string, unknown>[] : [];
  const root = runDir.endsWith("/") ? runDir : `${runDir}/`;
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
  const verdicts = expected.map(({ key }): RunVerdict => {
    const item = items.find(entry => entry?.key === key);
    if (!item) return { key, status: "failed", reason: "missing_item" };
    const summary = typeof item.summary === "string" ? item.summary.slice(0, 300) : undefined;
    if (item.status === "blocked") return { key, status: "failed", reason: `blocked${summary ? `: ${summary}` : ""}` };
    if (item.status !== "progressed" && item.status !== "prepared" && item.status !== "needs_user") return { key, status: "failed", reason: "invalid_status" };
    const report = item.reportPath;
    if (typeof report !== "string" || !report.startsWith(root) || report.includes("..")) return { key, status: "failed", reason: "invalid_report_path" };
    const changes = (Array.isArray(item.changes) ? item.changes : [])
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      .map(entry => ({ path: text(entry.path, 500), summary: text(entry.summary, 300) }));
    const verification = Array.isArray(item.verification) ? item.verification.length : 0;
    // The workflow checks this too; a result that skipped the check must not pass as real progress.
    if (item.status === "progressed" && (!changes.length || changes.some(c => !c.path || !c.summary) || !verification))
      return { key, status: "failed", reason: "progressed_without_evidence" };
    if (item.status === "prepared" && changes.length) return { key, status: "failed", reason: "prepared_with_changes" };
    return {
      key, status: "awaiting_review", reportPath: report, outcome: item.status,
      ...(summary ? { reason: summary } : {}), ...(item.status === "progressed" ? { changes: changes.slice(0, 20) } : {}),
    };
  });
  return { verdicts, pause: null, detail: "passed" };
}

export const outcomeLabel: Record<NonNullable<Reservation["outcome"]>, string> = {
  progressed: "실제 변경을 수행했어요(변경 파일과 검증은 보고서 참고)",
  prepared: "변경 없는 준비 보고예요",
  needs_user: "근거가 부족해 멈췄어요(사용자 입력 필요)",
};
const stamp = (value: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));
/** today.md: the single item for after work, then the rest of the queue, kept as is. */
export function renderToday(date: string, pick: TodayPick | null, queue: Queue): string {
  const lines = [`# 오늘 볼 1개 - ${date}`, ""];
  if (pick) {
    lines.push(
      `- 항목: ${pick.title}`, `- 링크: ${pick.target}`, `- 왜 지금: ${pick.why.join(" / ")}`,
      `- 필요한 한 가지: ${pick.decision}`, `- 완료 기준: ${pick.doneWhen}`,
      ...(pick.outcome ? [`- 자동 작업 결과: ${outcomeLabel[pick.outcome]}`] : []),
      ...(pick.changes?.length ? ["- 수행한 변경:", ...pick.changes.map(c => `  - ${c.path}: ${c.summary}`)] : []),
      ...(pick.reportPath ? [`- 준비된 보고서: ${pick.reportPath}`] : []),
      ...(pick.userDecisionRequired ? ["- 사용자 결정 필요: 취향·실제 경험·인증은 자동으로 추정하지 않았어요."] : []),
    );
  } else lines.push("오늘 볼 것 없음. 리뷰 대기와 차단되지 않은 진행 중 항목이 없어요.");
  const rest = queueItems(queue).filter(item => item.key !== pick?.key && item.kind !== "candidate");
  lines.push("", "## 큐에 보존된 나머지", rest.length ? "" : "없음");
  for (const item of rest) lines.push(`- [${item.kind === "review" ? "리뷰 대기" : "진행 중"}] ${item.title} (${item.score}점: ${item.reasons.join(", ")})`);
  lines.push("", `리뷰 대기 ${queue.occupancy}개 / 진행 중 ${queue.active.length}개 / 후보 ${queue.candidates.length}개`);
  lines.push(queue.freshness.ok ? `Linear 조회: ${stamp(queue.freshness.syncedAt)}` : `Linear 최신성 미확인: ${queue.freshness.detail}`);
  return lines.join("\n") + "\n";
}
