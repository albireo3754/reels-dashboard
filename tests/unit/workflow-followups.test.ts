import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowRuntime } from "../../src/app/workflow/runtime";
import type { WorkflowRun } from "../../src/shared/workflow";

test("answer requests become durable individual tasks; blocked work prevents drafting; completed review can reopen for corrections", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "followups-"));
  let rt = await WorkflowRuntime.open(path.join(root, "db"));
  const submit = (r: WorkflowRun, outcome = "done", evidence = ["report.md"]) =>
    rt.submit({
      runId: r.runId,
      taskId: r.task!.taskId,
      outcome,
      summary: "Evidence-backed result",
      evidence,
    });
  try {
    await writeFile(path.join(root, "source.md"), "Synthetic facts");
    await writeFile(path.join(root, "report.md"), "Synthetic evidence");
    await writeFile(
      path.join(root, "experience-form.json"),
      JSON.stringify({
        version: 1,
        title: "fixture",
        introduction: "",
        facts: [],
        questions: [
          { id: "q", section: "memory", prompt: "Memory?", images: [] },
        ],
      }),
    );
    let r = await rt.create({
      title: "fixture",
      workspace: root,
      instructions: "fixture",
      trackedFiles: ["source.md"],
      collectExperience: true,
    });
    r = await submit(r, "done", ["experience-form.json"]);
    r = await rt.saveExperience({
      runId: r.runId,
      taskId: r.task!.taskId,
      expectedRevision: 0,
      answers: [
        {
          questionId: "q",
          status: "answered",
          text: "바삭했음. 주차 조사해줘. 질문 개선해줘.",
        },
      ],
      submit: true,
    });
    assert.equal(r.stage, "requests");
    await assert.rejects(submit(r), /FOLLOWUP_MANIFEST_REQUIRED/);
    const source = r.experience!.exports[1];
    const task = (id: string, quote: string) => ({
      id,
      title: id,
      kind: "research",
      sourceFile: source,
      sourceQuote: quote,
      instruction: "Inspect evidence",
      executor: "session",
    });
    let m = {
      version: 1,
      reviewedAnswerIds: ["q"],
      tasks: [
        task("parking", "주차 조사해줘."),
        task("skill", "질문 개선해줘."),
      ],
    };
    await writeFile(
      path.join(root, "followup-tasks.json"),
      JSON.stringify({ ...m, tasks: [task("fake", "never said this")] }),
    );
    await assert.rejects(submit(r, "done", ["followup-tasks.json"]), /quote/);
    await writeFile(path.join(root, "followup-tasks.json"), JSON.stringify(m));
    r = await submit(r, "done", ["followup-tasks.json"]);
    assert.equal(r.stage, "followup");
    assert.equal(r.task!.followupId, "parking");
    const stale = r.task!.taskId;
    r = await submit(r, "blocked");
    assert.equal(r.status, "blocked");
    assert.equal(r.followups!.tasks[0].status, "blocked");
    await rt.close();
    rt = await WorkflowRuntime.open(path.join(root, "db"));
    r = await rt.restart({ runId: r.runId });
    assert.equal(r.task!.followupId, "parking");
    await assert.rejects(
      rt.submit({
        runId: r.runId,
        taskId: stale,
        outcome: "done",
        summary: "stale",
        evidence: ["report.md"],
      }),
      /STALE_TASK/,
    );
    r = await submit(r);
    assert.equal(r.task!.followupId, "skill");
    r = await submit(r);
    assert.equal(r.stage, "draft");
    assert(r.followups!.tasks.every((t) => t.status === "done"));
    assert(r.followups!.tasks.every((t) => t.evidence["report.md"]));
    r = await submit(r);
    assert.equal(r.stage, "review");
    await writeFile(path.join(root, "new-request.md"), "Fix image paths");
    r = await rt.openFollowups({
      runId: r.runId,
      expectedTaskId: r.task!.taskId,
      evidence: ["new-request.md"],
    });
    assert.equal(r.stage, "requests");
    m = {
      ...m,
      tasks: [
        { ...task("paths", "Fix image paths"), sourceFile: "new-request.md" },
      ],
    };
    await writeFile(
      path.join(root, "second-followups.json"),
      "not the contract",
    );
    // Keep old classification immutable; use a new artifact directory.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(root, "again"));
    await writeFile(
      path.join(root, "again/followup-tasks.json"),
      JSON.stringify(m),
    );
    r = await submit(r, "done", ["again/followup-tasks.json"]);
    r = await submit(r);
    assert.equal(r.stage, "revise");
    r = await submit(r);
    assert.equal(r.stage, "review");
    assert(
      (await readFile(path.join(root, source), "utf8")).includes(
        "주차 조사해줘.",
      ),
    );
  } finally {
    await rt.close();
    await rm(root, { recursive: true, force: true });
  }
});
