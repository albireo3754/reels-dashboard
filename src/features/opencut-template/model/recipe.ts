import { z } from "zod";
import { localPathSchema } from "../../../shared/local-resources";
import {
  foodFocusTemplate,
  letterboxShortsTemplate,
  travelCaptionTemplate,
} from "./template";

const cue = z
  .strictObject({
    start: z.number().finite().nonnegative(),
    end: z.number().finite().positive(),
    text: z.string().trim().min(1).max(500),
  })
  .refine((v) => v.end > v.start, "자막 종료는 시작 뒤여야 해요.");

export const openCutRecipeSchema = z
  .strictObject({
    templateId: z.enum([
      travelCaptionTemplate.id,
      foodFocusTemplate.id,
      letterboxShortsTemplate.id,
    ]),
    title: z.string().trim().min(1).max(50),
    place: z.string().trim().max(50).default(""),
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
    captions: z.array(cue).max(200).default([]),
    notes: z.array(cue).max(20).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.templateId !== letterboxShortsTemplate.id) {
      if (!v.place)
        ctx.addIssue({
          code: "custom",
          path: ["place"],
          message: "장소명을 입력해주세요.",
        });
      if (!v.captions.length)
        ctx.addIssue({
          code: "custom",
          path: ["captions"],
          message: "본문 자막을 입력해주세요.",
        });
    } else {
      v.cuts.forEach((cut, i) => {
        if (cut.scale !== 1 || cut.x !== 0 || cut.y !== 0)
          ctx.addIssue({
            code: "custom",
            path: ["cuts", i],
            message:
              "상하단 쇼츠는 중앙 영상 영역에 맞춰요. 크롭은 가져오기 전에 준비해주세요.",
          });
      });
    }
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

export const openCutPackageSchema = z
  .strictObject({
    projectId: z.string().min(1).max(160),
    blogPath: localPathSchema.optional(),
    destination: localPathSchema,
    sources: z.array(localPathSchema).min(1).max(100),
    recipe: openCutRecipeSchema,
  })
  .superRefine((v, ctx) => {
    if (!v.blogPath && v.recipe.templateId !== letterboxShortsTemplate.id)
      ctx.addIssue({
        code: "custom",
        path: ["blogPath"],
        message: "여행·맛집 소개에는 등록된 블로그 원고가 필요해요.",
      });
  });
export type OpenCutPackageInput = z.infer<typeof openCutPackageSchema>;
