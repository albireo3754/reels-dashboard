import { z } from "zod";

export const localPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .startsWith("/")
  .refine((v) => !v.includes("\0"));
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
});
export type ContentInput = z.infer<typeof contentInputSchema>;
