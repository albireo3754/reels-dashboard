import type { Project, Stage } from "./contracts";
import type { Publication, PublicationChannel } from "./publications";

/**
 * The one reading of where a project stands. Every consumer (board, totals, autopilot,
 * CLI/MCP output, derived reports) asks this instead of looking at `stage` alone.
 *
 * - `complete`: nothing left to do. Either work is marked done (`stage: done`, whatever the
 *   channels say) or the project is published and every target channel is live.
 * - `scheduled`: not done, at least one target channel is still to come, and every one of those
 *   has a booked publish time — whatever the stage (a new clip can be scheduled from review).
 *   It is waiting on the channel, not on a person. A passed time is reported, never promoted.
 * - `channel_pending`: published elsewhere, but a target channel is still planned or a draft.
 * - `review`: the project's own stage is review.
 * - `in_progress`: idea, captured, selected or editing.
 */
export const projectStates = ["complete", "scheduled", "channel_pending", "review", "in_progress"] as const;
export type ProjectState = (typeof projectStates)[number];
export const projectStateLabels: Record<ProjectState, string> = {
  complete: "완료",
  scheduled: "공개 예약 대기",
  channel_pending: "채널 남음",
  review: "검토 대기",
  in_progress: "진행 중",
};

export interface ProjectStateView {
  id: string;
  kind: NonNullable<Project["kind"]>;
  stage: Stage;
  state: ProjectState;
  /** True for the states a person has to look at next: review and channel_pending. */
  needsUserReview: boolean;
  /** Target channels that are not live yet, with their status. */
  pendingChannels: { channel: PublicationChannel; status: Exclude<Publication["status"], "published">; scheduledAt?: string }[];
  /** Scheduled channels whose booked time has passed without a confirmed live post. */
  scheduledPast: PublicationChannel[];
}

type StateInput = Pick<Project, "id" | "stage" | "kind" | "publications">;

export function projectState(project: StateInput, now: Date = new Date()): ProjectStateView {
  const pending = (project.publications ?? []).filter((p) => p.status !== "published");
  const pendingChannels = pending.map((p) => ({
    channel: p.channel,
    status: p.status as Exclude<Publication["status"], "published">,
    ...(p.scheduledAt ? { scheduledAt: p.scheduledAt } : {}),
  }));
  const scheduledPast = pending
    .filter((p) => p.status === "scheduled" && p.scheduledAt && Date.parse(p.scheduledAt) <= now.getTime())
    .map((p) => p.channel);
  let state: ProjectState;
  if (project.stage === "done") state = "complete";
  else if (pending.length && pending.every((p) => p.status === "scheduled")) state = "scheduled";
  else if (project.stage === "published") state = pending.length ? "channel_pending" : "complete";
  else if (project.stage === "review") state = "review";
  else state = "in_progress";
  return {
    id: project.id,
    kind: project.kind ?? "content",
    stage: project.stage,
    state,
    needsUserReview: state === "review" || state === "channel_pending",
    pendingChannels,
    scheduledPast,
  };
}

/** Active means a person or a production step still owes work: not complete, not only waiting on a booked time. */
export const isActiveState = (state: ProjectState) =>
  state === "review" || state === "channel_pending" || state === "in_progress";
