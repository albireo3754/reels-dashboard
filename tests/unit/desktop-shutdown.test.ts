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
