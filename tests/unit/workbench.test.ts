import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
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
    terminalCommand({ kind: "claude", phase: "design" })!,
    /'--permission-mode' 'plan'/,
  );
  assert.doesNotMatch(
    terminalCommand({ kind: "claude", phase: "implement" })!,
    /skip-permissions/,
  );
  assert.match(
    terminalCommand({ kind: "claude", phase: "implement" })!,
    /'--permission-mode' 'manual'/,
  );
  assert.throws(() => terminalCommand({ kind: "codex", task: "hello\x1b[5~" }));
  assert.throws(() => terminalCommand({ kind: "invalid" } as never));
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
