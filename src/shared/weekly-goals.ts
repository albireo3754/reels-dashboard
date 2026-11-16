import type { z } from "zod";
import type { Project, Stage } from "./contracts";
import { addDays, weekStart, seoulDate, weekPlan, weeklyTargetsSchema, type Planning, type PlannedPost, type PlanningUpdate } from "./planning";
import { projectState } from "./project-state";
import type { PublicationChannel } from "./publications";

/**
 * The weekly rhythm: how many posts each channel should get per week, what is still missing this
 * week, and which finished videos to book next. Reads the Dashboard and the planning snapshot only;
 * it never books or posts anything on a channel.
 */
export const goalChannels = ["blog", "naver-clip", "instagram", "youtube"] as const satisfies readonly PublicationChannel[];
export type GoalChannel = (typeof goalChannels)[number];
export const goalChannelLabels: Record<GoalChannel, string> = { blog: "블로그", "naver-clip": "클립", instagram: "릴스", youtube: "쇼츠" };
/** Channels whose posts are videos that can be booked ahead. The blog is written, not booked. */
export const videoChannels = ["naver-clip", "instagram", "youtube"] as const satisfies readonly GoalChannel[];
export type VideoChannel = (typeof videoChannels)[number];

export const defaultWeeklyTargets: Record<GoalChannel, number> = { blog: 2, "naver-clip": 3, instagram: 2, youtube: 1 };
export type WeeklyTargets = z.infer<typeof weeklyTargetsSchema>;

/**
 * The target fields an update writes. The older single target is the Naver Clip one, so changing either keeps
 * the other in step; channels not given keep their current target.
 */
export function targetFields(current: Planning, update: Pick<PlanningUpdate, "weeklyTarget" | "weeklyTargets">): Partial<Pick<Planning, "weeklyTarget" | "weeklyTargets">> {
  if (!update.weeklyTargets && update.weeklyTarget === undefined) return {};
  const weeklyTargets = { ...weeklyTargetsOf(current), ...update.weeklyTargets, ...(update.weeklyTarget !== undefined ? { "naver-clip": update.weeklyTarget } : {}) };
  const clip = weeklyTargets["naver-clip"];
  return { weeklyTargets, ...(clip >= 1 ? { weeklyTarget: clip } : {}) };
}

/** Booked videos are kept at most this far ahead; the queue never proposes a slot past it. */
export const bookingHorizonDays = 14;

/** Saved targets, or the defaults with the older single Naver Clip target when nothing per channel was saved. */
export function weeklyTargetsOf(planning: Pick<Planning, "weeklyTarget" | "weeklyTargets">): WeeklyTargets {
  return planning.weeklyTargets ?? { ...defaultWeeklyTargets, "naver-clip": planning.weeklyTarget };
}

const readiness: Record<Stage, number> = { published: 0, review: 1, editing: 2, selected: 3, captured: 4, idea: 5, done: 6 };
/** A video is ready to book when its final file exists or the cut is waiting for review or already live elsewhere. */
export const isReadyToBook = (project: Project) =>
  project.stage === "review" || project.stage === "published" || Boolean(project.resources?.some(r => r.role === "final"));
const byWorkOrder = (a: Project, b: Project) =>
  (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER)
  || readiness[a.stage] - readiness[b.stage]
  || a.title.localeCompare(b.title, "ko");

/**
 * `reuse`: a Reel already live on Instagram with no Naver Clip entry yet. The weekly clip routine re-uploads
 * existing videos, so these fill clip slots after the projects planned for the clip itself.
 */
export interface GoalCandidate { projectId: string; title: string; stage: Stage; status: "planned" | "draft" | "reuse"; ready: boolean; nextAction: string; priority?: number }
export interface ChannelWeek {
  channel: GoalChannel; label: string; target: number;
  published: number; scheduled: number; remaining: number;
  posts: PlannedPost[];
  /** Projects that target this channel but are not booked or live yet, in the user's work order. */
  candidates: GoalCandidate[];
}
export interface WeekGoals { from: string; to: string; calendarCovered: boolean; channels: ChannelWeek[]; totals: { target: number; done: number; remaining: number } }

const candidate = (p: Project, status: GoalCandidate["status"], ready: boolean): GoalCandidate => ({
  projectId: p.id, title: p.title, stage: p.stage, status, ready, nextAction: p.nextAction,
  ...(p.priority !== undefined ? { priority: p.priority } : {}),
});
const reelDay = (p: Project) => p.publications?.find(x => x.channel === "instagram" && x.status === "published")?.publishedAt ?? "";

/**
 * Projects still to post on a channel: not complete, and the channel entry is planned or a draft, in the work
 * order. For Naver Clip the live Reels without a clip entry follow, newest first.
 */
function pendingFor(projects: Project[], channel: PublicationChannel, now: Date): GoalCandidate[] {
  const planned = projects
    .filter(p => projectState(p, now).state !== "complete")
    .flatMap(p => {
      const entry = p.publications?.find(x => x.channel === channel);
      return entry && (entry.status === "planned" || entry.status === "draft") ? [{ p, status: entry.status }] : [];
    })
    .sort((a, b) => byWorkOrder(a.p, b.p))
    .map(({ p, status }) => candidate(p, status, isReadyToBook(p)));
  if (channel !== "naver-clip") return planned;
  const reuse = projects
    .filter(p => p.stage !== "done" && reelDay(p) && !p.publications?.some(x => x.channel === "naver-clip"))
    .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER) || reelDay(b).localeCompare(reelDay(a)))
    .map(p => candidate(p, "reuse", true));
  return [...planned, ...reuse];
}

export function weekGoals(planning: Planning, projects: Project[], from: string, now: Date = new Date()): WeekGoals {
  const targets = weeklyTargetsOf(planning);
  const channels = goalChannels.map(channel => {
    const target = targets[channel];
    const week = weekPlan(planning, projects, from, channel, target);
    return {
      channel, label: goalChannelLabels[channel], target,
      published: week.published, scheduled: week.scheduled, remaining: Math.max(0, target - week.posts.length),
      posts: week.posts, candidates: pendingFor(projects, channel, now),
    };
  });
  const target = channels.reduce((sum, c) => sum + c.target, 0);
  const done = channels.reduce((sum, c) => sum + Math.min(c.target, c.posts.length), 0);
  const first = weekPlan(planning, projects, from, "naver-clip");
  return { from, to: addDays(from, 7), calendarCovered: first.covered, channels, totals: { target, done, remaining: target - done } };
}

export interface Booking { projectId: string; title: string; at: string; day: string; source: "dashboard" | "calendar" }
export interface Slot { day: string; projectId: string; title: string }
export interface ChannelQueue {
  channel: VideoChannel; label: string; target: number;
  /** Two weeks of posts: `target * 2`. */
  cap: number;
  booked: Booking[];
  /** Bookings later than the horizon; they still count as booked, but the queue never adds more there. */
  beyond: Booking[];
  open: number;
  full: boolean;
  /** Finished videos waiting for a booking, in the user's work order. */
  ready: GoalCandidate[];
  /** Planned for this channel but not finished yet. */
  inProduction: number;
  /** The next days to book, one ready video each, never past the horizon or the cap. */
  slots: Slot[];
}
export interface BookingQueue { now: string; until: string; horizonDays: number; channels: ChannelQueue[] }

const dayOf = (at: string) => seoulDate(at);

export function bookingQueue(planning: Planning, projects: Project[], now: Date = new Date()): BookingQueue {
  const targets = weeklyTargetsOf(planning);
  const today = seoulDate(now);
  const until = addDays(today, bookingHorizonDays);
  const channels = videoChannels.map(channel => {
    const target = targets[channel];
    const cap = target * 2;
    const all = new Map<string, Booking>();
    for (const event of planning.calendar?.events ?? []) {
      if (event.cancelled || event.channel !== channel || Date.parse(event.start) <= now.getTime()) continue;
      const project = projects.find(p => p.id === event.projectId);
      if (project?.publications?.some(p => p.channel === channel && p.status === "published")) continue;
      all.set(event.projectId, { projectId: event.projectId, title: project?.title ?? event.title, at: event.start, day: dayOf(event.start), source: "calendar" });
    }
    // A booking recorded on the project is the latest word on that project's time.
    for (const project of projects) {
      const entry = project.publications?.find(p => p.channel === channel);
      if (entry?.status !== "scheduled" || !entry.scheduledAt || Date.parse(entry.scheduledAt) <= now.getTime()) continue;
      all.set(project.id, { projectId: project.id, title: project.title, at: entry.scheduledAt, day: dayOf(entry.scheduledAt), source: "dashboard" });
    }
    const sorted = [...all.values()].sort((a, b) => a.at.localeCompare(b.at));
    const booked = sorted.filter(b => b.day < until);
    const beyond = sorted.filter(b => b.day >= until);
    const open = Math.max(0, cap - booked.length - beyond.length);
    const pending = pendingFor(projects, channel, now).filter(c => !all.has(c.projectId));
    const ready = pending.filter(c => c.ready);
    const slots = target > 0 ? spread(sorted.map(b => b.day), ready, Math.min(open, ready.length), today, until, Math.max(1, Math.floor(7 / target))) : [];
    return {
      channel, label: goalChannelLabels[channel], target, cap, booked, beyond, open, full: open === 0,
      ready, inProduction: pending.length - ready.length, slots,
    };
  });
  return { now: now.toISOString(), until, horizonDays: bookingHorizonDays, channels };
}

const gap = (a: string, b: string) => Math.abs(Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000;
/**
 * Picks free days from tomorrow up to (not including) `until`, first keeping `step` days from every booking
 * (an even weekly rhythm), then any free day if that left items unplaced. Earlier days fill first.
 */
function spread(taken: string[], items: GoalCandidate[], wanted: number, today: string, until: string, step: number): Slot[] {
  const days: string[] = [];
  for (let day = addDays(today, 1); day < until; day = addDays(day, 1)) days.push(day);
  const used = [...taken];
  const picked: string[] = [];
  for (const minimum of [step, 1]) {
    for (const day of days) {
      if (picked.length >= wanted) break;
      if (used.every(t => gap(t, day) >= minimum)) { picked.push(day); used.push(day); }
    }
  }
  return picked.sort().map((day, index) => ({ day, projectId: items[index].projectId, title: items[index].title }));
}

export interface WeeklyGoalsView { thisWeek: WeekGoals; nextWeek: WeekGoals; queue: BookingQueue; targets: WeeklyTargets }
export function weeklyGoalsView(planning: Planning, projects: Project[], now: Date = new Date()): WeeklyGoalsView {
  const from = weekStart(now);
  return {
    thisWeek: weekGoals(planning, projects, from, now),
    nextWeek: weekGoals(planning, projects, addDays(from, 7), now),
    queue: bookingQueue(planning, projects, now),
    targets: weeklyTargetsOf(planning),
  };
}
