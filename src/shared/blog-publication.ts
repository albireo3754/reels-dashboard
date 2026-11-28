import { z } from "zod";
import { scheduledAtSchema } from "./publications";

const seoulTime = scheduledAtSchema.refine((value) => value.endsWith("+09:00"));

export const blogPublishRequest = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("now"), revision: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ mode: z.literal("scheduled"), revision: z.string().regex(/^[a-f0-9]{64}$/), scheduledAt: seoulTime }),
]);

export const blogPublishCliInput = z.strictObject({
  projectId: z.string().min(1).max(160),
  mode: z.enum(["now", "scheduled"]),
  scheduledAt: seoulTime.optional().describe("Required for scheduled mode. Include the +09:00 offset."),
}).refine(({ mode, scheduledAt }) => (mode === "scheduled") === (scheduledAt !== undefined), {
  message: "예약 발행을 요청할 때만 한국 시간(+09:00)으로 예약 시각을 입력해주세요.",
  path: ["scheduledAt"],
});

export type BlogPublishRequest = z.infer<typeof blogPublishRequest>;
export type BlogPublishCliInput = z.infer<typeof blogPublishCliInput>;
export type BlogPublishChoice = Omit<BlogPublishRequest & { mode: "now" }, "revision">
  | Omit<BlogPublishRequest & { mode: "scheduled" }, "revision">;

export interface BlogPublishLaunch {
  terminal: string;
  spaceName: string;
}

/** Interpret the input as Korean time, regardless of the computer's time zone. */
export function blogScheduledAt(value: string): string | undefined {
  const parsed = seoulTime.safeParse(`${value}:00+09:00`);
  return parsed.success ? parsed.data : undefined;
}
