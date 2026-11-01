import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { WorkflowRuntime } from "../../src/app/workflow/runtime";
import { startWorkflowServer } from "../../src/app/workflow/server";
import { workflowRequest } from "../../src/app/workflow/client";
import type { WorkflowRun } from "../../src/shared/workflow";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "reels-workflow-"));
  const workspace = path.join(root, "content");
  await mkdir(workspace);
  await writeFile(
    path.join(workspace, "source.md"),
    "Synthetic confirmed facts",
  );
  await writeFile(
    path.join(workspace, "report.md"),
    "Synthetic review evidence",
  );
  return {
    root,
    workspace,
    input: {
      title: "Synthetic blog",
      workspace,
      instructions: "Use confirmed fixture facts; inspect the preview",
      trackedFiles: ["source.md"],
      maxRevisions: 1,
    },
  };
}
function submission(
  run: WorkflowRun,
  outcome: "done" | "pass" | "revise" | "blocked" | "cancel" = "done",
) {
  return {
    runId: run.runId,
    taskId: run.task!.taskId,
    outcome,
    summary: "Fixture work and evidence",
    evidence: ["report.md"],
  };
}
test("LangGraph persists interrupt, rejects duplicate/stale reviews, loops and completes after restart", async () => {
  const f = await fixture();
  let runtime = await WorkflowRuntime.open(path.join(f.root, "db"));
  try {
    let run = await runtime.create(f.input);
    assert.equal(run.task?.stage, "prepare");
    const duplicate = submission(run);
    run = await runtime.submit(duplicate);
    await assert.rejects(runtime.submit(duplicate), /STALE_TASK/);
    await writeFile(path.join(f.workspace, "draft.md"), "Synthetic draft");
    run = await runtime.submit({ ...submission(run), evidence: ["draft.md"] });
    assert.equal(run.stage, "review");
    assert(run.trackedFiles.includes("draft.md"));
    const taskId = run.task!.taskId;
    await runtime.close();
    runtime = await WorkflowRuntime.open(path.join(f.root, "db"));
    run = await runtime.get({ runId: run.runId });
    assert.equal(run.task!.taskId, taskId);
    await writeFile(
      path.join(f.workspace, "draft.md"),
      "User correction while reviewing",
    );
    await assert.rejects(
      runtime.submit(submission(run, "pass")),
      /STALE_INPUT/,
    );
    run = await runtime.restart({ runId: run.runId });
    assert.notEqual(run.task!.taskId, taskId);
    run = await runtime.submit(submission(run, "revise"));
    assert.equal(run.stage, "revise");
    run = await runtime.submit(submission(run));
    assert.equal(run.stage, "review");
    run = await runtime.submit(submission(run, "pass"));
    assert.equal(run.stage, "layout");
    await writeFile(
      path.join(f.workspace, "draft.md"),
      "Prose changed during layout",
    );
    run = await runtime.submit(submission(run));
    assert.equal(
      run.stage,
      "review",
      "layout changes to approved prose require a new text review",
    );
    run = await runtime.submit(submission(run, "pass"));
    run = await runtime.submit(submission(run));
    assert.equal(run.stage, "visual_review");
    run = await runtime.submit(submission(run, "pass"));
    assert.equal(run.status, "ready");
    assert.equal(run.task, null);
    run = await runtime.restart({ runId: run.runId });
    assert.equal(run.stage, "review");
    run = await runtime.submit(submission(run, "revise"));
    assert.equal(run.status, "blocked");
    assert.equal(run.revisions, 2);
  } finally {
    await runtime.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("run ownership, evidence boundaries, stage validation and cancellation", async () => {
  const f = await fixture();
  const runtime = await WorkflowRuntime.open(path.join(f.root, "db"));
  try {
    await assert.rejects(
      WorkflowRuntime.open(path.join(f.root, "db")),
      /running server/,
    );
    await assert.rejects(
      runtime.create({ ...f.input, trackedFiles: ["../outside"] }),
      /relative/,
    );
    let run = await runtime.create(f.input);
    await assert.rejects(
      runtime.submit(submission(run, "pass")),
      /Invalid outcome/,
    );
    await assert.rejects(
      runtime.submit({ ...submission(run), evidence: [] }),
      /Evidence/,
    );
    run = await runtime.submit(submission(run, "blocked"));
    assert.equal(run.status, "blocked");
    run = await runtime.restart({ runId: run.runId });
    assert.equal(run.stage, "prepare");
    run = await runtime.submit(submission(run, "cancel"));
    assert.equal(run.status, "cancelled");
    await assert.rejects(runtime.restart({ runId: run.runId }), /Cancelled/);
  } finally {
    await runtime.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("headless HTTP, CLI and actual stdio MCP share a run without Electron or model API", async () => {
  const f = await fixture();
  const handle = await startWorkflowServer({
    root: path.join(f.root, "db"),
    port: 0,
  });
  const client = new Client({ name: "workflow-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/app/workflow/mcp.ts"],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH!, REELS_WORKFLOW_URL: handle.url },
    stderr: "pipe",
  });
  try {
    const run = await workflowRequest("create", f.input, handle.url);
    const response = await fetch(`${handle.url}/api/workflows/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://untrusted.example",
      },
      body: JSON.stringify(f.input),
    });
    assert.equal(response.status, 403);
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 9);
    const result = await client.callTool({
      name: "reels_workflow_get",
      arguments: { runId: run.runId },
    });
    assert.equal(result.isError, undefined);
    assert.equal(
      (result.structuredContent as unknown as WorkflowRun).task?.taskId,
      run.task.taskId,
    );
    const submitted = await client.callTool({
      name: "reels_workflow_submit",
      arguments: submission(run),
    });
    assert.equal(submitted.isError, undefined);
    const cli = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "src/app/workflow/main.ts", "get", run.runId],
      {
        cwd: process.cwd(),
        env: { ...process.env, REELS_WORKFLOW_URL: handle.url },
      },
    );
    assert.equal(JSON.parse(cli.stdout).stage, "draft");
    const stale = await client.callTool({
      name: "reels_workflow_submit",
      arguments: submission(run),
    });
    assert.equal(stale.isError, true);
  } finally {
    await client.close();
    await handle.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
