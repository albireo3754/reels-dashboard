import { projectStageLabels, projectKindLabels, type Dashboard, type Project, type Stage } from "../../../shared/contracts";
import type { AutopilotView } from "../../../shared/autopilot";
import { addDays, seoulDate, type Planning } from "../../../shared/planning";
import {
  publicationChannelLabels,
  publicationStatusLabels,
  videoFormatLabels,
  type PublicationChannel,
  type PublicationStatus,
} from "../../../shared/publications";
import { projectState, projectStateLabels, type ProjectState } from "../../../shared/project-state";
import { weeklyGoalsView, type WeeklyGoalsView } from "../../../shared/weekly-goals";

/**
 * A read-only picture of where the work stands, built from the same stores and rules the app uses
 * (`projectState`, `weeklyGoalsView`, the autopilot view). It never changes a project, and it carries
 * only what is safe to hand to another session: titles, stages, next actions, dates and the links of
 * live posts. Local paths, notes, resources and calendar links stay out.
 */
export const statusReportVersion = 1;
/** How far back "recently published" looks. */
export const recentDays = 14;

export interface ReportChannel {
  channel: PublicationChannel;
  label: string;
  status: PublicationStatus;
  statusLabel: string;
  /** `publishedAt` for live posts, `scheduledAt` for bookings. */
  at?: string;
  /** Only for live posts. */
  url?: string;
  /** The booked time passed without a confirmed live post. */
  overdue?: boolean;
}
export interface ReportProject {
  id: string;
  title: string;
  kind: string;
  priority?: number;
  stage: Stage;
  stageLabel: string;
  state: ProjectState;
  stateLabel: string;
  date: string;
  nextAction: string;
  channels: ReportChannel[];
}
export interface RecentPost { projectId: string; title: string; channel: PublicationChannel; label: string; day: string; url: string }
export interface ReportGroup { id: "ordered" | ProjectState; title: string; note: string; projects: ReportProject[] }
export interface StatusReport {
  version: number;
  generatedAt: string;
  /** Asia/Seoul calendar day of `generatedAt`. */
  today: string;
  sources: {
    dashboardUpdatedAt: string;
    planningUpdatedAt?: string;
    calendarSyncedAt?: string;
    linearSyncedAt?: string;
  };
  counts: Record<ProjectState, number> & { total: number; needsUser: number };
  autopilot: Pick<AutopilotView, "today" | "counts" | "freshness" | "enabled" | "paused"> | null;
  goals: WeeklyGoalsView;
  /** Work order first, then the rest by state. Complete projects are left out. */
  groups: ReportGroup[];
  recent: RecentPost[];
  warnings: string[];
}
export interface StatusReportInput {
  dashboard: Dashboard;
  planning: Planning;
  /** Null when the autopilot store cannot be read; the report then says so instead of guessing. */
  autopilot: AutopilotView | null;
  now: Date;
}

function channelsOf(project: Project, now: Date): ReportChannel[] {
  return (project.publications ?? []).map((p) => {
    const youtube = p.channel === "youtube" && p.format ? ` ${videoFormatLabels[p.format]}` : "";
    const overdue = p.status === "scheduled" && p.scheduledAt !== undefined && Date.parse(p.scheduledAt) <= now.getTime();
    return {
      channel: p.channel,
      label: `${publicationChannelLabels[p.channel]}${youtube}`,
      status: p.status,
      statusLabel: publicationStatusLabels[p.status],
      ...(p.status === "published" && p.publishedAt ? { at: p.publishedAt } : {}),
      ...(p.status === "scheduled" && p.scheduledAt ? { at: p.scheduledAt } : {}),
      ...(p.status === "published" && p.url ? { url: p.url } : {}),
      ...(overdue ? { overdue: true } : {}),
    };
  });
}

function view(project: Project, state: ProjectState, now: Date): ReportProject {
  return {
    id: project.id,
    title: project.title,
    kind: projectKindLabels[project.kind ?? "content"],
    ...(project.priority !== undefined ? { priority: project.priority } : {}),
    stage: project.stage,
    stageLabel: projectStageLabels[project.stage],
    state,
    stateLabel: projectStateLabels[state],
    date: project.date,
    nextAction: project.nextAction.trim(),
    channels: channelsOf(project, now),
  };
}

const clockFormat = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** "11. 13. 15:56", Seoul time. */
const seoulClockOf = (iso: string) => clockFormat.format(new Date(iso));
const byDateDesc = (a: ReportProject, b: ReportProject) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title);
const groupText: Record<Exclude<ProjectState, "complete">, { title: string; note: string }> = {
  review: { title: "검토 대기", note: "사람이 보고 결정할 차례예요. 작업 순서에 없는 것만 모았어요." },
  channel_pending: { title: "채널 남음", note: "어딘가에 게시됐지만 남은 채널이 있어요." },
  scheduled: { title: "공개 예약 대기", note: "남은 채널이 모두 예약돼 있어요. 시각이 지나도 게시 확인 전까지 여기 있어요." },
  in_progress: { title: "진행 중", note: "아이디어·촬영·선택·편집 단계예요." },
};

/**
 * A planned post can carry its Google Calendar event link, which encodes the calendar account.
 * Only the links of live posts leave the app.
 */
function withoutCalendarLinks(goals: WeeklyGoalsView): WeeklyGoalsView {
  const strip = (week: WeeklyGoalsView["thisWeek"]) => ({
    ...week,
    channels: week.channels.map((c) => ({ ...c, posts: c.posts.map((p) => ({ ...p, url: p.status === "published" ? p.url : "" })) })),
  });
  return { ...goals, thisWeek: strip(goals.thisWeek), nextWeek: strip(goals.nextWeek) };
}

export function buildStatusReport({ dashboard, planning, autopilot, now }: StatusReportInput): StatusReport {
  const today = seoulDate(now);
  const projects = dashboard.projects;
  const rows = projects.map((p) => ({ p, state: projectState(p, now).state }));
  const counts = { complete: 0, scheduled: 0, channel_pending: 0, review: 0, in_progress: 0, total: projects.length, needsUser: 0 };
  for (const { state } of rows) counts[state] += 1;
  counts.needsUser = counts.review + counts.channel_pending;

  const open = rows.filter(({ state }) => state !== "complete");
  const ordered = open
    .filter(({ p }) => p.priority !== undefined)
    .sort((a, b) => a.p.priority! - b.p.priority! || a.p.title.localeCompare(b.p.title))
    .map(({ p, state }) => view(p, state, now));
  const rest = (state: Exclude<ProjectState, "complete">): ReportGroup => ({
    id: state,
    ...groupText[state],
    projects: open
      .filter((row) => row.state === state && row.p.priority === undefined)
      .map(({ p }) => view(p, state, now))
      .sort(byDateDesc),
  });
  const groups: ReportGroup[] = [
    { id: "ordered", title: "작업 순서", note: "Dashboard에서 정한 순번(1이 먼저)이에요. 완료된 프로젝트는 빠져요.", projects: ordered },
    rest("review"),
    rest("channel_pending"),
    rest("scheduled"),
    rest("in_progress"),
  ];

  const since = addDays(today, -recentDays);
  const recent: RecentPost[] = projects
    .flatMap((p) =>
      (p.publications ?? []).flatMap((pub) =>
        pub.status === "published" && pub.publishedAt && pub.publishedAt > since && pub.publishedAt <= today
          ? [{ projectId: p.id, title: p.title, channel: pub.channel, label: publicationChannelLabels[pub.channel], day: pub.publishedAt, url: pub.url }]
          : [],
      ),
    )
    .sort((a, b) => b.day.localeCompare(a.day) || a.title.localeCompare(b.title));

  const warnings: string[] = [];
  for (const { p } of open)
    for (const c of channelsOf(p, now))
      if (c.overdue) warnings.push(`「${p.title}」 ${c.label} 예약 시각(${seoulClockOf(c.at!)})이 지났는데 게시 확인이 없어요.`);
  if (!planning.calendar) warnings.push("Google Calendar 사본이 없어 예약 일정은 프로젝트에 기록된 것만 셌어요.");
  if (autopilot === null) warnings.push("autopilot 상태를 읽지 못해 오늘 할 일을 비워 뒀어요.");
  else if (!autopilot.freshness.ok) warnings.push(`autopilot: ${autopilot.freshness.detail ?? autopilot.freshness.reason}`);

  return {
    version: statusReportVersion,
    generatedAt: now.toISOString(),
    today,
    sources: {
      dashboardUpdatedAt: dashboard.updatedAt,
      ...(planning.updatedAt ? { planningUpdatedAt: planning.updatedAt } : {}),
      ...(planning.calendar ? { calendarSyncedAt: planning.calendar.syncedAt } : {}),
      ...(planning.linear ? { linearSyncedAt: planning.linear.syncedAt } : {}),
    },
    counts,
    autopilot: autopilot
      ? { today: autopilot.today, counts: autopilot.counts, freshness: autopilot.freshness, enabled: autopilot.enabled, paused: autopilot.paused }
      : null,
    goals: withoutCalendarLinks(weeklyGoalsView(planning, projects, now)),
    groups,
    recent,
    warnings,
  };
}
