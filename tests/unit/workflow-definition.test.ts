import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { WorkflowRuntime } from "../../src/app/workflow/runtime";
import { workflowDefinitionSchema } from "../../src/shared/workflow-definition";
import type { WorkflowRun } from "../../src/shared/workflow";

const definition = () => ({
  version: 1,
  id: "fixture",
  title: "Session workflow",
  entry: "write",
  steps: [
    {
      id: "write",
      title: "Write",
      kind: "task",
      instruction: "Read facts and write a candidate",
      inputs: ["source.md"],
      outputs: ["draft.md"],
      skills: ["skills/writer/SKILL.md"],
      tools: [
        {
          server: "reels_dashboard",
          name: "reels_get_app_state",
          purpose: "Inspect app state",
        },
      ],
      completion: ["Facts are preserved"],
      on: { done: "check" },
    },
    {
      id: "check",
      title: "Check",
      kind: "review",
      instruction: "Inspect frozen candidate",
      inputs: ["draft.md"],
      outputs: ["review-{attempt}.md"],
      completion: ["Inspect the output"],
      on: { pass: "$complete", revise: "write" },
    },
  ],
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-dsl-"));
  await writeFile(path.join(root, "source.md"), "confirmed facts");
  await writeFile(path.join(root, "workflow.yaml"), stringify(definition()));
  const input = {
    title: "Synthetic DSL",
    projectId: "fixture-project",
    workspace: root,
    definitionFile: "workflow.yaml",
    instructions: "Preserve facts",
    trackedFiles: ["source.md"],
    maxRevisions: 1,
  };
  return { root, input };
}
async function submit(
  runtime: WorkflowRuntime,
  run: WorkflowRun,
  outcome: "done" | "pass" | "revise" | "blocked" | "cancel",
  evidence?: string[],
) {
  const files = evidence ?? run.task!.step!.outputs;
  for (const file of files)
    await writeFile(
      path.join(run.workspace, file),
      `Evidence for ${run.task!.taskId}`,
    );
  return runtime.submit({
    runId: run.runId,
    taskId: run.task!.taskId,
    outcome,
    summary: "Actual fixture evidence",
    evidence: files,
  });
}
test("DSL persists the exact definition and task across restart; enforces outputs, frozen reviews and revision paths", async () => {
  const f = await fixture();
  let runtime = await WorkflowRuntime.open(path.join(f.root, "db"));
  try {
    const validated = await runtime.validateDefinition({
      workspace: f.root,
      definitionFile: "workflow.yaml",
    });
    assert.equal(validated.edges.length, 3);
    let run = await runtime.create(f.input);
    assert.equal(run.stepId, "write");
    assert.equal(run.task?.step?.tools[0].name, "reels_get_app_state");
    const original = run.task!.taskId,
      hash = run.definition!.sha256;
    await writeFile(path.join(f.root, "workflow.yaml"), "changed: true");
    await runtime.close();
    runtime = await WorkflowRuntime.open(path.join(f.root, "db"));
    run = await runtime.get({ runId: run.runId });
    assert.equal(run.task!.taskId, original);
    assert.equal(run.definition!.sha256, hash);
    assert.equal(
      (await runtime.context({ runId: run.runId })).projectId,
      "fixture-project",
    );
    await assert.rejects(
      submit(runtime, run, "done", ["unrelated.md"]),
      /MISSING_OUTPUT/,
    );
    run = await submit(runtime, run, "done");
    const staleTask = run.task!.taskId;
    await writeFile(path.join(f.root, "draft.md"), "concurrent change");
    await assert.rejects(submit(runtime, run, "pass"), /STALE_INPUT/);
    run = await runtime.restart({ runId: run.runId });
    assert.notEqual(run.task!.taskId, staleTask);
    run = await submit(runtime, run, "revise");
    assert.equal(run.stepId, "write");
    assert.equal(run.revisions, 1);
    run = await submit(runtime, run, "done");
    run = await submit(runtime, run, "pass");
    assert.equal(run.status, "ready");
    assert.equal(run.task, null);
    assert.equal(run.history.length, 4);
    assert.equal(run.history[0].stepId, "write");
    const reports = run.history
      .filter((h) => h.stage === "review")
      .map((h) => Object.keys(h.evidence)[0]);
    assert.notEqual(reports[0], reports[1]);
    for (const file of reports)
      assert.match(await readFile(path.join(f.root, file), "utf8"), /Evidence/);
    await assert.rejects(
      runtime.submit({
        runId: run.runId,
        taskId: staleTask,
        outcome: "pass",
        summary: "stale",
        evidence: reports,
      }),
      /STALE_TASK/,
    );
  } finally {
    await runtime.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("invalid YAML topology, duplicate keys, aliases, unknown fields and escaped files are rejected before creation", async () => {
  const f = await fixture();
  const runtime = await WorkflowRuntime.open(path.join(f.root, "db"));
  try {
    for (const change of [
      (d: any) => (d.steps[0].on.done = "missing"),
      (d: any) => (d.steps[1].id = "write"),
      (d: any) => (d.steps[0].on.done = "write"),
      (d: any) => (d.entry = "missing"),
      (d: any) => (d.steps[0].run = "arbitrary shell"),
      (d: any) => (d.steps[0].outputs = ["../escape"]),
    ]) {
      const d = definition();
      change(d);
      assert.equal(workflowDefinitionSchema.safeParse(d).success, false);
    }
    for (const yaml of [
      "version: 1\nversion: 1",
      "a: &a [a]\nb: *a",
      "!unknown x",
    ]) {
      await writeFile(path.join(f.root, "workflow.yaml"), yaml);
      await assert.rejects(runtime.create(f.input));
    }
    await symlink("/etc/hosts", path.join(f.root, "escape.yaml"));
    await assert.rejects(
      runtime.create({ ...f.input, definitionFile: "escape.yaml" }),
      /escapes/,
    );
    assert.deepEqual(await runtime.list(), []);
  } finally {
    await runtime.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a revision may run ahead through an unsubmitted form but never back to a submitted one", () => {
  const memory = {
    id: "memory",
    title: "Your experience",
    kind: "input",
    instruction: "Answer based on your actual memory",
    formFile: "experience-form.json",
    completion: ["User submits explicit responses"],
  };
  // write → check (revise → write) → memory → complete: the form comes after the review,
  // so revising the draft cannot revisit a submitted form.
  const ahead = definition();
  ahead.steps[1].on = { pass: "memory", revise: "write" } as any;
  (ahead.steps as any[]).push({ ...memory, on: { done: "$complete" } });
  assert.equal(workflowDefinitionSchema.safeParse(ahead).success, true);
  // memory → write → check (revise → write): the form comes first, but the revision
  // only reaches write and check, so it never returns to the form.
  const behind = definition();
  (behind as any).entry = "memory";
  (behind.steps as any[]).unshift({ ...memory, on: { done: "write" } });
  const parsed = workflowDefinitionSchema.safeParse(behind);
  assert.equal(parsed.success, true);
  // write → memory → check (revise → write): the review follows the submitted form and
  // its revision would reach the form again, so it is rejected.
  const back = definition();
  back.steps[0].on = { done: "memory" } as any;
  (back.steps as any[]).splice(1, 0, { ...memory, on: { done: "check" } });
  const rejected = workflowDefinitionSchema.safeParse(back);
  assert.equal(rejected.success, false);
  assert.match(JSON.stringify(rejected.error!.issues), /cannot revisit a submitted input form/);
});

test("DSL input step uses the real shared form; normal submit cannot invent answers", async () => {
  const f = await fixture();
  const runtime = await WorkflowRuntime.open(path.join(f.root, "db"));
  try {
    const d = definition();
    d.steps[0].on.done = "memory";
    (d.steps as any[]).splice(1, 0, {
      id: "memory",
      title: "Your experience",
      kind: "input",
      instruction: "Answer based on your actual memory",
      formFile: "experience-form.json",
      completion: ["User submits explicit responses"],
      on: { done: "check" },
    });
    d.steps[1].on = { done: "check" } as any;
    d.steps[2].on.revise = "fix";
    (d.steps as any[]).push({
      ...definition().steps[0],
      id: "fix",
      title: "Fix",
      on: { done: "check" },
    });
    await writeFile(path.join(f.root, "workflow.yaml"), stringify(d));
    await writeFile(
      path.join(f.root, "experience-form.json"),
      JSON.stringify({
        version: 1,
        title: "Experience",
        introduction: "Actual memory only",
        facts: [],
        questions: [
          {
            id: "taste",
            section: "Taste",
            prompt: "What did you taste?",
            help: "",
            required: true,
            images: [],
          },
        ],
      }),
    );
    let run = await runtime.create(f.input);
    run = await submit(runtime, run, "done");
    assert.equal(run.stage, "experience");
    assert(run.experience);
    assert.equal(run.experience.projectId, "fixture-project");
    await assert.rejects(
      submit(runtime, run, "done", ["fake.md"]),
      /USER_INPUT_REQUIRED/,
    );
    await runtime.saveForm({
      formId: run.experience!.formId,
      expectedRevision: run.experience!.revision,
      answers: [{ questionId: "taste", status: "unknown", text: "" }],
      submit: true,
    });
    run = await runtime.get({ runId: run.runId });
    assert.equal(run.stepId, "check");
    assert.equal(run.experience?.answers[0].status, "unknown");
    assert(run.trackedFiles.some((f) => f.startsWith("experience-answers-")));
    run = await submit(runtime, run, "pass");
    assert.equal(run.status, "ready");
  } finally {
    await runtime.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("declared transition/revision budgets stop loops and a completed one-step run is valid", async () => {
  const f = await fixture();
  const runtime = await WorkflowRuntime.open(path.join(f.root, "db"));
  try {
    const d: any = definition();
    d.maxTransitions = 1;
    d.steps = [d.steps[0]];
    d.steps[0].on.done = "$complete";
    await writeFile(path.join(f.root, "workflow.yaml"), stringify(d));
    let run = await runtime.create(f.input);
    run = await submit(runtime, run, "done");
    assert.equal(run.status, "ready");
    await writeFile(
      path.join(f.root, "workflow.yaml"),
      stringify({ ...definition(), maxTransitions: 2 }),
    );
    // draft.md from the first run exists; work every step to exercise the budget.
    run = await runtime.create({ ...f.input, skipCompleted: false });
    run = await submit(runtime, run, "done");
    run = await submit(runtime, run, "revise");
    assert.equal(run.status, "blocked");
  } finally {
    await runtime.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a review step with its own maxRevisions spends only its own budget", async () => {
  const f = await fixture();
  const runtime = await WorkflowRuntime.open(path.join(f.root, "db"));
  try {
    // write → check (own budget 2) → final (run-wide budget, maxRevisions 1 in the input).
    const d: any = definition();
    d.steps[1].maxRevisions = 2;
    d.steps[1].on = { pass: "final", revise: "write" };
    d.steps.push({
      ...structuredClone(d.steps[1]),
      id: "final",
      title: "Final",
      maxRevisions: undefined,
      outputs: ["final-{attempt}.md"],
      on: { pass: "$complete", revise: "write" },
    });
    delete d.steps[2].maxRevisions;
    await writeFile(path.join(f.root, "workflow.yaml"), stringify(d));
    let run = await runtime.create({ ...f.input, skipCompleted: false });
    run = await submit(runtime, run, "done");
    // Two revisions of check exceed the run-wide 1 but stay within check's own 2.
    run = await submit(runtime, run, "revise");
    run = await submit(runtime, run, "done");
    run = await submit(runtime, run, "revise");
    assert.equal(run.status, "waiting");
    assert.equal(run.revisions, 2);
    run = await submit(runtime, run, "done");
    run = await submit(runtime, run, "pass");
    assert.equal(run.stepId, "final");
    // final shares the run-wide budget, which check's revisions did not use.
    run = await submit(runtime, run, "revise");
    assert.equal(run.status, "waiting");
    run = await submit(runtime, run, "done");
    run = await submit(runtime, run, "pass");
    assert.equal(run.stepId, "final");
    run = await submit(runtime, run, "revise");
    assert.equal(run.status, "blocked");
    assert.equal(run.blockedReason, "수정 루프 한도를 초과했어요.");
    // A third check revision is over its own budget; restart reopens the held review so
    // it can pass once the findings are fixed.
    const second = await runtime.create({ ...f.input, skipCompleted: false });
    let r = await submit(runtime, second, "done");
    for (let i = 0; i < 2; i++) {
      r = await submit(runtime, r, "revise");
      r = await submit(runtime, r, "done");
    }
    r = await submit(runtime, r, "revise");
    assert.equal(r.status, "blocked");
    assert.match(r.blockedReason!, /check 단계의 수정 루프 한도\(2회\)/);
    r = await runtime.restart({ runId: r.runId });
    assert.equal(r.stepId, "check");
    r = await submit(runtime, r, "pass");
    assert.equal(r.stepId, "final");
  } finally {
    await runtime.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("only review steps declare maxRevisions", () => {
  const d: any = definition();
  d.steps[0].maxRevisions = 2;
  const parsed = workflowDefinitionSchema.safeParse(d);
  assert.equal(parsed.success, false);
  assert.match(JSON.stringify(parsed.error!.issues), /only review steps declare maxRevisions/);
});
