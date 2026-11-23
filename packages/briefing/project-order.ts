export const projectStates = [
  "complete",
  "scheduled",
  "channel_pending",
  "review",
  "in_progress",
] as const;
export type ProjectState = (typeof projectStates)[number];
export const projectStateLabels: Record<ProjectState, string> = {
  complete: "완료",
  scheduled: "공개 예약 대기",
  channel_pending: "채널 남음",
  review: "검토 대기",
  in_progress: "진행 중",
};

/** Active means a person or a production step still owes work: not complete, not only waiting on a booked time. */
export const isActiveState = (state: ProjectState) =>
  state === "review" || state === "channel_pending" || state === "in_progress";

const stateRank: Record<ProjectState, number> = {
  review: 0,
  channel_pending: 0,
  in_progress: 1,
  scheduled: 2,
  complete: 3,
};
const stageRank = new Map(
  [
    "review",
    "editing",
    "selected",
    "captured",
    "idea",
    "done",
    "published",
  ].map((stage, index) => [stage, index] as const),
);
type BoardItem = { priority?: number | null; stage: string };

/** Each surface supplies its resolved state and applies its own date/title tie-breakers. */
export function compareProductionPriority(
  a: BoardItem,
  b: BoardItem,
  stateA: ProjectState,
  stateB: ProjectState,
) {
  return (
    stateRank[stateA] - stateRank[stateB] ||
    (a.priority ?? Infinity) - (b.priority ?? Infinity) ||
    (stageRank.get(a.stage) ?? stageRank.size) -
      (stageRank.get(b.stage) ?? stageRank.size)
  );
}
