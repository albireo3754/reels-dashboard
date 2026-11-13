import { koreanDateTime } from "../../shared/lib/format";

export type Choice = "undecided" | "included" | "excluded";
// Both the recover() guard and the retry button accept only a 64-hex digest.
export const isRecoveryDigest = (v: string) => /^[0-9a-f]{64}$/i.test(v);
export const readableTime = (v?: string) =>
  koreanDateTime(v, "시각 미상", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
