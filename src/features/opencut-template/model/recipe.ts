import { z } from "zod";
import { localPathSchema } from "../../../shared/local-resources";
import { foodFocusTemplate, travelCaptionTemplate } from "./template";

const cue = z
  .strictObject({
    start: z.number().finite().nonnegative(),
    end: z.number().finite().positive(),
    text: z.string().trim().min(1).max(500),
  })
  .refine((v) => v.end > v.start, "자막 종료는 시작 뒤여야 해요.");

export const openCutRecipeSchema = z
  .strictObject({
    templateId: z.enum([travelCaptionTemplate.id, foodFocusTemplate.id]),
    title: z.string().trim().min(1).max(50),
    place: z.string().trim().min(1).max(50),
    cuts: z
      .array(
        z.strictObject({
          file: z
            .string()
            .min(1)
            .max(255)
            .regex(/^[^/\\\0]+$/),
          sourceIn: z.number().finite().nonnegative().default(0),
          length: z.number().finite().positive().max(60),
          rate: z.number().finite().min(0.25).max(4).default(1),
          scale: z.number().finite().min(0.1).max(5).default(1),
          x: z.number().finite().min(-3000).max(3000).default(0),
          y: z.number().finite().min(-3000).max(3000).default(0),
        }),
      )
      .min(1)
      .max(100),
    captions: z.array(cue).min(1).max(200),
    notes: z.array(cue).max(20).default([]),
  })
  .superRefine((v, ctx) => {
    const end = v.cuts.reduce((sum, c) => sum + c.length, 0);
    if (end > 180)
      ctx.addIssue({
        code: "custom",
        message: "템플릿 영상은 180초 이내여야 해요.",
      });
    for (const [name, cues] of [
      ["captions", v.captions],
      ["notes", v.notes],
    ] as const) {
      cues.forEach((c, i) => {
        if (c.end > end + 0.0001 || (i > 0 && c.start < cues[i - 1].end))
          ctx.addIssue({
            code: "custom",
            path: [name, i],
            message: "자막은 겹치지 않는 시간순이며 영상 안에 있어야 해요.",
          });
      });
    }
  });
export type OpenCutRecipe = z.infer<typeof openCutRecipeSchema>;

export const openCutPackageSchema = z.strictObject({
  projectId: z.string().min(1).max(160),
  blogPath: localPathSchema,
  destination: localPathSchema,
  sources: z.array(localPathSchema).min(1).max(100),
  recipe: openCutRecipeSchema,
});
export type OpenCutPackageInput = z.infer<typeof openCutPackageSchema>;
