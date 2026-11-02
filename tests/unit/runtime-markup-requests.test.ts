import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CodexExecutor,
  type SdkFactory,
} from "../../src/app/workflow/codex-executor";
import { WorkflowRuntime } from "../../src/app/workflow/runtime";
import type { CodexObservationPort } from "../../src/app/observability/codex-observer";

const source =
  '---\nmarkup: 1\ntitle: example\n---\n<Bundle id="B1" name="label" question="q">\n¶ P1\nFixture paragraph\n</Bundle>\n';
const observer: CodexObservationPort = {
  async begin() {
    return { configOverrides: [], event() {}, async finish() {} };
  },
};
async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "markup-request-race-")),
  );
  const file = path.join(root, "fixture.png");
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1cAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(file, bytes);
  const input = {
    id: randomUUID(),
    source,
    bundleIds: ["B1"],
    visualEvidence: [
      {
        path: file,
        width: 360,
        bundleId: "B1",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sourceFingerprint: "a".repeat(64),
      },
    ],
  };
  const runtime = await WorkflowRuntime.open(path.join(root, "db"));
  let calls = 0;
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const factory: SdkFactory = () => ({
    startThread: () => ({
      async runStreamed(_prompt, { signal }) {
        calls++;
        return {
          events: (async function* () {
            yield {
              type: "thread.started" as const,
              thread_id: "fixture-thread",
            };
            started();
            await new Promise<void>((_resolve, reject) => {
              if (signal.aborted) reject(signal.reason);
              else
                signal.addEventListener("abort", () => reject(signal.reason), {
                  once: true,
                });
            });
          })(),
        };
      },
    }),
  });
  const executor = new CodexExecutor(runtime, root, factory, {}, observer);
  return {
    input,
    runtime,
    executor,
    running,
    calls: () => calls,
    async close() {
      await executor.close();
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("concurrent screenshot review retries reserve one request and keep a quiet SDK turn running", async () => {
  const f = await fixture();
  try {
    const first = f.executor.reviewMarkup(f.input);
    const retries = Array.from({ length: 5 }, () =>
      f.executor.reviewMarkup(f.input),
    );
    await assert.rejects(
      f.executor.reviewMarkup({
        ...f.input,
        guidance: "Different request content",
      }),
      /Request ID reused with different content/,
    );
    const jobs = await Promise.all([first, ...retries]);
    await f.running;
    assert.equal(new Set(jobs.map((job) => job.id)).size, 1);
    assert.equal(f.calls(), 1);
    assert.equal(f.runtime.getJob(f.input.id).status, "running");
    // A retry while the model produces no events must return the same live job.
    assert.equal((await f.executor.reviewMarkup(f.input)).status, "running");
    assert.equal(f.calls(), 1);
    assert.equal((await f.executor.stop(f.input.id)).status, "cancelled");
    assert.equal((await f.executor.reviewMarkup(f.input)).status, "cancelled");
    assert.equal(f.calls(), 1);
  } finally {
    await f.close();
  }
});

test("failed screenshot validation releases the reservation without persisting a phantom job", async () => {
  const f = await fixture();
  try {
    const invalid = {
      ...f.input,
      visualEvidence: [
        { ...f.input.visualEvidence[0], sha256: "0".repeat(64) },
      ],
    };
    const results = await Promise.allSettled([
      f.executor.reviewMarkup(invalid),
      f.executor.reviewMarkup(invalid),
    ]);
    assert(
      results.every(
        (result) =>
          result.status === "rejected" &&
          /hash\/format/.test(String(result.reason)),
      ),
    );
    assert.throws(() => f.runtime.getJob(f.input.id), /Unknown SDK job/);
    assert.equal(f.calls(), 0);
    const job = await f.executor.reviewMarkup(f.input);
    await f.running;
    assert.equal(job.id, f.input.id);
    assert.equal(f.calls(), 1);
  } finally {
    await f.close();
  }
});
