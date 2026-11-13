import { z } from "zod";
import {
  publicationChannels,
  publicationSchema,
  publicationStatuses,
  publicationsSchema,
} from "./publications";
import { dashboardRevision } from "./production-project";
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

export const contentInputSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[\p{L}\p{N}_.:-]+$/u),
  title: z.string().min(1).max(500),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateBasis: z.enum(["capture", "publication", "record"]),
  stage: z.enum([
    "idea",
    "captured",
    "selected",
    "editing",
    "review",
    "published",
  ]),
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
  })
  .refine(
    (v) =>
      (v.status === "published" || !v.publishedAt) &&
      (v.status !== "none" || !v.url),
    "게시일은 게시 완료에만, 링크는 예정·게시 완료에만 넣을 수 있어요.",
  );
export type SetPublicationInput = z.infer<typeof setPublicationSchema>;
