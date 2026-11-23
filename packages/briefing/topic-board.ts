import { z } from "zod";

const line = (max: number) => z.string().trim().min(1).max(max);
const channel = z.enum(["blog", "naver-clip", "instagram", "youtube"]);
const count = z.number().int().min(0).max(10000);
const item = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
    channel,
    title: line(120),
    hookFamily: line(60),
    coverHooks: z.array(line(80)).min(1).max(4),
    captionHead: z.string().trim().max(200).optional(),
    basedOn: z
      .array(z.object({ title: line(120), evidence: line(200) }).strict())
      .max(4)
      .default([]),
    source: line(300),
    hypothesis: z.string().trim().max(400).optional(),
    effort: z.enum(["S", "M", "L"]),
    readiness: z.enum(["ready", "needs_edit", "needs_user", "hold"]),
    asks: z.array(line(200)).max(6).default([]),
    rank: z.number().int().min(1).max(99).optional(),
    decision: z.enum(["proposed", "picked"]).default("proposed"),
    updatedAt: z.string().datetime({ offset: true }),
    projectId: line(160),
    projectTitle: line(500),
    channelLabel: line(40),
    readinessLabel: line(80),
    effortLabel: line(40),
  })
  .strict();

export const topicBoardSchema = z
  .object({
    items: z.array(item).max(4000),
    counts: z
      .object({
        picked: count,
        ready: count,
        needs_edit: count,
        needs_user: count,
        hold: count,
        dropped: count,
      })
      .strict(),
    gaps: z
      .array(
        z
          .object({
            channel,
            label: line(40),
            week: z.enum(["this", "next"]),
            remaining: count,
          })
          .strict(),
      )
      .max(8),
  })
  .strict();
export type TopicBoard = z.infer<typeof topicBoardSchema>;
