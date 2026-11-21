import type { AutopilotView } from "./autopilot";
import { maxAutoSlots } from "./autopilot";

const freshnessLabel = {
  linear_missing: "Linear 가져오기 결과가 없어요",
  linear_stale: "Linear 사본이 오래됐어요",
  linear_window: "Linear 조회 구간에 오늘이 없어요",
} as const;

/** One line of counts for the card. Occupancy is out of the automatic limit of three. */
export function statusLine(view: AutopilotView): string {
  const { review, active, occupancy, autoSlots } = view.counts;
  return `리뷰 대기 ${review} · 진행 중 ${active} · 점유 ${occupancy}/${maxAutoSlots} · 자동 슬롯 ${autoSlots}`;
}

/**
 * Why automatic runs are stopped, when something other than a full queue is the reason: the last tick
 * could not refresh Linear because the Keychain key is missing or rejected, or the copy is not fresh.
 * A full queue is not a problem to fix, so it has no notice here (the count line shows it).
 */
export function blockedNotice(view: AutopilotView): string | null {
  const last = view.lastTick;
  if (last?.result === "freshness" && /linear_auth_(missing|invalid)/.test(last.reason)) return "Linear 인증 필요 — 자동 실행 멈춤";
  if (!view.freshness.ok) return `${freshnessLabel[view.freshness.reason]} — 자동 실행 멈춤`;
  return null;
}
