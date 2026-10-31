import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import type { IPty, spawn } from "node-pty";
import {
  terminalCommand,
  validateWorkspace,
  Workbench,
} from "../../src/desktop/workbench";
import { workPrompt } from "../../src/shared/workbench";

test("agent launch quotes untrusted task text as one argument and retains approvals", () => {
  const task = "따옴표 ' $HOME $(touch /tmp/should-not-run) `id`\n다음 줄";
  const command = terminalCommand({ kind: "codex", phase: "review", task })!;
  // Replace exec with a shell function to inspect arguments without invoking an agent.
  const actual = execFileSync("/bin/zsh", [
    "-c",
    `function capture() { printf '%s\\0' "$@"; }; ${command.replace(/^exec /, "capture ")}`,
  ])
    .toString()
    .split("\0")
    .slice(0, -1);
  assert.deepEqual(actual, [
    "codex",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "on-request",
    workPrompt("review", task),
  ]);
  assert.match(
    terminalCommand({ kind: "codex", phase: "implement" })!,
    /'--sandbox' 'workspace-write'/,
  );
  assert.throws(() => terminalCommand({ kind: "codex", task: "hello\x1b[5~" }));
  assert.throws(() => terminalCommand({ kind: "invalid" } as never));
});

test("host advertises Codex by default and rejects a disabled provider before launch", async () => {
  const manager = new Workbench("/does-not-exist", () => {});
  assert.deepEqual(manager.state().providers, [
    { id: "codex", label: "Codex" },
  ]);
  assert.equal(manager.state().defaultProvider, "codex");
  // A caller cannot bypass the UI's available choices through the bridge.
  assert.throws(
    () => terminalCommand({ kind: "claude" }),
    /아직 사용할 수 없는/,
  );
  await assert.rejects(
    manager.start({ kind: "claude" }),
    /아직 사용할 수 없는/,
  );
  assert.equal(manager.state().sessions.length, 0);
  const state = manager.state();
  state.providers[0].label = "changed";
  assert.equal(manager.state().providers[0].label, "Codex");
  assert.equal(terminalCommand({ kind: "shell" }), null);
  assert.match(terminalCommand({ kind: "preview" })!, /npm run dev/);
  assert.match(terminalCommand({ kind: "checks" })!, /npm run typecheck/);
  manager.dispose();
});

test("workspace validation and settings persistence do not depend on app install location", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reels-workbench-"));
  try {
    const repo = path.join(root, "한글 repo's");
    await mkdir(repo);
    await writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({
        name: "reels-dashboard",
        scripts: { dev: "vite", typecheck: "tsc" },
      }),
    );
    const manager = new Workbench(path.join(root, "state"), () => {});
    await manager.initialize("/does-not-exist");
    assert.equal(manager.state().workspace, null);
    await assert.rejects(manager.start({ kind: "shell" }));
    await manager.chooseWorkspace(repo);
    const restored = new Workbench(path.join(root, "state"), () => {});
    await restored.initialize();
    assert.equal(restored.state().workspace, await validateWorkspace(repo));
    await assert.rejects(validateWorkspace(root));
    assert.throws(() => restored.snapshot("invalid"));
    assert.throws(() => restored.resize("invalid", Infinity, -1));
    manager.dispose();
    restored.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("closing a tab waits for exit, deduplicates requests and preserves failures", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reels-close-test-"));
  const exitListeners = new Set<(event: { exitCode: number }) => void>();
  let killCount = 0;
  let failKill = false;
  const pty = {
    onData: () => ({ dispose() {} }),
    onExit: (listener: (event: { exitCode: number }) => void) => {
      exitListeners.add(listener);
      return { dispose: () => { exitListeners.delete(listener); } };
    },
    kill: () => {
      killCount++;
      if (failKill) throw new Error("kill failed");
    },
  } as unknown as IPty;
  const emitExit = (exitCode: number) => {
    for (const listener of exitListeners) listener({ exitCode });
  };
  const manager = new Workbench(
    path.join(root, "state"),
    () => {},
    (() => pty) as typeof spawn,
  );
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "reels-dashboard", scripts: { dev: "vite", typecheck: "tsc" },
    }));
    await manager.initialize(root);
    const session = await manager.start({ kind: "shell" });
    const first = manager.close(session.id);
    assert.equal(manager.close(session.id), first);
    assert.equal(killCount, 1);
    assert.equal(manager.state().sessions[0].state, "running");
    emitExit(0);
    await first;
    assert.equal(manager.state().sessions.length, 0);
    await manager.close(session.id);
    assert.equal(killCount, 1);

    // A failed signal does not forget a live terminal or its retry path.
    exitListeners.clear();
    const failed = await manager.start({ kind: "shell" });
    failKill = true;
    await assert.rejects(manager.close(failed.id), /kill failed/);
    assert.equal(manager.state().sessions[0].state, "running");
    assert.equal(exitListeners.size, 1);
    failKill = false;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const timedOut = assert.rejects(manager.close(failed.id), /종료를 확인하지 못했어요/);
    t.mock.timers.tick(5000);
    await timedOut;
    assert.equal(manager.state().sessions[0].state, "running");
    assert.equal(exitListeners.size, 1);
    t.mock.timers.reset();
    const retry = manager.close(failed.id);
    emitExit(9);
    await retry;
    assert.equal(manager.state().sessions.length, 0);

    // Tabs that already exited are removed without sending another signal.
    exitListeners.clear();
    const exited = await manager.start({ kind: "shell" });
    emitExit(7);
    const before = killCount;
    await manager.close(exited.id);
    assert.equal(killCount, before);
    assert.equal(manager.state().sessions.length, 0);
  } finally {
    manager.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
