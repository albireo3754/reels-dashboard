import { koreanDateTime } from "../../shared/lib/format";

export const readableTime = (v?: string) =>
  koreanDateTime(v, "시각 미상", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
