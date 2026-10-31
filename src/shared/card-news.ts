import { z } from "zod";

export const cardTemplates = {
  hook: "훅",
  body: "본문",
  summary: "큰 요약",
  comparison: "비교표",
  follow: "팔로우",
} as const;
export const cardTemplateSchema = z
  .object({
    templateId: z.enum(["hook", "body", "summary", "comparison", "follow"]),
    text: z.string().max(600),
    notes: z.string().max(240).optional(),
    signature: z.string().max(60).optional(),
    table: z
      .object({
        columns: z.tuple([
          z.string().max(30),
          z.string().max(30),
          z.string().max(30),
        ]),
        rows: z
          .array(
            z.tuple([
              z.string().max(40),
              z.string().max(40),
              z.string().max(40),
            ]),
          )
          .min(1)
          .max(10),
      })
      .strict()
      .optional(),
  })
  .strict();
export const cardRoles = {
  hook: "도입 훅",
  explanation: "이유 설명",
  audience: "대상·변화",
  comparison: "숫자 비교",
  action: "행동·기한",
  follow: "팔로우 안내",
} as const;
export const cardPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    updatedAt: z.string(),
    title: z.string().trim().min(1).max(120),
    cards: z
      .array(
        z
          .object({
            id: z.uuid(),
            role: z.enum(
              Object.keys(cardRoles) as [
                keyof typeof cardRoles,
                ...Array<keyof typeof cardRoles>,
              ],
            ),
            templateId: cardTemplateSchema.shape.templateId.optional(),
            notes: cardTemplateSchema.shape.notes,
            signature: cardTemplateSchema.shape.signature,
            table: cardTemplateSchema.shape.table,
            text: z.string().max(600),
            seconds: z.number().finite().min(0.5).max(30),
            imageId: z.uuid().nullable(),
            imageOnly: z.boolean().optional(),
            videoStart: z.number().finite().min(0).max(600).optional(),
            overlayId: z.uuid().nullable().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    style: z
      .object({
        fontSize: z.literal(60),
        darkness: z.number().min(0).max(0.8),
      })
      .strict(),
    music: z
      .object({
        assetId: z.uuid().nullable(),
        offset: z.number().finite().min(0).max(86400),
        volume: z.number().min(0).max(1),
        bpm: z.number().finite().min(40).max(240),
        loop: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, ctx) => {
    if (new Set(plan.cards.map((c) => c.id)).size !== plan.cards.length)
      ctx.addIssue({ code: "custom", message: "카드 ID가 중복됐어요." });
    if (plan.cards.reduce((sum, c) => sum + c.seconds, 0) > 180)
      ctx.addIssue({
        code: "custom",
        message: "전체 길이는 180초 이내로 구성해주세요.",
      });
  });
export type CardPlan = z.infer<typeof cardPlanSchema>;
export type Card = CardPlan["cards"][number];
export type CardAsset = {
  id: string;
  name: string;
  kind: "image" | "audio" | "video";
  url: string;
  duration?: number;
};
export type CardJob = {
  id: string;
  state: "running" | "completed" | "failed" | "cancelled";
  progress: number;
  error?: string;
  outputPath?: string;
};
export interface CardNewsBridge {
  preview(plan: CardPlan): Promise<string[]>;
  list(): Promise<Array<{ id: string; title: string; updatedAt: string }>>;
  load(id: string): Promise<{ plan: CardPlan; assets: CardAsset[] }>;
  save(plan: CardPlan): Promise<CardPlan>;
  chooseAsset(kind: "image" | "audio" | "video"): Promise<CardAsset | null>;
  export(plan: CardPlan, frames: string[]): Promise<CardJob | null>;
  job(id: string): Promise<CardJob>;
  cancel(id: string): Promise<void>;
  reveal(id: string): Promise<void>;
}

export function templateContent(card: Card) {
  if (card.imageOnly || card.overlayId)
    throw new Error("커스텀 이미지·오버레이 대신 카드 템플릿을 선택해주세요.");
  if (!card.templateId) throw new Error("카드 템플릿을 선택해주세요.");
  const content = cardTemplateSchema.parse({
    templateId: card.templateId,
    text: card.text,
    notes: card.notes,
    signature: card.signature,
    table: card.table,
  });
  if (card.templateId === "comparison" && !card.table)
    throw new Error("비교표의 열과 행을 입력해주세요.");
  return content;
}
