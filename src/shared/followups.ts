import { z } from "zod";
export const followupManifestSchema = z
  .strictObject({
    version: z.literal(1),
    reviewedAnswerIds: z.array(z.string().min(1)).max(30),
    tasks: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
          title: z.string().trim().min(1).max(300),
          kind: z.enum(["skill", "media", "research", "artifact", "other"]),
          sourceFile: z.string().min(1).max(1000),
          sourceQuote: z.string().trim().min(1).max(3000),
          instruction: z.string().trim().min(1).max(4000),
          executor: z.enum(["session", "sdk"]),
        }),
      )
      .max(30),
  })
  .superRefine((m, c) => {
    if (
      new Set(m.tasks.map((t) => t.id)).size !== m.tasks.length ||
      new Set(m.reviewedAnswerIds).size !== m.reviewedAnswerIds.length
    )
      c.addIssue({ code: "custom", message: "Duplicate task or answer ID" });
  });
export const openFollowupsInput = z.strictObject({
  runId: z.string().uuid(),
  expectedTaskId: z.string().min(1),
  evidence: z.array(z.string().min(1)).max(30).default([]),
});
export type FollowupTask = z.infer<
  typeof followupManifestSchema
>["tasks"][number] & {
  status: "pending" | "done" | "blocked";
  summary: string;
  evidence: Record<string, string>;
};
export interface Followups {
  returnStage: "draft" | "revise";
  tasks: FollowupTask[];
  reviewedAnswerIds: string[];
}
