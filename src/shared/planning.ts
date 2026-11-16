import { z } from "zod";
import type { Project } from "./contracts";
import { isShorts, publicationChannels, type Publication, type PublicationChannel } from "./publications";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Invalid calendar date");
const link = (hosts: string[]) => z.string().url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && hosts.includes(url.hostname);
}, "Use the provider's HTTPS link");
const calendarLink = link(["calendar.google.com", "www.google.com"]);
const linearLink = link(["linear.app"]);
const windowSchema = z.object({ from: date, to: date }).refine(v => v.from < v.to);
export const calendarImportSchema = z.strictObject({
  url: calendarLink,
  syncedAt: z.string().datetime(),
  window: windowSchema,
  events: z.array(z.strictObject({
    id: z.string().min(1).max(500),
    title: z.string().min(1).max(500),
    url: calendarLink,
    start: z.string().datetime({ offset: true }),
    projectId: z.string().min(1).max(500),
    channel: z.enum(publicationChannels),
    cancelled: z.boolean().default(false),
  })).max(500),
}).superRefine((value, ctx) => {
  if (new Set(value.events.map(e => e.id)).size !== value.events.length)
    ctx.addIssue({ code: "custom", message: "Duplicate calendar event IDs" });
});
export const linearImportSchema = z.strictObject({
  url: linearLink,
  syncedAt: z.string().datetime(),
  window: windowSchema,
  issues: z.array(z.strictObject({
    id: z.string().min(1).max(500),
    identifier: z.string().min(1).max(80),
    title: z.string().min(1).max(500),
    url: linearLink,
    dueDate: date.nullable(),
    state: z.enum(["triage", "backlog", "unstarted", "started", "completed", "canceled", "duplicate"]),
    // Optional so snapshots saved before the autopilot still parse unchanged.
    stateName: z.string().min(1).max(200).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    createdAt: z.string().datetime({ offset: true }).optional(),
    updatedAt: z.string().datetime({ offset: true }).optional(),
    startedAt: z.string().datetime({ offset: true }).optional(),
    blockedBy: z.array(z.string().min(1).max(80)).max(50).optional(),
    subIssues: z.strictObject({ open: z.number().int().min(0), total: z.number().int().min(0) }).optional(),
    projectId: z.string().min(1).max(500).optional(),
    // Linear's own text, kept so the autopilot worker starts from the source and not from the title alone.
    description: z.string().max(20_000).optional(),
  })).max(500),
}).superRefine((value, ctx) => {
  if (new Set(value.issues.map(e => e.id)).size !== value.issues.length)
    ctx.addIssue({ code: "custom", message: "Duplicate Linear issue IDs" });
});
const goalCount = z.number().int().min(0).max(14);
/** Posts per week for each goal channel (blog, Naver Clip, Reels, Shorts). See weekly-goals.ts. */
export const weeklyTargetsSchema = z.strictObject({ blog: goalCount, "naver-clip": goalCount, instagram: goalCount, youtube: goalCount });
export const planningSchema = z.strictObject({
  schemaVersion: z.literal(1),
  updatedAt: z.string().datetime(),
  /** The Naver Clip target saved before per-channel targets; kept equal to `weeklyTargets["naver-clip"]` when that is 1 or more. */
  weeklyTarget: z.number().int().min(1).max(30),
  /** Omitted in files saved before per-channel targets; readers then use the defaults. */
  weeklyTargets: weeklyTargetsSchema.optional(),
  calendar: calendarImportSchema.nullable(),
  linear: linearImportSchema.nullable(),
});
export type Planning = z.infer<typeof planningSchema>;
export const planningUpdateSchema = z.strictObject({
  expectedUpdatedAt: z.string().datetime(),
  weeklyTarget: z.number().int().min(1).max(30).optional(),
  /** Only the channels given change; the others keep their current target. */
  weeklyTargets: weeklyTargetsSchema.partial().optional(),
  calendar: calendarImportSchema.optional(),
  linear: linearImportSchema.optional(),
}).refine(v => v.weeklyTarget !== undefined || (v.weeklyTargets !== undefined && Object.keys(v.weeklyTargets).length > 0) || v.calendar !== undefined || v.linear !== undefined, "No update supplied");
export type PlanningUpdate = z.infer<typeof planningUpdateSchema>;
export interface PlanningBridge {
  get(): Promise<Planning>;
  update(input: PlanningUpdate): Promise<Planning>;
}
export const emptyPlanning = (): Planning => ({
  schemaVersion: 1, updatedAt: "1970-01-01T00:00:00.000Z", weeklyTarget: 3, calendar: null, linear: null,
});
export function seoulDate(at: Date | string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at));
}
export function addDays(day: string, count: number): string {
  const at = new Date(`${day}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + count);
  return at.toISOString().slice(0, 10);
}
/** First day of the Seoul week containing `at`. Weeks run Sunday to Saturday. */
export function weekStart(at: Date): string {
  const today = seoulDate(at);
  return addDays(today, -new Date(`${today}T12:00:00Z`).getUTCDay());
}
export interface PlannedPost { key: string; projectId: string; title: string; day: string; start?: string; status: "published" | "planned"; url: string; }
/** `target` defaults to the older single target; callers that know the channel's own target pass it. */
export function weekPlan(planning: Planning, projects: Project[], from: string, channel: PublicationChannel, target: number = planning.weeklyTarget) {
  const to = addDays(from, 7);
  // The YouTube goal is Shorts: a long-form video (format omitted or long) is not counted.
  const on = (p: Publication) => p.channel === channel && (channel !== "youtube" || isShorts(p));
  const rows = new Map<string, PlannedPost>();
  // Calendar dates are authoritative for upcoming events; project.date is never used.
  for (const event of planning.calendar?.events ?? []) {
    const day = seoulDate(event.start);
    if (event.cancelled || event.channel !== channel || day < from || day >= to) continue;
    const project = projects.find(p => p.id === event.projectId);
    if (project?.publications?.some(p => on(p) && p.status === "published")) continue;
    const key = `${event.projectId}:${channel}`;
    rows.set(key, { key, projectId: event.projectId, title: project?.title ?? event.title, day, start: event.start, status: "planned", url: event.url });
  }
  // A booking recorded on the project wins over the calendar copy of the same project.
  for (const project of projects) {
    const booked = project.publications?.find(p => on(p) && p.status === "scheduled");
    if (!booked?.scheduledAt) continue;
    const day = seoulDate(booked.scheduledAt);
    const key = `${project.id}:${channel}`;
    if (day < from || day >= to) { rows.delete(key); continue; }
    rows.set(key, { key, projectId: project.id, title: project.title, day, start: booked.scheduledAt, status: "planned", url: rows.get(key)?.url ?? "" });
  }
  for (const project of projects) {
    const post = project.publications?.find(p => on(p) && p.status === "published");
    if (!post?.publishedAt || post.publishedAt < from || post.publishedAt >= to) continue;
    const key = `${project.id}:${channel}`;
    rows.set(key, { key, projectId: project.id, title: project.title, day: post.publishedAt, status: "published", url: post.url });
  }
  const posts = [...rows.values()].sort((a, b) => a.day.localeCompare(b.day) || (a.start ?? "").localeCompare(b.start ?? "") || a.title.localeCompare(b.title));
  const published = posts.filter(p => p.status === "published").length;
  const scheduled = posts.length - published;
  return { from, to, posts, published, scheduled, remaining: Math.max(0, target - posts.length),
    covered: Boolean(planning.calendar && planning.calendar.window.from <= from && planning.calendar.window.to >= to),
    issues: (planning.linear?.issues ?? []).filter(i => i.dueDate && i.dueDate >= from && i.dueDate < to && i.state !== "canceled" && i.state !== "duplicate"),
  };
}
