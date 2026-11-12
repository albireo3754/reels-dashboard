import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { WorkflowRuntime } from "../../src/app/workflow/runtime";
import type { WorkflowRun } from "../../src/shared/workflow";

// Synthetic, content-free fixtures: a shared definition in <root>/workflows and a
// workspace at <root>/research/post.
const sharedDefinition = (reviewOutputs = ["reviews/check-{attempt}.md"]) => ({
  version: 1,
  id: "shared-fixture",
  title: "Shared fixture",
  entry: "prepare",
  steps: [
    {
      id: "prepare",
      title: "Prepare",
      kind: "task",
      instruction: "Build the scene list and missing questions",
      inputs: ["brief.md"],
      outputs: ["evidence/media-scenes.json", "experience-form.json"],
      completion: ["Scenes listed"],
      on: { done: "experience" },
    },
    {
      id: "experience",
      title: "Experience",
      kind: "input",
      instruction: "Answer",
      formFile: "experience-form.json",
      completion: ["Submitted"],
      on: { done: "draft" },
    },
    {
      id: "draft",
      title: "Draft",
      kind: "task",
      instruction: "Compose",
      inputs: ["evidence/media-scenes.json"],
      outputs: ["article.md", "evidence/story-media-plan.json"],
      completion: ["Every scene decided"],
      on: { done: "check" },
    },
    {
      id: "check",
      title: "Check",
      kind: "review",
      instruction: "Review",
      inputs: ["article.md"],
      outputs: reviewOutputs,
      completion: ["Reviewed"],
      on: { pass: "$complete", revise: "draft" },
    },
  ],
});
const form = (questions = ["q1"]) => ({
  version: 1,
  title: "Synthetic form",
  introduction: "",
  facts: [],
  questions: questions.map((id) => ({
    id,
    section: "S",
    prompt: `Prompt ${id}`,
  })),
});
const scenes = {
  version: 1,
  scenes: [
    {
      id: "s1",
      source: "synthetic",
      preview: "media/s1.png",
      observed: "a shape",
    },
  ],
};
const plan = (sceneId = "s1") => ({
  version: 1,
  inventory: "evidence/media-scenes.json",
  decisions: [
    {
      sceneId,
      decision: "use",
      reason: "fits",
      handling: "keep",
      group: "g1",
      role: "opening",
    },
  ],
});

async function fixture(reviewOutputs?: string[]) {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-shared-"));
  const workspace = path.join(root, "research", "post");
  await mkdir(path.join(root, "workflows"), { recursive: true });
  await mkdir(path.join(workspace, "evidence"), { recursive: true });
  await mkdir(path.join(workspace, "media"), { recursive: true });
  await mkdir(path.join(workspace, "reviews"), { recursive: true });
  await writeFile(path.join(workspace, "brief.md"), "synthetic brief");
  const definitionFile = path.join(root, "workflows", "blog.yaml");
  await writeFile(definitionFile, stringify(sharedDefinition(reviewOutputs)));
  const runtime = await WorkflowRuntime.open(path.join(root, "db"));
  const input = {
    title: "Shared run",
    workspace,
    definitionFile,
    instructions: "Synthetic",
    trackedFiles: ["brief.md"],
  };
  const put = (file: string, data: unknown) =>
    writeFile(
      path.join(workspace, file),
      typeof data === "string" ? data : JSON.stringify(data),
    );
  return { root, workspace, definitionFile, runtime, input, put };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function writeMedia(f: Fixture) {
  await f.put("media/s1.png", "png-bytes");
  await f.put("evidence/media-scenes.json", scenes);
}
/** Submit answers through the shared form service so exports have the real shape. */
async function submitAnswers(f: Fixture, questions = ["q1"]) {
  const created = await f.runtime.createForm({
    workspace: f.workspace,
    form: form(questions),
  });
  return f.runtime.saveForm({
    formId: created.formId,
    expectedRevision: created.revision,
    answers: questions.map((questionId) => ({
      questionId,
      status: "answered",
      text: `answer ${questionId}`,
    })),
    submit: true,
  });
}
async function submit(
  f: Fixture,
  run: WorkflowRun,
  outcome: "done" | "pass" | "revise",
  evidence = run.task!.step!.outputs,
) {
  return f.runtime.submit({
    runId: run.runId,
    taskId: run.task!.taskId,
    outcome,
    summary: "synthetic",
    evidence,
  });
}

test("shared definition loads from a workflows/ folder of a workspace ancestor and keeps its snapshot", async () => {
  const f = await fixture();
  try {
    const validated = await f.runtime.validateDefinition({
      workspace: f.workspace,
      definitionFile: f.definitionFile,
    });
    assert.equal(validated.definition.id, "shared-fixture");
    assert.deepEqual(validated.skippable, { skipped: [], startsAt: "prepare" });
    const run = await f.runtime.create(f.input);
    assert.equal(run.definition!.file, f.definitionFile);
    assert.equal(run.definition!.sha256, validated.sha256);
    assert.equal(run.stepId, "prepare");
  } finally {
    await f.runtime.close();
  }
});

test("shared definition boundary rejects paths outside <ancestor>/workflows and symlink escapes", async () => {
  const f = await fixture();
  try {
    const outside = await mkdtemp(path.join(tmpdir(), "workflow-outside-"));
    const yaml = stringify(sharedDefinition());
    await mkdir(path.join(outside, "workflows"));
    await writeFile(path.join(outside, "workflows", "x.yaml"), yaml);
    await mkdir(path.join(f.root, "other"));
    await writeFile(path.join(f.root, "other", "x.yaml"), yaml);
    await mkdir(path.join(f.root, "workflows", "nested"));
    await writeFile(path.join(f.root, "workflows", "nested", "x.yaml"), yaml);
    await writeFile(path.join(outside, "secret.yaml"), yaml);
    await symlink(
      path.join(outside, "secret.yaml"),
      path.join(f.root, "workflows", "link.yaml"),
    );
    await mkdir(path.join(f.workspace, "workflows"));
    await writeFile(path.join(f.workspace, "workflows", "x.yaml"), yaml);
    const reject = (definitionFile: string, pattern: RegExp) =>
      assert.rejects(
        f.runtime.validateDefinition({
          workspace: f.workspace,
          definitionFile,
        }),
        pattern,
      );
    await reject(path.join(outside, "workflows", "x.yaml"), /SHARED_DEFINITION/);
    await reject(path.join(f.root, "other", "x.yaml"), /SHARED_DEFINITION/);
    await reject(
      path.join(f.root, "workflows", "nested", "x.yaml"),
      /SHARED_DEFINITION/,
    );
    await reject(path.join(f.root, "workflows", "link.yaml"), /SHARED_DEFINITION/);
    // workspace/workflows is not an ancestor's folder; use a relative path there.
    await reject(
      path.join(f.workspace, "workflows", "x.yaml"),
      /SHARED_DEFINITION/,
    );
    await reject(f.root + "/research/../workflows/blog.yaml", /normalized/);
    await reject(path.join(f.root, "workflows", "missing.yaml"), /not found/);
    await writeFile(path.join(f.root, "workflows", "notes.txt"), yaml);
    await reject(path.join(f.root, "workflows", "notes.txt"), /normalized/);
  } finally {
    await f.runtime.close();
  }
});

test("a new run skips completed leading steps with recorded evidence, but never the review", async () => {
  const f = await fixture();
  try {
    await writeMedia(f);
    await submitAnswers(f);
    await f.put("article.md", "draft text");
    await f.put("evidence/story-media-plan.json", plan());
    // Existing review output must not let the review be skipped.
    await f.put("reviews/check-4.md", "old review");
    const preview = await f.runtime.validateDefinition({
      workspace: f.workspace,
      definitionFile: f.definitionFile,
    });
    assert.deepEqual(
      preview.skippable.skipped.map((s) => s.stepId),
      ["prepare", "experience", "draft"],
    );
    assert.equal(preview.skippable.startsAt, "check");
    let run = await f.runtime.create(f.input);
    assert.equal(run.stepId, "check");
    assert.equal(run.stage, "review");
    assert.deepEqual(
      run.history.map((h) => [h.stepId, h.outcome]),
      [
        ["prepare", "skipped"],
        ["experience", "skipped"],
        ["draft", "skipped"],
      ],
    );
    // Without a form file, prepare adopts the submitted answers for that output.
    const answers = Object.keys(run.history[0].evidence).filter((file) =>
      file.startsWith("experience-answers-"),
    );
    assert.equal(answers.length, 2);
    assert.ok(run.history[0].evidence["media/s1.png"]);
    assert.ok(run.history[2].evidence["evidence/story-media-plan.json"]);
    assert.ok(run.trackedFiles.includes("article.md"));
    assert.equal(run.experience, undefined);
    assert.deepEqual(
      (await f.runtime.context({ runId: run.runId })).submit?.outcomes,
      ["pass", "revise", "blocked", "cancel"],
    );
    run = await submit(f, run, "pass");
    assert.equal(run.status, "ready");
  } finally {
    await f.runtime.close();
  }
});

test("invalid or missing outputs stop skipping; skipCompleted:false keeps the full run", async () => {
  const f = await fixture();
  try {
    let run = await f.runtime.create(f.input);
    assert.equal(run.stepId, "prepare");
    assert.equal(run.history.length, 0);
    await writeMedia(f);
    await submitAnswers(f);
    await f.put("article.md", "draft text");
    // Plan does not cover the inventory scene.
    await f.put("evidence/story-media-plan.json", plan("unknown"));
    run = await f.runtime.create(f.input);
    assert.equal(run.stepId, "draft");
    assert.equal(run.history.length, 2);
    // Media scenes whose preview is missing are not valid.
    await f.put(
      "evidence/media-scenes.json",
      { ...scenes, scenes: [{ ...scenes.scenes[0], preview: "media/none.png" }] },
    );
    run = await f.runtime.create(f.input);
    assert.equal(run.stepId, "prepare");
    await writeMedia(f);
    run = await f.runtime.create({ ...f.input, skipCompleted: false });
    assert.equal(run.stepId, "prepare");
    assert.equal(run.history.length, 0);
  } finally {
    await f.runtime.close();
  }
});

test("an input step is skipped mid-run only when submitted answers cover every current question", async () => {
  const f = await fixture();
  try {
    await submitAnswers(f, ["q1", "q2"]);
    // prepare is not adoptable yet (no media scenes), so the run starts there.
    let run = await f.runtime.create(f.input);
    assert.equal(run.stepId, "prepare");
    await writeMedia(f);
    await f.put("experience-form.json", form(["q2"]));
    run = await submit(f, run, "done");
    assert.equal(run.stepId, "draft");
    assert.deepEqual(run.history.at(-1)?.outcome, "skipped");
    assert.equal(run.history.at(-1)?.stepId, "experience");
    assert.equal(run.experience, undefined);

    // A new question the answers do not cover keeps the form (prepare still skips).
    await f.put("experience-form.json", form(["q2", "q3"]));
    const mixed = await f.runtime.create(f.input);
    assert.deepEqual(
      mixed.history.map((h) => [h.stepId, h.outcome]),
      [["prepare", "skipped"]],
    );
    assert.equal(mixed.stepId, "experience");
    assert.ok(mixed.experience);
  } finally {
    await f.runtime.close();
  }
});

test("re-submitting the same result leaves the run unchanged and says it was already recorded", async () => {
  const f = await fixture();
  try {
    let run = await f.runtime.create({ ...f.input, skipCompleted: false });
    await writeMedia(f);
    await f.put("experience-form.json", form());
    const first = run;
    run = await submit(f, first, "done");
    assert.equal(run.stepId, "experience");
    await assert.rejects(submit(f, first, "done"), /ALREADY_RECORDED/);
    const after = await f.runtime.get({ runId: run.runId });
    assert.equal(after.sequence, run.sequence);
    assert.equal(after.history.length, run.history.length);
    assert.equal(after.task!.taskId, run.task!.taskId);
    // A different late result is a plain stale submission.
    await assert.rejects(
      submit(f, first, "done", ["evidence/media-scenes.json"]),
      (e: Error) => /STALE_TASK/.test(e.message) && !/ALREADY/.test(e.message),
    );
    await f.put("evidence/media-scenes.json", {
      ...scenes,
      scenes: [{ ...scenes.scenes[0], observed: "changed" }],
    });
    await assert.rejects(
      submit(f, first, "done"),
      (e: Error) => /STALE_TASK/.test(e.message) && !/ALREADY/.test(e.message),
    );
  } finally {
    await f.runtime.close();
  }
});

test("task steps with {attempt} outputs are never skipped, matching the preview", async () => {
  const f = await fixture();
  try {
    const d: any = sharedDefinition();
    d.steps[2].outputs = ["drafts/draft-{attempt}.md"];
    await writeFile(f.definitionFile, stringify(d));
    await writeMedia(f);
    await submitAnswers(f);
    await mkdir(path.join(f.workspace, "drafts"));
    for (const n of [1, 2, 3, 4]) await f.put(`drafts/draft-${n}.md`, "old");
    const preview = await f.runtime.validateDefinition({
      workspace: f.workspace,
      definitionFile: f.definitionFile,
    });
    assert.equal(preview.skippable.startsAt, "draft");
    const run = await f.runtime.create(f.input);
    assert.equal(run.stepId, "draft");
    assert.ok(run.trackedFiles.includes("brief.md"));
  } finally {
    await f.runtime.close();
  }
});

test("a step is not skipped when the next step's inputs are missing", async () => {
  const f = await fixture();
  try {
    const d: any = sharedDefinition();
    d.steps[3].inputs = ["article.md", "missing.md"];
    await writeFile(f.definitionFile, stringify(d));
    await writeMedia(f);
    await submitAnswers(f);
    await f.put("article.md", "draft text");
    await f.put("evidence/story-media-plan.json", plan());
    const run = await f.runtime.create(f.input);
    assert.equal(run.stepId, "draft");
    assert.equal(run.status, "waiting");
    assert.ok(run.task);
  } finally {
    await f.runtime.close();
  }
});
