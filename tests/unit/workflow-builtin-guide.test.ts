import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  readFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { WorkflowRuntime } from "../../src/app/workflow/runtime";
import { builtinDefinition } from "../../src/app/workflow/definition";
import type { WorkflowRun } from "../../src/shared/workflow";

// Synthetic fixtures only: <root>/workflows/guides.yaml, <root>/notes/*.md and a
// workspace at <root>/research/post. No real content, paths or skill names.
const DOC_TEXT = "synthetic-guide-body-that-must-not-be-stored";
const guide = (steps: Record<string, unknown>, extra = {}) =>
  stringify({ version: 1, steps, ...extra });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "workflow-builtin-"));
  const workspace = path.join(root, "research", "post");
  for (const dir of ["evidence", "media", "reviews"])
    await mkdir(path.join(workspace, dir), { recursive: true });
  await mkdir(path.join(root, "workflows"));
  await mkdir(path.join(root, "notes"));
  await writeFile(path.join(workspace, "brief.md"), "synthetic brief");
  await writeFile(path.join(root, "notes", "style.md"), DOC_TEXT);
  await writeFile(path.join(root, "notes", "images.md"), "image notes");
  const guideFile = path.join(root, "workflows", "guides.yaml");
  const runtime = await WorkflowRuntime.open(path.join(root, "db"));
  const input = {
    title: "Built-in run",
    workspace,
    builtinDefinition: "blog",
    instructions: "Synthetic",
    trackedFiles: ["brief.md"],
  };
  const put = (file: string, data: unknown) =>
    writeFile(
      path.join(workspace, file),
      typeof data === "string" ? data : JSON.stringify(data),
    );
  return { root, workspace, guideFile, runtime, input, put };
}

const defaultGuide = guide(
  {
    draft: {
      docs: ["notes/style.md", "notes/images.md"],
      instruction: "Synthetic local drafting rule.",
      skills: ["synthetic-skill"],
      tools: [
        {
          server: "reels_dashboard",
          name: "reels_convert_gif",
          purpose: "dup",
        },
        { server: "local", name: "local_tool", purpose: "Synthetic tool" },
      ],
    },
    image_review: { instruction: "Synthetic local review rule." },
  },
  { definition: "blog" },
);

test("the built-in blog definition is selected by name without a file in the workspace", async () => {
  const f = await fixture();
  try {
    const snapshot = builtinDefinition("blog");
    assert.deepEqual(
      snapshot.definition.steps.map((s) => [s.id, s.kind]),
      [
        ["prepare", "task"],
        ["experience", "input"],
        ["draft", "task"],
        ["image_review", "review"],
        ["text_review", "review"],
        ["layout", "task"],
        ["visual_review", "review"],
      ],
    );
    assert.equal(
      snapshot.sha256,
      createHash("sha256").update(snapshot.source).digest("hex"),
    );
    // Review outputs are per attempt so a revise loop can write fresh reports.
    for (const step of snapshot.definition.steps.filter(
      (s) => s.kind === "review",
    ))
      assert.ok(
        step.outputs.every((o) => o.includes("{attempt}")),
        step.id,
      );
    const validated = await f.runtime.validateDefinition({
      workspace: f.workspace,
      builtinDefinition: "blog",
    });
    assert.equal(validated.file, "builtin:blog");
    assert.equal(validated.guide, undefined);
    assert.deepEqual(validated.skippable, { skipped: [], startsAt: "prepare" });
    const run = await f.runtime.create(f.input);
    assert.equal(run.definition!.file, "builtin:blog");
    assert.equal(run.definition!.sha256, snapshot.sha256);
    assert.equal(run.definition!.source, snapshot.source);
    assert.equal(run.stepId, "prepare");
    // Without a guide the task carries the built-in contract unchanged.
    assert.equal(
      run.task!.instruction,
      snapshot.definition.steps[0].instruction,
    );
    assert.deepEqual(run.task!.step!.skills, []);
    assert.equal(run.guide, undefined);
  } finally {
    await f.runtime.close();
  }
});

test("definition choice: exactly one of definitionFile and builtinDefinition; a guide needs a definition", async () => {
  const f = await fixture();
  try {
    await writeFile(
      path.join(f.root, "workflows", "x.yaml"),
      builtinDefinition("blog").source,
    );
    await assert.rejects(
      f.runtime.validateDefinition({
        workspace: f.workspace,
        builtinDefinition: "blog",
        definitionFile: path.join(f.root, "workflows", "x.yaml"),
      }),
      /exactly one/,
    );
    await assert.rejects(
      f.runtime.validateDefinition({ workspace: f.workspace }),
      /exactly one/,
    );
    await assert.rejects(
      f.runtime.validateDefinition({
        workspace: f.workspace,
        builtinDefinition: "unknown",
      }),
    );
    const { builtinDefinition: _omit, ...plain } = f.input;
    await assert.rejects(
      f.runtime.create({ ...plain, guideFile: f.guideFile }),
      /GUIDE: a guide file needs/,
    );
    await assert.rejects(
      f.runtime.create({
        ...f.input,
        definitionFile: path.join(f.root, "workflows", "x.yaml"),
      }),
      /exactly one/,
    );
  } finally {
    await f.runtime.close();
  }
});

test("a local guide is merged after the built-in instruction; documents are stored by path and hash only", async () => {
  const f = await fixture();
  try {
    await writeFile(f.guideFile, defaultGuide);
    const validated = await f.runtime.validateDefinition({
      workspace: f.workspace,
      builtinDefinition: "blog",
      guideFile: f.guideFile,
    });
    assert.deepEqual(Object.keys(validated.guide!.steps).sort(), [
      "draft",
      "image_review",
    ]);
    assert.deepEqual(
      validated.guide!.steps.draft.docs.map((d) => d.file),
      ["notes/style.md", "notes/images.md"],
    );
    assert.equal(
      validated.guide!.steps.draft.docs[0].sha256,
      createHash("sha256").update(DOC_TEXT).digest("hex"),
    );
    // Draft is reached by working prepare and answering the form.
    await f.put("media/s1.png", "png");
    await f.put("evidence/media-scenes.json", {
      version: 1,
      scenes: [
        {
          id: "s1",
          source: "synthetic",
          preview: "media/s1.png",
          observed: "x",
        },
      ],
    });
    await f.put("experience-form.json", {
      version: 1,
      title: "Synthetic form",
      introduction: "",
      facts: [],
      questions: [{ id: "q1", section: "S", prompt: "Prompt q1" }],
    });
    let run: WorkflowRun = await f.runtime.create({
      ...f.input,
      guideFile: f.guideFile,
      skipCompleted: false,
    });
    assert.equal(run.stepId, "prepare");
    // Steps without a guide entry keep the built-in instruction.
    assert.ok(!run.task!.instruction.includes("로컬 가이드"));
    run = await f.runtime.submit({
      runId: run.runId,
      taskId: run.task!.taskId,
      outcome: "done",
      summary: "synthetic",
      evidence: ["evidence/media-scenes.json", "experience-form.json"],
    });
    assert.equal(run.stepId, "experience");
    run = await f.runtime.saveExperience({
      runId: run.runId,
      taskId: run.task!.taskId,
      expectedRevision: run.experience!.revision,
      answers: [{ questionId: "q1", status: "answered", text: "synthetic" }],
      submit: true,
    });
    run = await f.runtime.get({ runId: run.runId });
    assert.equal(run.stepId, "draft");
    const builtin = builtinDefinition("blog").definition.steps.find(
      (s) => s.id === "draft",
    )!;
    const instruction = run.task!.instruction;
    assert.ok(instruction.startsWith(builtin.instruction));
    const local = instruction.slice(builtin.instruction.length);
    assert.match(local, /로컬 가이드 \(.*guides\.yaml\):/);
    assert.match(local, /Synthetic local drafting rule\./);
    const docPath = await realpath(path.join(f.root, "notes", "style.md"));
    assert.ok(local.includes(`- ${docPath}`));
    assert.equal(run.task!.step!.instruction, instruction);
    assert.deepEqual(run.task!.step!.skills, ["synthetic-skill"]);
    assert.deepEqual(
      run.task!.step!.tools.map((t) => `${t.server}/${t.name}`),
      ["reels_dashboard/reels_convert_gif", "local/local_tool"],
    );
    // Flow is unchanged by the guide.
    assert.deepEqual(run.task!.step!.outputs, builtin.outputs);
    assert.deepEqual(run.task!.step!.on, builtin.on);
    // The guide snapshot is frozen; document bodies are never stored.
    assert.equal(run.guide!.file, f.guideFile);
    assert.ok(!JSON.stringify(run).includes(DOC_TEXT));
    await writeFile(f.guideFile, guide({ draft: { instruction: "Changed" } }));
    const again = await f.runtime.get({ runId: run.runId });
    assert.match(again.guide!.source, /Synthetic local drafting rule/);
  } finally {
    await f.runtime.close();
  }
});

test("a guide cannot change the flow, name unknown steps or reach outside its base", async () => {
  const f = await fixture();
  try {
    const check = async (
      source: string,
      pattern: RegExp,
      file = f.guideFile,
    ) => {
      await writeFile(f.guideFile, source);
      await assert.rejects(
        f.runtime.validateDefinition({
          workspace: f.workspace,
          builtinDefinition: "blog",
          guideFile: file,
        }),
        pattern,
      );
    };
    await check(
      guide({ publish: { instruction: "x" } }),
      /unknown step publish/,
    );
    for (const key of [
      "on",
      "outputs",
      "inputs",
      "kind",
      "completion",
      "title",
    ])
      await check(
        guide({ draft: { [key]: key === "on" ? { done: "layout" } : ["x"] } }),
        /Unrecognized key|unrecognized/i,
      );
    await check(
      stringify({ version: 1, steps: {}, entry: "draft" }),
      /Unrecognized key|unrecognized/i,
    );
    await check(
      guide({}, { definition: "other-flow" }),
      /written for definition other-flow/,
    );
    await check(guide({ draft: { docs: ["../outside.md"] } }), /normalized/);
    await check(guide({ draft: { docs: ["/etc/hosts"] } }), /normalized/);
    await check(
      guide({ draft: { docs: ["notes/missing.md"] } }),
      /GUIDE: draft documents/,
    );
    // A link inside the base that points outside is rejected by its real path.
    const outside = await mkdtemp(path.join(tmpdir(), "workflow-guide-out-"));
    await writeFile(path.join(outside, "secret.md"), "outside");
    await symlink(
      path.join(outside, "secret.md"),
      path.join(f.root, "notes", "link.md"),
    );
    await check(
      guide({ draft: { docs: ["notes/link.md"] } }),
      /escapes workspace/,
    );
    // The guide file itself follows the shared definition boundary.
    await writeFile(path.join(outside, "g.yaml"), guide({}));
    await check(
      guide({}),
      /GUIDE: use a YAML file/,
      path.join(outside, "g.yaml"),
    );
    await mkdir(path.join(f.root, "other"));
    await writeFile(path.join(f.root, "other", "g.yaml"), guide({}));
    await check(
      guide({}),
      /GUIDE: use a YAML file/,
      path.join(f.root, "other", "g.yaml"),
    );
    // YAML aliases/duplicate keys are rejected like in definitions.
    await check(
      "version: 1\nsteps:\n  draft: {}\n  draft: {}\n",
      /Invalid guide YAML/,
    );
  } finally {
    await f.runtime.close();
  }
});

test("a workspace guide resolves its documents inside the workspace", async () => {
  const f = await fixture();
  try {
    await f.put("local-notes.md", "workspace notes");
    await f.put(
      "workflow.guides.yaml",
      guide({ prepare: { docs: ["local-notes.md"], skills: ["s"] } }),
    );
    const run = await f.runtime.create({
      ...f.input,
      guideFile: "workflow.guides.yaml",
    });
    assert.equal(run.guide!.base, await realpath(f.workspace));
    assert.match(run.task!.instruction, /local-notes\.md/);
    assert.deepEqual(run.task!.step!.skills, ["s"]);
    await f.put(
      "workflow.guides.yaml",
      guide({ prepare: { docs: ["../../notes/style.md"] } }),
    );
    await assert.rejects(
      f.runtime.validateDefinition({
        workspace: f.workspace,
        builtinDefinition: "blog",
        guideFile: "workflow.guides.yaml",
      }),
      /normalized/,
    );
  } finally {
    await f.runtime.close();
  }
});

test("built-in definition with a guide skips completed leading steps and guides the first review", async () => {
  const f = await fixture();
  try {
    await writeFile(f.guideFile, defaultGuide);
    await f.put("media/s1.png", "png");
    await f.put("evidence/media-scenes.json", {
      version: 1,
      scenes: [
        {
          id: "s1",
          source: "synthetic",
          preview: "media/s1.png",
          observed: "x",
        },
      ],
    });
    const created = await f.runtime.createForm({
      workspace: f.workspace,
      form: {
        version: 1,
        title: "Synthetic form",
        introduction: "",
        facts: [],
        questions: [{ id: "q1", section: "S", prompt: "Prompt q1" }],
      },
    });
    await f.runtime.saveForm({
      formId: created.formId,
      expectedRevision: created.revision,
      answers: [{ questionId: "q1", status: "answered", text: "a" }],
      submit: true,
    });
    await f.put("article.markup.md", "draft");
    await f.put("story-layout.md", "layout notes");
    await f.put("evidence/story-media-plan.json", {
      version: 1,
      inventory: "evidence/media-scenes.json",
      decisions: [
        {
          sceneId: "s1",
          decision: "use",
          reason: "fits",
          handling: "keep",
          group: "g1",
          role: "opening",
        },
      ],
    });
    const before = await readFile(
      path.join(f.workspace, "article.markup.md"),
      "utf8",
    );
    const preview = await f.runtime.validateDefinition({
      workspace: f.workspace,
      builtinDefinition: "blog",
      guideFile: f.guideFile,
    });
    assert.deepEqual(
      preview.skippable.skipped.map((s) => s.stepId),
      ["prepare", "experience", "draft"],
    );
    assert.equal(preview.skippable.startsAt, "image_review");
    const run = await f.runtime.create({ ...f.input, guideFile: f.guideFile });
    assert.equal(run.stepId, "image_review");
    assert.deepEqual(
      run.history.map((h) => h.outcome),
      ["skipped", "skipped", "skipped"],
    );
    assert.match(run.task!.instruction, /Synthetic local review rule\./);
    assert.deepEqual(run.task!.step!.outputs, [
      "reviews/image-review-4.md",
      "reviews/image-plan-4.md",
    ]);
    assert.equal(
      await readFile(path.join(f.workspace, "article.markup.md"), "utf8"),
      before,
    );
    const context = await f.runtime.context({ runId: run.runId });
    assert.equal(context.definition!.file, "builtin:blog");
    assert.equal(context.guide!.file, f.guideFile);
  } finally {
    await f.runtime.close();
  }
});
