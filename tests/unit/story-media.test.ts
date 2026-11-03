import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowRuntime } from "../../src/app/workflow/runtime";
import { mediaScenesSchema, storyMediaPlanSchema, validateSceneCoverage } from "../../src/shared/story-media";
import { mediaSceneInputs, validateStoryMediaSubmission } from "../../src/app/workflow/story-media";
import { hashes } from "../../src/app/workflow/files";

const inventory = { version: 1, scenes: [
  { id: "street", source: "CLIP_01@0.2", preview: "media/street.png", observed: "Street and entrance" },
  { id: "object", source: "CLIP_02@1.0", preview: "media/object.png", observed: "Object on a table" },
] };
const plan = { version: 1, inventory: "evidence/media-scenes.json", decisions: [
  { sceneId: "street", decision: "use", reason: "Shows the approach", handling: "Keep frame", group: "arrival", role: "Location context" },
  { sceneId: "object", decision: "omit", reason: "Unrelated to the visit account", handling: "Original retained" },
] };
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "story-media-")));
  await mkdir(path.join(root, "media")); await mkdir(path.join(root, "evidence")); await mkdir(path.join(root, "draft"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII=", "base64");
  for (const name of ["street", "object"]) await writeFile(path.join(root, `media/${name}.png`), png);
  await writeFile(path.join(root, "evidence/media-scenes.json"), JSON.stringify(inventory));
  await writeFile(path.join(root, "draft/story-media-plan.json"), JSON.stringify(plan));
  await writeFile(path.join(root, "draft/article.md"), "Synthetic visit story");
  return root;
}

test("scene decisions cover owned media exactly without forcing inclusion", () => {
  const i = mediaScenesSchema.parse(inventory), p = storyMediaPlanSchema.parse(plan);
  assert.doesNotThrow(() => validateSceneCoverage(i, p));
  assert.throws(() => validateSceneCoverage(i, { ...p, decisions: p.decisions.slice(0, 1) }), /COVERAGE/);
  assert.throws(() => validateSceneCoverage(i, { ...p, decisions: [p.decisions[0], { ...p.decisions[1], sceneId: "invented" }] }), /COVERAGE/);
  assert.throws(() => storyMediaPlanSchema.parse({ ...plan, decisions: [plan.decisions[0], plan.decisions[0]] }), /Duplicate/);
  assert.throws(() => mediaScenesSchema.parse({ ...inventory, scenes: [inventory.scenes[0], inventory.scenes[0]] }), /Duplicate/);
  const omitted = storyMediaPlanSchema.parse({ ...plan, decisions: plan.decisions.map(d => ({ ...d, decision: "omit" })) });
  assert.doesNotThrow(() => validateSceneCoverage(i, omitted));
  assert.throws(() => storyMediaPlanSchema.parse({ ...plan, decisions: plan.decisions.map(d => ({ ...d, decision: "hold" })) }), /resolveWhen/);
});

test("nested artifacts use workspace paths and freeze scene previews", async () => {
  const root = await fixture();
  try {
    const files = ["evidence/media-scenes.json", ...await mediaSceneInputs(root, ["evidence/media-scenes.json"])];
    const inputs = await hashes(root, files);
    await validateStoryMediaSubmission(root, inputs, ["draft/story-media-plan.json"], true);
    await assert.rejects(validateStoryMediaSubmission(root, inputs, ["draft/article.md"], true), /MEDIA_PLAN_REQUIRED/);
    await writeFile(path.join(root, "draft/story-media-plan.json"), JSON.stringify({ ...plan, inventory: "media-scenes.json" }));
    await assert.rejects(validateStoryMediaSubmission(root, inputs, ["draft/story-media-plan.json"], true), /MEDIA_PLAN_INVENTORY/);
    await writeFile(path.join(root, "draft/story-media-plan.json"), JSON.stringify(plan));
    await writeFile(path.join(root, "media/street.png"), "changed");
    await assert.rejects(validateStoryMediaSubmission(root, inputs, ["draft/story-media-plan.json"], true), /STALE_INPUT/);
    await writeFile(path.join(root, "evidence/media-scenes.json"), JSON.stringify({ ...inventory, scenes: inventory.scenes.slice(1) }));
    await assert.rejects(validateStoryMediaSubmission(root, inputs, ["draft/story-media-plan.json"], true), /STALE_INPUT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("preview paths cannot escape workspace and ambiguous inventories are rejected", async () => {
  const root = await fixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), "outside-scene-"));
  try {
    await writeFile(path.join(outside, "photo.png"), "outside");
    await symlink(path.join(outside, "photo.png"), path.join(root, "media/escape.png"));
    const bad = { ...inventory, scenes: [{ ...inventory.scenes[0], preview: "media/escape.png" }] };
    await writeFile(path.join(root, "evidence/media-scenes.json"), JSON.stringify(bad));
    await assert.rejects(mediaSceneInputs(root, ["evidence/media-scenes.json"]), /escapes workspace/);
    await assert.rejects(mediaSceneInputs(root, ["evidence/media-scenes.json", "other/media-scenes.json"]), /AMBIGUOUS/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test("photo drafting is gated without an experience form; restart and text-only revisions preserve flow", async () => {
  const root = await fixture(); let rt = await WorkflowRuntime.open(path.join(root, "db"));
  try {
    let run = await rt.create({ title: "Photo story", workspace: root, instructions: "Use owned scenes", trackedFiles: ["draft/article.md"] });
    const submit = (evidence: string[], outcome = "done") => rt.submit({ runId: run.runId, taskId: run.task!.taskId, outcome, summary: "Fixture result", evidence });
    run = await submit(["evidence/media-scenes.json"]);
    assert.equal(run.stage, "draft");
    assert.ok(run.task!.inputHashes["media/street.png"]);
    await assert.rejects(submit(["draft/article.md"]), /MEDIA_PLAN_REQUIRED/);
    await rt.close(); rt = await WorkflowRuntime.open(path.join(root, "db"));
    run = await rt.get({ runId: run.runId });
    run = await submit(["draft/article.md", "draft/story-media-plan.json"]);
    assert.equal(run.stage, "review");
    await writeFile(path.join(root, "review.md"), "Change a sentence");
    run = await submit(["review.md"], "revise"); assert.equal(run.stage, "revise");
    await writeFile(path.join(root, "evidence/media-scenes.json"), JSON.stringify({ ...inventory, scenes: inventory.scenes.slice(1) }));
    await assert.rejects(submit(["draft/article.md"]), /STALE_INPUT/);
    await writeFile(path.join(root, "evidence/media-scenes.json"), JSON.stringify(inventory));
    const preview = await readFile(path.join(root, "media/street.png"));
    await writeFile(path.join(root, "media/street.png"), "changed image");
    await assert.rejects(submit(["draft/article.md"]), /STALE_INPUT/);
    await writeFile(path.join(root, "media/street.png"), preview);
    await writeFile(path.join(root, "draft/story-media-plan.json"), JSON.stringify({ ...plan, decisions: plan.decisions.slice(1) }));
    await assert.rejects(submit(["draft/article.md"]), /STALE_INPUT/);
    await writeFile(path.join(root, "draft/story-media-plan.json"), JSON.stringify(plan));
    run = await submit(["draft/article.md"]); assert.equal(run.stage, "review");
    run = await submit(["review.md"], "pass"); assert.equal(run.stage, "layout");
  } finally { await rt.close(); await rm(root, { recursive: true, force: true }); }
});

test("runs without a scene manifest retain draft behavior", async () => {
  const root = await fixture(); const rt = await WorkflowRuntime.open(path.join(root, "db"));
  try {
    let run = await rt.create({ title: "Text only", workspace: root, instructions: "Text", trackedFiles: ["draft/article.md"] });
    for (let i = 0; i < 2; i++) run = await rt.submit({ runId: run.runId, taskId: run.task!.taskId, outcome: "done", summary: "Text result", evidence: ["draft/article.md"] });
    assert.equal(run.stage, "review");
  } finally { await rt.close(); await rm(root, { recursive: true, force: true }); }
});

test("initial inventory and explicit restart track newly added previews", async () => {
  const root = await fixture(); const rt = await WorkflowRuntime.open(path.join(root, "db"));
  try {
    let run = await rt.create({ title: "Existing scenes", workspace: root, instructions: "Compose", trackedFiles: ["evidence/media-scenes.json"] });
    assert.ok(run.task!.inputHashes["media/street.png"]);
    run = await rt.submit({ runId: run.runId, taskId: run.task!.taskId, outcome: "done", summary: "Prepared", evidence: ["draft/article.md"] });
    await writeFile(path.join(root, "media/new.png"), await readFile(path.join(root, "media/street.png")));
    await writeFile(path.join(root, "evidence/media-scenes.json"), JSON.stringify({ ...inventory, scenes: [...inventory.scenes, { id: "new", source: "CLIP_03@0", preview: "media/new.png", observed: "New scene" }] }));
    run = await rt.restart({ runId: run.runId });
    assert.equal(run.stage, "draft");
    assert.ok(run.task!.inputHashes["media/new.png"]);
    await writeFile(path.join(root, "draft/story-media-plan.json"), JSON.stringify({ ...plan, decisions: [...plan.decisions, { sceneId: "new", decision: "omit", reason: "Duplicate context", handling: "Retain original" }] }));
    run = await rt.submit({ runId: run.runId, taskId: run.task!.taskId, outcome: "done", summary: "Composed", evidence: ["draft/story-media-plan.json", "draft/article.md"] });
    assert.equal(run.stage, "review");
  } finally { await rt.close(); await rm(root, { recursive: true, force: true }); }
});
