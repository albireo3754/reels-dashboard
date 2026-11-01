import { z } from "zod";

const relativeFile = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (s) =>
      !s.startsWith("/") && !s.includes("\\") && !s.split("/").includes(".."),
    "작업 폴더 안의 상대 경로를 사용해주세요.",
  );
export const experienceFormSchema = z
  .strictObject({
    version: z.literal(1),
    title: z.string().trim().min(1).max(200),
    introduction: z.string().max(3000),
    facts: z
      .array(
        z.strictObject({
          text: z.string().min(1).max(2000),
          source: z.string().min(1).max(1000),
          status: z.enum(["confirmed", "observed", "unverified"]),
        }),
      )
      .max(40),
    questions: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
          section: z.string().min(1).max(100),
          prompt: z.string().min(1).max(1000),
          help: z.string().max(2000).default(""),
          required: z.boolean().default(true),
          images: z
            .array(
              z.strictObject({
                path: relativeFile,
                caption: z.string().min(1).max(500),
              }),
            )
            .max(4)
            .default([]),
        }),
      )
      .min(1)
      .max(30),
  })
  .superRefine((form, ctx) => {
    if (new Set(form.questions.map((q) => q.id)).size !== form.questions.length)
      ctx.addIssue({ code: "custom", message: "질문 ID가 중복됐어요." });
  });
export const experienceAnswerSchema = z.strictObject({
  questionId: z.string().min(1).max(80),
  status: z.enum(["answered", "unknown", "omit"]),
  text: z.string().max(12000),
});
export const saveExperienceInput = z.strictObject({
  runId: z.string().uuid(),
  taskId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  answers: z.array(experienceAnswerSchema).max(30),
  submit: z.boolean().default(false),
});
export const experienceMediaInput = z.strictObject({
  runId: z.string().uuid(),
  questionId: z.string().min(1),
  imageIndex: z.number().int().min(0).max(3),
});
export type ExperienceForm = z.infer<typeof experienceFormSchema>;
export type ExperienceAnswer = z.infer<typeof experienceAnswerSchema>;
export interface ExperienceRecord {
  form: ExperienceForm;
  revision: number;
  answers: ExperienceAnswer[];
  status: "draft" | "submitted";
  updatedAt: string;
  sourceHashes: Record<string, string>;
  exports: string[];
}
