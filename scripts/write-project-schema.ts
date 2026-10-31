import { z } from "zod";
import { writeFile } from "node:fs/promises";
import { productionSchema } from "../src/shared/production-project";
import { localResourcesSchema } from "../src/shared/local-resources";
const project = z.strictObject({
  id: z.string().min(1).max(160),
  title: z.string().max(500),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dateBasis: z.enum(["capture", "publication", "record"]).optional(),
  stage: z.enum(["idea", "captured", "selected", "editing", "review", "published"]),
  nextAction: z.string().max(2000),
  publicURL: z.string().max(2048),
  shared: z.boolean(),
  localNotes: z.string().max(4000).optional(),
  resources: localResourcesSchema.optional(),
  production: productionSchema.optional(),
});
const schema = z.toJSONSchema(z.strictObject({
  schemaVersion: z.literal(1),
  updatedAt: z.iso.datetime(),
  projects: z.array(project).max(10000),
}));
await writeFile("schemas/dashboard.schema.json", JSON.stringify({
  ...schema,
  $id: "https://reels-dashboard.local/schemas/dashboard.schema.json",
  title: "Production project dashboard",
  description: "A dashboard contains production projects. Each project owns many video/card-news edits, linked resources and export versions. Cross-project ownership, alias uniqueness and export resource references are enforced by validateDashboard.",
}, null, 2) + "\n");
