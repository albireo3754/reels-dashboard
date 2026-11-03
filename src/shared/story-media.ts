import { z } from "zod";

const text = z.string().trim().min(1);
export const mediaScenesSchema = z.strictObject({
  version: z.literal(1),
  scenes: z.array(z.strictObject({
    id: text.max(100),
    source: text.max(2000).describe("Original filename/capture ID and video time; descriptive reference, not a path to open"),
    preview: text.max(2000).describe("Existing JPEG/PNG/WebP path relative to the workflow workspace root"),
    observed: text.max(3000),
    contextNotes: z.array(text.max(3000)).max(30).default([]).describe("Verified place/scene relationships with source attribution, separate from visible observations"),
  })).min(1).max(500),
}).superRefine((value, ctx) => {
  if (new Set(value.scenes.map(s => s.id)).size !== value.scenes.length)
    ctx.addIssue({ code: "custom", message: "Duplicate scene ID" });
});

export const storyMediaPlanSchema = z.strictObject({
  version: z.literal(1),
  inventory: text.describe("Exact tracked media-scenes.json path relative to workspace root, not the plan directory"),
  decisions: z.array(z.strictObject({
    sceneId: text,
    decision: z.enum(["use", "omit", "hold"]),
    reason: text.max(3000),
    handling: text.max(3000),
    group: text.max(100).optional(),
    role: text.max(1000).optional(),
    experienceRefs: z.array(text.max(1000)).max(30).default([]),
    resolveWhen: text.max(1000).optional(),
  })).min(1).max(500),
}).superRefine((value, ctx) => {
  if (new Set(value.decisions.map(d => d.sceneId)).size !== value.decisions.length)
    ctx.addIssue({ code: "custom", message: "Duplicate scene decision" });
  value.decisions.forEach((d, i) => {
    if (d.decision === "hold" && !d.resolveWhen)
      ctx.addIssue({ code: "custom", path: ["decisions", i], message: "hold is unused in this draft and needs resolveWhen" });
    if (d.decision === "use" && (!d.group || !d.role))
      ctx.addIssue({ code: "custom", path: ["decisions", i], message: "use needs a group and narrative role" });
  });
});

export function validateSceneCoverage(
  inventory: z.infer<typeof mediaScenesSchema>,
  plan: z.infer<typeof storyMediaPlanSchema>,
) {
  const ids = new Set(inventory.scenes.map(s => s.id));
  if (plan.decisions.length !== ids.size || plan.decisions.some(d => !ids.has(d.sceneId)))
    throw new Error("MEDIA_PLAN_COVERAGE: every inventory scene needs exactly one decision; unknown scene IDs are not allowed");
}
