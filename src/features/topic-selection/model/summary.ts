import type { TopicBoard } from "../../../shared/topic-pitch";

/** `다음 주 릴스 2편 남음 · 후보 7 (바로 1 · 편집 1 · 내 답 4 · 보류 1)` */
export function boardSummary(board: TopicBoard) {
  const gap = board.gaps.map((g) => `${g.week === "this" ? "이번 주" : "다음 주"} ${g.label} ${g.remaining}편 남음`).join(" · ");
  const c = board.counts;
  const parts = [
    c.picked && `선정 ${c.picked}`,
    c.ready && `바로 ${c.ready}`,
    c.needs_edit && `편집 ${c.needs_edit}`,
    c.needs_user && `내 답 ${c.needs_user}`,
    c.hold && `보류 ${c.hold}`,
  ].filter(Boolean);
  const pitches = `후보 ${board.items.length}${parts.length ? ` (${parts.join(" · ")})` : ""}`;
  return [gap, pitches].filter(Boolean).join(" · ");
}

