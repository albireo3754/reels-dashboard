import test from "node:test";
import assert from "node:assert/strict";
import { errorMessage } from "../../src/shared/lib/errors";
import { createBusyRunner } from "../../src/shared/ui/useBusy";

function recorder(withNotice = true) {
  const calls: string[] = [];
  const state = { busy: false, error: "stale error", notice: "stale notice" };
  const runner = createBusyRunner({
    setBusy: (v) => {
      state.busy = v;
      calls.push(`busy:${v}`);
    },
    setError: (v) => {
      state.error = v;
      calls.push(`error:${v}`);
    },
    ...(withNotice
      ? {
          setNotice: (v: string) => {
            state.notice = v;
            calls.push(`notice:${v}`);
          },
        }
      : {}),
  });
  return { calls, state, runner };
}

test("a run while another is in flight returns immediately without running", async () => {
  const { runner, calls } = recorder();
  let release!: () => void;
  let ran = 0;
  const first = runner.run(
    () =>
      new Promise<void>((r) => {
        ran++;
        release = r;
      }),
  );
  await runner.run(async () => {
    ran++;
  });
  assert.equal(ran, 1, "the overlapping run is dropped");
  assert.deepEqual(calls, ["busy:true", "error:", "notice:"]);
  release();
  await first;
  await runner.run(async () => {
    ran++;
  });
  assert.equal(ran, 2);
});

test("start clears error and notice before the op runs; no notice setter is fine", async () => {
  const { runner, state } = recorder();
  await runner.run(async () => {
    assert.deepEqual(state, { busy: true, error: "", notice: "" });
  });
  assert.equal(state.busy, false);
  const bare = recorder(false);
  await bare.runner.run(async () => {});
  assert.deepEqual(bare.calls, ["busy:true", "error:", "busy:false"]);
  assert.equal(bare.state.notice, "stale notice");
});

test("errors are formatted as Error.message or String(value)", async () => {
  assert.equal(errorMessage(new Error("boom")), "boom");
  assert.equal(errorMessage(new TypeError("typed")), "typed");
  assert.equal(errorMessage("plain"), "plain");
  assert.equal(errorMessage(42), "42");
  assert.equal(errorMessage({ code: 1 }), "[object Object]");
  const { runner, state } = recorder();
  await runner.run(async () => {
    throw new Error("save failed");
  });
  assert.equal(state.error, "save failed");
  await runner.run(async () => {
    throw "STALE";
  });
  assert.equal(state.error, "STALE");
});

test("busy and the lock reset after a throw, and run itself never rejects", async () => {
  const { runner, state, calls } = recorder();
  await assert.doesNotReject(
    runner.run(async () => {
      throw new Error("x");
    }),
  );
  assert.equal(state.busy, false);
  assert.deepEqual(calls, ["busy:true", "error:", "notice:", "error:x", "busy:false"]);
  let ran = false;
  await runner.run(async () => {
    ran = true;
  });
  assert.equal(ran, true);
});
