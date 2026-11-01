import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkflowRuntime } from "../../src/app/workflow/runtime";

test("experience intake survives restart, preserves original answers, rejects bypass and stale writes, unlocks draft only on submission", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "experience-"));
  let runtime = await WorkflowRuntime.open(path.join(root, "db"));
  try {
    await writeFile(path.join(root, "source.md"), "Synthetic source");
    const form = {
      version: 1,
      title: "내 경험",
      introduction: "한 번에 작성",
      facts: [{ text: "사진 관찰", source: "source.md", status: "observed" }],
      questions: [
        {
          id: "taste",
          section: "맛",
          prompt: "어떤 맛이었나요?",
          required: true,
          images: [],
        },
        {
          id: "companion",
          section: "동행",
          prompt: "동행 반응은?",
          required: true,
          images: [],
        },
      ],
    };
    await writeFile(
      path.join(root, "experience-form.json"),
      JSON.stringify(form),
    );
    let run = await runtime.create({
      title: "Fixture",
      workspace: root,
      instructions: "Keep facts",
      trackedFiles: ["source.md"],
      collectExperience: true,
    });
    await assert.rejects(
      runtime.submit({
        runId: run.runId,
        taskId: run.task!.taskId,
        outcome: "done",
        summary: "prep",
        evidence: ["source.md"],
      }),
      /EXPERIENCE_FORM_REQUIRED/,
    );
    run = await runtime.submit({
      runId: run.runId,
      taskId: run.task!.taskId,
      outcome: "done",
      summary: "prep",
      evidence: ["experience-form.json"],
    });
    assert.equal(run.stage, "experience");
    await assert.rejects(
      runtime.submit({
        runId: run.runId,
        taskId: run.task!.taskId,
        outcome: "done",
        summary: "fake answer",
        evidence: ["source.md"],
      }),
      /USER_INPUT_REQUIRED/,
    );
    const base = {
      runId: run.runId,
      taskId: run.task!.taskId,
      expectedRevision: 0,
    };
    const answer = {
      questionId: "taste",
      status: "answered",
      text: "소스가 킥!!\n다음엔 이것만...",
    };
    await runtime.saveExperience({ ...base, answers: [answer] });
    await assert.rejects(
      runtime.saveExperience({ ...base, answers: [] }),
      /STALE_FORM/,
    );
    await runtime.close();
    runtime = await WorkflowRuntime.open(path.join(root, "db"));
    run = await runtime.get({ runId: run.runId });
    assert.deepEqual(run.experience!.answers, [answer]);
    await assert.rejects(
      runtime.saveExperience({
        ...base,
        expectedRevision: 1,
        answers: [answer],
        submit: true,
      }),
      /기억나지/,
    );
    await assert.rejects(
      runtime.saveExperience({
        ...base,
        expectedRevision: 1,
        answers: [{ ...answer, questionId: "fake" }],
      }),
      /Unknown/,
    );
    await writeFile(path.join(root, "source.md"), "Changed evidence");
    await assert.rejects(
      runtime.saveExperience({
        ...base,
        expectedRevision: 1,
        answers: [
          answer,
          { questionId: "companion", status: "unknown", text: "" },
        ],
        submit: true,
      }),
      /STALE_INPUT/,
    );
    await writeFile(path.join(root, "source.md"), "Synthetic source");
    run = await runtime.saveExperience({
      ...base,
      expectedRevision: 1,
      answers: [
        answer,
        { questionId: "companion", status: "unknown", text: "" },
      ],
      submit: true,
    });
    assert.equal(run.stage, "draft");
    assert.equal(run.experience!.status, "submitted");
    const exported = JSON.parse(
      await readFile(path.join(root, run.experience!.exports[0]), "utf8"),
    );
    assert.equal(exported.answers[0].text, answer.text);
    assert.equal(exported.answers[1].status, "unknown");
    assert(run.experience!.exports.every((f) => f in run.task!.inputHashes));
    await assert.rejects(
      runtime.saveExperience({
        ...base,
        expectedRevision: 2,
        answers: [],
        submit: true,
      }),
      /STALE_TASK/,
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("question images must stay in workspace; changed images cannot be served", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "experience-image-"));
  const runtime = await WorkflowRuntime.open(path.join(root, "db"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "experience-outside-"));
  try {
    await writeFile(path.join(root, "source.md"), "fixture");
    await writeFile(path.join(outside, "image.jpg"), "private");
    await symlink(
      path.join(outside, "image.jpg"),
      path.join(root, "image.jpg"),
    );
    const form = {
      version: 1,
      title: "사진",
      introduction: "",
      facts: [],
      questions: [
        {
          id: "q",
          section: "장면",
          prompt: "기억은?",
          images: [{ path: "image.jpg", caption: "fixture" }],
        },
      ],
    };
    await writeFile(
      path.join(root, "experience-form.json"),
      JSON.stringify(form),
    );
    let run = await runtime.create({
      title: "Fixture",
      workspace: root,
      instructions: "fixture",
      trackedFiles: ["source.md"],
      collectExperience: true,
    });
    const prep = {
      runId: run.runId,
      taskId: run.task!.taskId,
      outcome: "done",
      summary: "prep",
      evidence: ["experience-form.json"],
    };
    await assert.rejects(runtime.submit(prep), /escapes/);
    await rm(path.join(root, "image.jpg"));
    await writeFile(path.join(root, "image.jpg"), "synthetic preview");
    run = await runtime.submit(prep);
    assert(
      (
        await runtime.experienceMedia({
          runId: run.runId,
          questionId: "q",
          imageIndex: 0,
        })
      ).dataUrl.startsWith("data:image/jpeg"),
    );
    await writeFile(path.join(root, "image.jpg"), "changed");
    await assert.rejects(
      runtime.experienceMedia({
        runId: run.runId,
        questionId: "q",
        imageIndex: 0,
      }),
      /STALE_INPUT/,
    );
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
