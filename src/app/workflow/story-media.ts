import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { mediaScenesSchema, storyMediaPlanSchema, validateSceneCoverage } from "../../shared/story-media";
import { hashes, resolveFile } from "./files";

function named(files: string[], name: string) {
  return [...new Set(files)].filter(file => path.basename(file) === name);
}
async function json(workspace: string, file: string) {
  const resolved = await resolveFile(workspace, file);
  if ((await stat(resolved)).size > 2_000_000) throw new Error("Media inventory/plan file too large");
  return JSON.parse(await readFile(resolved, "utf8"));
}

/** A named inventory opts this run into photo composition; never scan a private library. */
export async function mediaSceneInputs(workspace: string, files: string[]) {
  const inventories = named(files, "media-scenes.json");
  if (inventories.length > 1)
    throw new Error("MEDIA_INVENTORY_AMBIGUOUS: use one tracked media-scenes.json per run");
  if (!inventories.length) return [];
  const inventory = mediaScenesSchema.parse(await json(workspace, inventories[0]));
  const previews = [...new Set(inventory.scenes.map(s => s.preview))];
  for (const preview of previews) {
    if (!/\.(jpe?g|png|webp)$/i.test(preview)) throw new Error("MEDIA_PREVIEW: expected JPEG/PNG/WebP");
    try {
      const file = await resolveFile(workspace, preview);
      if ((await stat(file)).size > 4_000_000) throw new Error("preview exceeds 4 MB");
    } catch (error) {
      throw new Error(`MEDIA_PREVIEW: ${preview} must exist relative to workspace root (not the inventory/artifact directory): ${String(error)}`);
    }
  }
  return previews;
}

export async function validateStoryMediaSubmission(
  workspace: string, inputs: Record<string, string>, evidence: string[], required: boolean, previousPlan?: string,
) {
  const inventories = named(Object.keys(inputs), "media-scenes.json");
  const plans = named(evidence, "story-media-plan.json");
  if (!inventories.length && !plans.length) return; // Existing/text-only runs keep their contract.
  if (!inventories.length) throw new Error("MEDIA_INVENTORY_REQUIRED: prepare and track media-scenes.json before submitting a plan");
  if (inventories.length > 1) throw new Error("MEDIA_INVENTORY_AMBIGUOUS: use one tracked inventory per run");
  const reusedPlan = !required && !plans.length ? previousPlan : undefined;
  if (plans.length > 1 || (!plans.length && !reusedPlan))
    throw new Error("MEDIA_PLAN_REQUIRED: submit one story-media-plan.json for the tracked media-scenes.json");
  const inventoryPath = inventories[0];
  const planPath = reusedPlan ?? plans[0];
  const plan = storyMediaPlanSchema.parse(await json(workspace, planPath));
  if (plan.inventory !== inventoryPath)
    throw new Error("MEDIA_PLAN_INVENTORY: inventory must exactly match the tracked workspace-relative path");
  // Check the inventory before parsing it so edits cannot silently replace the frozen scene set.
  if ((await hashes(workspace, [inventoryPath]))[inventoryPath] !== inputs[inventoryPath])
    throw new Error("STALE_INPUT: media inventory changed; restart before composing");
  const inventory = mediaScenesSchema.parse(await json(workspace, inventoryPath));
  const previews = await mediaSceneInputs(workspace, [inventoryPath]);
  const current = await hashes(workspace, previews);
  if (previews.some(file => !inputs[file] || inputs[file] !== current[file]))
    throw new Error("STALE_INPUT: scene previews changed or were not tracked; prepare/refresh the scene inputs");
  if (reusedPlan && (await hashes(workspace, [reusedPlan]))[reusedPlan] !== inputs[reusedPlan])
    throw new Error("STALE_INPUT: retained media plan changed; submit the revised plan explicitly");
  validateSceneCoverage(inventory, plan);
}
