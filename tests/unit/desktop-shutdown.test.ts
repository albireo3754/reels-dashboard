import assert from "node:assert/strict";
import { test } from "node:test";
import { liveWindow, ShutdownSequence } from "../../src/desktop/shutdown";

// Mirrors the main-process before-quit handler: Electron proceeds with a quit only
// when preventDefault was not called.
function app(shutdown: ShutdownSequence, cleanup: (quit: () => boolean) => Promise<void>) {
  const log: string[] = [];
  const quit = (): boolean => {
    let prevented = false;
    const event = { preventDefault: () => (prevented = true) };
    if (shutdown.mayQuit()) {
      log.push("exit");
      return true;
    }
    event.preventDefault();
    if (shutdown.started) {
      log.push("held");
      return !prevented;
    }
    if (shutdown.busy) {
      log.push("busy");
      return !prevented;
    }
    void shutdown.run(() => cleanup(quit), () => quit());
    return !prevented;
  };
  return { quit, log };
}

test("a quit fired during cleanup (window-all-closed) is held until cleanup finishes", async () => {
  const shutdown = new ShutdownSequence();
  const steps: string[] = [];
  const { quit, log } = app(shutdown, async (again) => {
    steps.push("editor+canonical disposed");
    // Destroying the last canonical-editor window -> window-all-closed -> app.quit().
    assert.equal(again(), false, "nested quit must be prevented");
    await new Promise((resolve) => setTimeout(resolve, 5));
    steps.push("workflow server disposed");
    steps.push("agent+native disposed");
  });
  assert.equal(quit(), false, "first quit is prevented to run cleanup");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(steps, ["editor+canonical disposed", "workflow server disposed", "agent+native disposed"]);
  assert.deepEqual(log, ["held", "exit"], "only the final quit after cleanup exits");
  assert.equal(shutdown.mayQuit(), true);
});

test("cleanup failure still ends in the final quit, and run() is one-shot", async () => {
  const shutdown = new ShutdownSequence();
  let quits = 0;
  let cleanups = 0;
  const original = console.error;
  console.error = () => {};
  try {
    const first = shutdown.run(async () => {
      cleanups++;
      throw new Error("boom");
    }, () => quits++);
    const second = shutdown.run(async () => {
      cleanups++;
    }, () => quits++);
    await Promise.all([first, second]);
  } finally {
    console.error = original;
  }
  assert.equal(cleanups, 1);
  assert.equal(quits, 1);
  assert.equal(shutdown.mayQuit(), true);
});

test("dialogs never get a destroyed window as parent", () => {
  const alive = { isDestroyed: () => false };
  const dead = { isDestroyed: () => true };
  assert.equal(liveWindow(alive), alive);
  assert.equal(liveWindow(dead), undefined);
  assert.equal(liveWindow(undefined), undefined);
});

test("an Edits request holds quit/restart and native cleanup until the entire operation settles", async () => {
  const shutdown = new ShutdownSequence();
  const steps: string[] = [];
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  // One high-level request can span several native children and verification polls.
  const edits = { request: async () => { steps.push("export started"); await pending; steps.push("output verified+copied"); } };
  const request = shutdown.track(() => edits.request());
  const { quit, log } = app(shutdown, async () => { steps.push("socket closed"); steps.push("native disposed"); });
  assert.equal(shutdown.busy, true, "shared workBusy guard also blocks relaunch");
  assert.equal(quit(), false);
  await shutdown.run(async () => { steps.push("unexpected cleanup"); }, () => steps.push("unexpected exit"));
  assert.equal(shutdown.started, false);
  assert.deepEqual(steps, ["export started"]);
  finish();
  await request;
  assert.equal(shutdown.busy, false);
  assert.equal(quit(), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(steps, ["export started", "output verified+copied", "socket closed", "native disposed"]);
  assert.deepEqual(log, ["busy", "exit"]);
  let invoked = false;
  await assert.rejects(shutdown.track(async () => { invoked = true; }), /shutting down/);
  assert.equal(invoked, false, "socket requests admitted during cleanup cannot start another child");
});

test("a failed Edits request releases the close/restart guard", async () => {
  const shutdown = new ShutdownSequence();
  let fail!: (error: Error) => void;
  const pending = new Promise<void>((_, reject) => { fail = reject; });
  const request = shutdown.track(() => pending);
  assert.equal(shutdown.busy, true);
  fail(new Error("EDITS_VERIFICATION_FAILED: outcome unknown"));
  await assert.rejects(request, /outcome unknown/);
  assert.equal(shutdown.busy, false);
  let disposed = false;
  await shutdown.run(async () => { disposed = true; }, () => {});
  assert.equal(disposed, true);
});
