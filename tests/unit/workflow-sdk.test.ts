import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CodexOptions, ThreadEvent } from "@openai/codex-sdk";
import {
  CodexExecutor,
  canFallback,
  codexEnvironment,
  type SdkFactory,
} from "../../src/app/workflow/codex-executor";
import { WorkflowRuntime } from "../../src/app/workflow/runtime";

const output = {
  outcome: "done",
  summary: "Prepared fixture facts",
  artifacts: [{ name: "facts.md", content: "Confirmed fixture facts" }],
};
async function* success(result: unknown): AsyncGenerator<ThreadEvent> {
  yield { type: "thread.started", thread_id: "fixture-thread" };
  yield {
    type: "item.completed",
    item: { id: "answer", type: "agent_message", text: JSON.stringify(result) },
  };
  yield {
    type: "turn.completed",
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      reasoning_output_tokens: 0,
    },
  };
}
const factory =
  (
    events: () => AsyncGenerator<ThreadEvent>,
    observed: CodexOptions[] = [],
  ): SdkFactory =>
  (options) => {
    observed.push(options);
    return {
      startThread(settings) {
        assert.equal(settings.sandboxMode, "read-only");
        return {
          async runStreamed() {
            return { events: events() };
          },
        };
      },
    };
  };
async function fixture(sdkFactory: SdkFactory, env: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "sdk-workflow-test-"));
  await writeFile(path.join(root, "source.md"), "fixture source");
  const runtime = await WorkflowRuntime.open(path.join(root, "db"));
  const executor = new CodexExecutor(runtime, root, sdkFactory, env);
  const run = await runtime.create({
    title: "fixture",
    workspace: root,
    trackedFiles: ["source.md"],
    instructions: "Use the synthetic source only",
  });
  return {
    root,
    runtime,
    executor,
    run,
    async close() {
      await executor.close();
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function finished(runtime: WorkflowRuntime, id: string) {
  for (let i = 0; i < 100; i++) {
    const job = runtime.getJob(id);
    if (job.status !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Job did not finish");
}

test("SDK uses saved login without keys, saves new artifacts and advances exactly one stage", async () => {
  const options: CodexOptions[] = [];
  const f = await fixture(factory(() => success(output), options));
  try {
    const job = await f.executor.execute({
      runId: f.run.runId,
      taskId: f.run.task!.taskId,
    });
    const done = await finished(f.runtime, job.id);
    assert.equal(done.status, "completed");
    assert.deepEqual(done.authModes, ["codex-login"]);
    assert.equal(options[0].apiKey, undefined);
    assert.equal(options[0].config?.forced_login_method, "chatgpt");
    assert.equal(options[0].env?.CODEX_LOCAL_CHANNEL_DISABLED, "1");
    const run = await f.runtime.get({ runId: f.run.runId });
    assert.equal(run.stage, "draft");
    assert.equal(run.history.length, 1);
    assert.equal(
      await readFile(path.join(f.root, "source.md"), "utf8"),
      "fixture source",
    );
    assert(run.trackedFiles.some((name) => name.endsWith("/facts.md")));
    assert.equal(run.execution?.id, job.id);
  } finally {
    await f.close();
  }
});

test("future API key is first; only pre-work auth/quota failure falls back to login", async () => {
  const options: CodexOptions[] = [];
  const sdk: SdkFactory = (opts) => {
    options.push(opts);
    return factory(async function* () {
      if (opts.apiKey)
        yield {
          type: "turn.failed",
          error: { message: "429 insufficient_quota" },
        };
      else yield* success(output);
    })(opts);
  };
  const f = await fixture(sdk, {
    OPENAI_API_KEY: "synthetic-secret",
    CODEX_THREAD_ID: "parent",
    HOME: tmpdir(),
  });
  try {
    const job = await f.executor.execute({
      runId: f.run.runId,
      taskId: f.run.task!.taskId,
    });
    const done = await finished(f.runtime, job.id);
    assert.equal(done.status, "completed");
    assert.deepEqual(done.authModes, ["api-key", "codex-login"]);
    assert.equal(options[0].apiKey, "synthetic-secret");
    assert.equal(options[1].apiKey, undefined);
    assert(!JSON.stringify(done).includes("synthetic-secret"));
    assert(!("OPENAI_API_KEY" in options[1].env!));
    assert(!("CODEX_THREAD_ID" in options[1].env!));
    assert.equal(canFallback("429", true), false);
    assert.equal(canFallback("permission denied", false), false);
    assert.equal(canFallback("network timeout", false), false);
    assert.deepEqual(
      codexEnvironment({
        HOME: "/fixture",
        CODEX_API_KEY: "hidden",
        CODEX_ACCESS_TOKEN: "hidden",
        OPENAI_API_KEY: "hidden",
      }),
      { HOME: "/fixture", CODEX_LOCAL_CHANNEL_DISABLED: "1" },
    );
  } finally {
    await f.close();
  }
});

test("SDK lock prevents simultaneous execution, manual submission and restart; cancellation leaves task pending", async () => {
  const sdk: SdkFactory = () => ({
    startThread: () => ({
      runStreamed: async (_prompt, { signal }) => ({
        events: (async function* () {
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
          yield* success(output);
        })(),
      }),
    }),
  });
  const f = await fixture(sdk);
  try {
    const input = { runId: f.run.runId, taskId: f.run.task!.taskId };
    const job = await f.executor.execute(input);
    await assert.rejects(f.executor.execute(input), /SDK_BUSY/);
    await assert.rejects(f.runtime.restart({ runId: input.runId }), /SDK_BUSY/);
    await assert.rejects(
      f.runtime.submit({ ...input, outcome: "blocked", summary: "manual" }),
      /SDK_BUSY/,
    );
    const stopped = await f.executor.stop(job.id);
    assert.equal(stopped.status, "cancelled");
    const run = await f.runtime.get({ runId: input.runId });
    assert.equal(run.task!.taskId, input.taskId);
  } finally {
    await f.close();
  }
});

test("SDK source changes never advance the graph", async () => {
  let workspace = "";
  const f = await fixture(
    factory(async function* () {
      await writeFile(path.join(workspace, "source.md"), "user correction");
      yield* success(output);
    }),
  );
  workspace = f.root;
  try {
    const job = await f.executor.execute({
      runId: f.run.runId,
      taskId: f.run.task!.taskId,
    });
    const done = await finished(f.runtime, job.id);
    assert.equal(done.status, "failed");
    assert.match(done.error!, /STALE_INPUT/);
    assert.equal(
      (await f.runtime.get({ runId: f.run.runId })).history.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("bundle SDK shares authentication/execution but returns review suggestions without changing source", async () => {
  const requestId = crypto.randomUUID();
  const result = {
    schemaVersion: 1,
    kind: "blog.bundle-review.result",
    requestId,
    reviews: [
      {
        bundleId: "bundle:p1",
        verdict: "pass",
        summary: "Fixture text is coherent",
        findings: [],
      },
    ],
  };
  const f = await fixture(
    factory(() => success({ resultJson: JSON.stringify(result) })),
  );
  try {
    const job = await f.executor.reviewBundles({
      request: {
        schemaVersion: 1,
        kind: "blog.bundle-review.request",
        requestId,
        projectId: "fixture",
        scope: "selected",
        bundleIds: ["bundle:p1"],
        draft: {
          projectId: "fixture",
          revision: 0,
          blocks: [{ id: "p1", type: "text", text: "잠시 쉬었어요." }],
        },
        bundles: [],
      },
    });
    const done = await finished(f.runtime, job.id);
    assert.equal(done.status, "completed");
    assert.deepEqual(done.result, result);
    assert.equal(
      (await f.runtime.get({ runId: f.run.runId })).history.length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("failure after a tool, malformed results and permission errors do not trigger another authentication attempt", async () => {
  for (const mode of ["tool", "invalid", "permission"] as const) {
    const observed: CodexOptions[] = [];
    const f = await fixture(
      factory(async function* () {
        if (mode === "tool") {
          yield {
            type: "item.started",
            item: {
              id: "command",
              type: "command_execution",
              command: "read synthetic source",
              aggregated_output: "",
              status: "in_progress",
            },
          };
          yield {
            type: "turn.failed",
            error: { message: "429 synthetic-secret" },
          };
        } else if (mode === "permission")
          yield {
            type: "turn.failed",
            error: { message: "permission denied synthetic-secret" },
          };
        else yield* success({ invalid: true });
      }, observed),
      { OPENAI_API_KEY: "synthetic-secret" },
    );
    try {
      const job = await f.executor.execute({
        runId: f.run.runId,
        taskId: f.run.task!.taskId,
      });
      const done = await finished(f.runtime, job.id);
      assert.equal(done.status, "failed");
      assert.equal(observed.length, 1);
      assert(!JSON.stringify(done).includes("synthetic-secret"));
      assert.equal(
        (await f.runtime.get({ runId: f.run.runId })).history.length,
        0,
      );
    } finally {
      await f.close();
    }
  }
});

test("unfinished SDK jobs become interrupted after runtime restart, with no automatic rerun", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sdk-recovery-test-"));
  let runtime = await WorkflowRuntime.open(root);
  try {
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    runtime.saveJob({
      id,
      kind: "bundle-review",
      status: "running",
      authModes: ["codex-login"],
      events: [],
      threadIds: [],
      createdAt: now,
      updatedAt: now,
    });
    await runtime.close();
    runtime = await WorkflowRuntime.open(root);
    assert.equal(runtime.getJob(id).status, "interrupted");
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
