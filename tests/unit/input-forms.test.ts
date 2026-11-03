import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { WorkflowRuntime } from "../../src/app/workflow/runtime";
import { startWorkflowServer } from "../../src/app/workflow/server";
import { workflowRequest } from "../../src/app/workflow/client";
const form = {
  version: 1,
  title: "Shared fixture form",
  introduction: "Use original words",
  facts: [],
  questions: [
    { id: "q", section: "Memory", prompt: "What happened?", images: [] },
    { id: "unknown", section: "Unknown", prompt: "Remember?", images: [] },
  ],
};
const answers = [
  {
    questionId: "q",
    status: "answered",
    text: "진짜 소스가 킥!!\n사진도 확인해줘.",
  },
  { questionId: "unknown", status: "unknown", text: "" },
];
test("session forms do not create workflows; IDs are idempotent, answers survive restart and bind to dashboard without copies", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shared-forms-"));
  let rt = await WorkflowRuntime.open(path.join(root, "db"));
  try {
    await writeFile(path.join(root, "source.md"), "Synthetic source");
    const input = {
      formId: randomUUID(),
      workspace: root,
      projectId: "content:fixture",
      form,
      sourceFiles: ["source.md"],
    };
    let f = await rt.createForm(input);
    assert.equal((await rt.list()).length, 0);
    assert.equal((await rt.createForm(input)).formId, f.formId);
    await assert.rejects(
      rt.createForm({ ...input, form: { ...form, title: "changed" } }),
      /FORM_ID_CONFLICT/,
    );
    f = await rt.saveForm({
      formId: f.formId,
      expectedRevision: 0,
      answers: [answers[0]],
    });
    await assert.rejects(
      rt.saveForm({ formId: f.formId, expectedRevision: 0, answers }),
      /STALE_FORM/,
    );
    await rt.close();
    rt = await WorkflowRuntime.open(path.join(root, "db"));
    assert.equal(
      rt.getForm({ formId: f.formId }).answers[0].text,
      answers[0].text,
    );
    f = await rt.saveForm({
      formId: f.formId,
      expectedRevision: 1,
      answers,
      submit: true,
    });
    const output = rt.formResults({ formId: f.formId });
    assert.equal(output.responses[1].status, "unknown");
    assert.equal(output.responses[0].text, answers[0].text);
    const snap = JSON.parse(
      await readFile(path.join(root, f.exports[0]), "utf8"),
    );
    assert.deepEqual(snap.answers, answers);
    const r = await rt.create({
      title: "Dashboard continuation",
      workspace: root,
      instructions: "fixture",
      trackedFiles: ["source.md"],
      inputFormId: f.formId,
    });
    assert.equal(r.stage, "requests");
    assert.equal(r.experience!.formId, f.formId);
    assert.deepEqual(r.experience!.answers, answers);
    assert.equal(rt.listForms({}).forms.length, 1);
    await assert.rejects(
      rt.create({
        title: "duplicate binding",
        workspace: root,
        instructions: "fixture",
        trackedFiles: ["source.md"],
        inputFormId: f.formId,
      }),
      /FORM_BOUND/,
    );
    await writeFile(path.join(root, "result.md"), "Result applied");
    const pending = rt.waitForm({
      formId: f.formId,
      afterRevision: f.revision,
      timeoutMs: 1000,
    });
    const applied = await rt.applyForm({
      formId: f.formId,
      expectedRevision: f.revision,
      summary: "Original user wording applied",
      evidence: ["result.md"],
    });
    assert.equal((await pending).reason, "change");
    assert.equal(
      (
        await rt.waitForm({
          formId: f.formId,
          afterRevision: applied.revision,
          timeoutMs: 1,
        })
      ).reason,
      "timeout",
    );
    assert.equal(applied.applications[0].submissionRevision, f.revision);
    assert.equal(
      (await rt.formArtifact({ formId: f.formId, path: "result.md" })).text,
      "Result applied",
    );
    await assert.rejects(
      rt.formArtifact({ formId: f.formId, path: "source.md" }),
      /Unregistered/,
    );
    await writeFile(path.join(root, "result.md"), "Changed result");
    await assert.rejects(
      rt.formArtifact({ formId: f.formId, path: "result.md" }),
      /STALE_ARTIFACT/,
    );
    assert.equal(applied.answers[0].text, answers[0].text);
    await assert.rejects(
      rt.applyForm({
        formId: f.formId,
        expectedRevision: f.revision,
        summary: "stale",
        evidence: ["result.md"],
      }),
      /STALE_FORM/,
    );
  } finally {
    await rt.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("real stdio MCP and forms CLI share create/save/results/apply/open with HTTP and no workflow", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "forms-mcp-"));
  const opened: string[] = [];
  const h = await startWorkflowServer({
    root: path.join(root, "db"),
    port: 0,
    openForm: async (id) => {
      opened.push(id);
      return {};
    },
  });
  const client = new Client({ name: "forms-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/app/workflow/mcp.ts"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH!, REELS_WORKFLOW_URL: h.url },
    stderr: "pipe",
  });
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          ["--import", "tsx", "src/app/workflow/forms-cli.ts", ...args],
          {
            cwd: process.cwd(),
            env: { ...process.env, REELS_WORKFLOW_URL: h.url },
          },
        )
      ).stdout,
    );
  try {
    await writeFile(
      path.join(root, "create.json"),
      JSON.stringify({ workspace: root, form }),
    );
    const f = await cli("create", path.join(root, "create.json"));
    assert.equal((await cli("list")).forms[0].formId,f.formId);
    await writeFile(path.join(root,"partial.json"),JSON.stringify({formId:f.formId,expectedRevision:0,answers:[answers[0]],submit:false}));
    await cli("save",path.join(root,"partial.json"));
    assert.equal((await cli("wait",f.formId,"1","0")).reason,"timeout");
    await client.connect(transport);
    const tools = await client.listTools();
    assert(tools.tools.some((t) => t.name === "reels_form_results"));
    const awaiting = client.callTool({name:"reels_form_wait",arguments:{formId:f.formId,afterRevision:1,timeoutMs:1000}});
    const saved = await client.callTool({
      name: "reels_form_save",
      arguments: {
        formId: f.formId,
        expectedRevision: 1,
        answers,
        submit: true,
      },
    });
    assert(!saved.isError);
    assert.equal(((await awaiting).structuredContent as any).reason,"change");
    assert.equal((await cli("sync",f.formId)).revision,2);
    const out = await cli("results", f.formId);
    assert.equal(out.responses[0].text, answers[0].text);
    assert.equal((await workflowRequest("list", {}, h.url)).runs.length, 0);
    const openedLink = await cli("open", f.formId);
    assert.equal(openedLink.opened, false);
    assert(openedLink.url.includes("form=" + f.formId));
    await cli("open", f.formId, "--desktop");
    assert.deepEqual(opened, [f.formId]);
    await writeFile(path.join(root, "result.md"), "Actual result");
    await writeFile(
      path.join(root, "apply.json"),
      JSON.stringify({
        formId: f.formId,
        expectedRevision: 2,
        summary: "Done",
        evidence: ["result.md"],
      }),
    );
    await cli("apply", path.join(root, "apply.json"));
    const latest = await client.callTool({
      name: "reels_form_get",
      arguments: { formId: f.formId },
    });
    assert.equal((latest.structuredContent as any).applications.length, 1);
    const bad = await fetch(h.url + "/api/workflows/form-save", {
      method: "POST",
      headers: {
        Origin: "https://foreign.example",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(bad.status, 403);
  } finally {
    await client.close();
    await h.close();
    await rm(root, { recursive: true, force: true });
  }
});
