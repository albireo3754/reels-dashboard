import { z } from "zod";
import {
  publicationChannels,
  publicationSchema,
  publicationStatuses,
  publicationsSchema,
} from "./publications";
import { dashboardRevision } from "./production-project";
import { projectDateBases, projectKinds, projectStages } from "./contracts";
import { absolutePathSchema } from "./path-schema";

export const localPathSchema = absolutePathSchema();
export const localResourcesSchema = z
  .array(
    z.strictObject({
      role: z.enum([
        "footage",
        "final",
        "cover",
        "draft",
        "document",
        "folder",
      ]),
      path: localPathSchema,
      label: z.string().min(1).max(300),
    }),
  )
  .max(500);

/** A project's place in the user's own working order. */
export const projectPrioritySchema = z.number().int().min(1).max(999);

export const contentInputSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[\p{L}\p{N}_.:-]+$/u),
  title: z.string().min(1).max(500),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateBasis: z.enum(projectDateBases),
  stage: z.enum(projectStages),
  /** Omit to keep the stored kind (new entries are `content`). */
  kind: z.enum(projectKinds).optional(),
  /** The user's working order (1 first). Omit to keep the stored one, `null` to clear it. */
  priority: projectPrioritySchema.nullable().optional(),
  nextAction: z.string().max(2000),
  publicURL: z.string().max(2048),
  localNotes: z.string().max(4000),
  resources: localResourcesSchema,
  /** Omit to keep the stored channel state; pass a list to replace it. */
  publications: publicationsSchema.optional(),
});
export type ContentInput = z.infer<typeof contentInputSchema>;

export const setPublicationSchema = z
  .strictObject({
    projectId: z.string().min(1).max(160),
    expectedUpdatedAt: dashboardRevision,
    channel: z.enum(publicationChannels),
    /** `none` removes the channel from this project's targets. */
    status: z.enum(["none", ...publicationStatuses]),
    url: publicationSchema.shape.url.optional(),
    publishedAt: publicationSchema.shape.publishedAt,
    scheduledAt: publicationSchema.shape.scheduledAt,
  })
  .refine(
    (v) =>
      (v.status === "published" || !v.publishedAt) &&
      (v.status !== "none" || !v.url) &&
      (v.status === "scheduled") === Boolean(v.scheduledAt),
    "게시일은 게시 완료에만, 예약 시각은 공개 예약에만(필수), 링크는 채널을 둘 때만 넣을 수 있어요.",
  );
export type SetPublicationInput = z.infer<typeof setPublicationSchema>;
