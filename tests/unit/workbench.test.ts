import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import type { IPty, spawn } from "node-pty";
import {
  terminalCommand,
  terminalEnvironment,
  terminalTitle,
  validateWorkspace,
  Workbench,
} from "../../src/desktop/workbench";
import { workPrompt } from "../../src/shared/workbench";
import {
  HerdrCommandError,
  herdrSourceTag,
  parseHerdrLabel,
  type HerdrClient,
  type HerdrPane,
} from "../../src/desktop/herdr";

/** Existing scenarios stay on the direct backend and never reach a real herdr server. */
const DIRECT = {
  env: { REELS_TERMINAL_BACKEND: "direct" },
  herdr: {
    session: "unused",
    detect: async () => ({ installed: false }),
    isServerRunning: async () => false,
    ensure: async () => {
      throw new Error("herdr must not be used");
    },
    find: async () => undefined,
    reopen: async () => undefined,
    close: async () => {},
    list: async () => [],
    attachCommand: () => {
      throw new Error("herdr must not be used");
    },
  } satisfies HerdrClient,
};

test("Finder terminal defaults to UTF-8 without overriding configured locales", () => {
  assert.equal(terminalEnvironment({}).LC_CTYPE, "UTF-8");
  assert.equal(
    terminalEnvironment({ LANG: "", LC_CTYPE: "", LC_ALL: "" }).LC_CTYPE,
    "UTF-8",
  );
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE"] as const) {
    for (const value of ["C", "ko_KR.UTF-8", "en_US.UTF-8"]) {
      const source = {
        [key]: value,
        PATH: "/custom/bin",
        CODEX_HOME: "/private/config",
      };
      const env = terminalEnvironment(source);
      assert.equal(env[key], value);
      assert.equal(env.LC_CTYPE, key === "LC_CTYPE" ? value : undefined);
      assert.equal(env.CODEX_HOME, undefined);
      assert.ok(env.PATH.endsWith(":/custom/bin"));
      assert.equal(env.TERM, "xterm-256color");
      assert.equal(source.CODEX_HOME, "/private/config");
    }
  }
});

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

test("bypass is an explicit per-start choice that never widens read-only phases", () => {
  for (const phase of ["implement", "fix"] as const) {
    assert.equal(
      terminalCommand({ kind: "codex", phase, permission: "bypass" }),
      "exec 'codex' '--dangerously-bypass-approvals-and-sandbox'",
    );
    assert.equal(
      terminalCommand({ kind: "claude", phase, permission: "bypass" }),
      "exec 'claude' '--dangerously-skip-permissions'",
    );
  }
  assert.match(
    terminalCommand({ kind: "codex", permission: "bypass", task: "고쳐줘" })!,
    /^exec 'codex' '--dangerously-bypass-approvals-and-sandbox' '.*고쳐줘.*'$/s,
  );
  for (const phase of ["design", "review"] as const) {
    assert.equal(
      terminalCommand({ kind: "codex", phase, permission: "bypass" }),
      "exec 'codex' '--sandbox' 'read-only' '--ask-for-approval' 'on-request'",
    );
    assert.equal(
      terminalCommand({ kind: "claude", phase, permission: "bypass" }),
      "exec 'claude' '--permission-mode' 'plan'",
    );
  }
  // Omitted and "ask" keep the sandboxed default; unknown values are rejected.
  assert.equal(
    terminalCommand({ kind: "codex", permission: "ask" }),
    terminalCommand({ kind: "codex" }),
  );
  assert.doesNotMatch(terminalCommand({ kind: "codex" })!, /dangerously/);
  assert.throws(() =>
    terminalCommand({ kind: "codex", permission: "yolo" } as never),
  );
});

test("host advertises Codex and Claude Code with Codex as the default and rejects unknown kinds before launch", async () => {
  const manager = new Workbench("/does-not-exist", () => {}, undefined, DIRECT);
  assert.deepEqual(manager.state().providers, [
    { id: "codex", label: "Codex" },
    { id: "claude", label: "Claude Code" },
  ]);
  assert.equal(manager.state().defaultProvider, "codex");
  // Claude Code launches with an explicit permission mode and does not bypass unless asked.
  const claude = (input: Parameters<typeof terminalCommand>[0]) =>
    terminalCommand(input)!;
  assert.equal(claude({ kind: "claude" }), "exec 'claude' '--permission-mode' 'manual'");
  assert.equal(
    claude({ kind: "claude", phase: "design" }),
    "exec 'claude' '--permission-mode' 'plan'",
  );
  assert.equal(
    claude({ kind: "claude", phase: "review" }),
    "exec 'claude' '--permission-mode' 'plan'",
  );
  for (const phase of ["implement", "fix"] as const)
    assert.match(claude({ kind: "claude", phase }), /'--permission-mode' 'manual'$/);
  assert.doesNotMatch(
    claude({ kind: "claude", phase: "implement", task: "x" }),
    /bypass|dangerously/i,
  );
  assert.match(
    claude({ kind: "claude", phase: "implement", task: "고쳐줘" }),
    /'--permission-mode' 'manual' '.*고쳐줘.*'$/s,
  );
  // A caller cannot start a kind the host does not know through the bridge.
  assert.throws(() => terminalCommand({ kind: "gemini" } as never));
  await assert.rejects(manager.start({ kind: "gemini" } as never));
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
    const manager = new Workbench(
      path.join(root, "state"),
      () => {},
      undefined,
      DIRECT,
    );
    await manager.initialize("/does-not-exist");
    assert.equal(manager.state().workspace, null);
    await assert.rejects(manager.start({ kind: "shell" }));
    await manager.chooseWorkspace(repo);
    const restored = new Workbench(
      path.join(root, "state"),
      () => {},
      undefined,
      DIRECT,
    );
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
      return {
        dispose: () => {
          exitListeners.delete(listener);
        },
      };
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
    DIRECT,
  );
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "reels-dashboard",
        scripts: { dev: "vite", typecheck: "tsc" },
      }),
    );
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
    const timedOut = assert.rejects(
      manager.close(failed.id),
      /종료를 확인하지 못했어요/,
    );
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

// ---- herdr session backend ----

type FakePty = {
  file: string;
  args: string[];
  options: { cwd?: string; cols?: number; rows?: number; env?: Record<string, string> };
  killed: number;
  writes: string[];
  sizes: [number, number][];
  emitExit(exitCode: number): void;
  emitData(data: string): void;
};
function fakePtys() {
  const spawned: FakePty[] = [];
  const spawnPty = ((file: string, args: string[], options: FakePty["options"]) => {
    const data = new Set<(d: string) => void>();
    const exit = new Set<(e: { exitCode: number }) => void>();
    const record: FakePty = {
      file,
      args,
      options,
      killed: 0,
      writes: [],
      sizes: [],
      emitExit: (exitCode) => {
        for (const l of [...exit]) l({ exitCode });
      },
      emitData: (d) => {
        for (const l of [...data]) l(d);
      },
    };
    spawned.push(record);
    const listen = <T>(set: Set<T>) => (l: T) => {
      set.add(l);
      return { dispose: () => set.delete(l) };
    };
    return {
      onData: listen(data),
      onExit: listen(exit),
      kill: () => {
        record.killed++;
      },
      write: (d: string) => record.writes.push(d),
      resize: (c: number, r: number) => record.sizes.push([c, r]),
    } as unknown as IPty;
  }) as unknown as typeof spawn;
  return { spawned, spawnPty };
}

const notRunning = () =>
  new HerdrCommandError(["workspace", "list"], '{"error":{"code":"server_not_running"}}');

/** In-memory herdr client. Workspaces survive a stopped server (herdr restores them when it starts). */
function fakeHerdr(options: { installed?: boolean; running?: boolean; session?: string } = {}) {
  let running = options.running ?? true;
  let n = 0;
  const workspaces = new Map<string, { cwd: string; terminalId: string; command?: string | null }>();
  const calls: string[] = [];
  const hooks: {
    detect?: () => Promise<void>;
    ensure?: (label: string) => Promise<void>;
    reopen?: () => Promise<void>;
  } = {};
  const paneOf = (label: string): HerdrPane | undefined => {
    if (!running) throw notRunning();
    const w = workspaces.get(label);
    return w && { pane_id: "p", terminal_id: w.terminalId, cwd: w.cwd };
  };
  const client: HerdrClient = {
    session: options.session ?? "reels-qa-unit",
    detect: async () => {
      calls.push("detect");
      await hooks.detect?.();
      return options.installed === false
        ? { installed: false }
        : { installed: true, version: "0.9.5" };
    },
    isServerRunning: async () => {
      calls.push("isServerRunning");
      return running;
    },
    ensure: async (label, { cwd, command }) => {
      calls.push(`ensure ${label}`);
      running = true;
      if (!workspaces.has(label))
        workspaces.set(label, { cwd, terminalId: `term_${++n}`, command });
      await hooks.ensure?.(label);
      return { pane_id: `w${n}:p1`, terminal_id: workspaces.get(label)!.terminalId };
    },
    find: async (label) => {
      calls.push(`find ${label}`);
      return paneOf(label);
    },
    reopen: async (label) => {
      calls.push(`reopen ${label}`);
      await hooks.reopen?.();
      running = true;
      return paneOf(label);
    },
    close: async (label) => {
      calls.push(`close ${label}`);
      if (!running) throw notRunning();
      workspaces.delete(label);
    },
    list: async () => {
      calls.push("list");
      if (!running) return [];
      return [...workspaces].flatMap(([label, w]) => {
        const parsed = parseHerdrLabel(label);
        return parsed ? [{ label, ...parsed, workspaceId: "w", terminalId: w.terminalId }] : [];
      });
    },
    attachCommand: (terminalId) => ({
      file: "/fake/bin/herdr",
      args: ["--session", "reels-qa-unit", "terminal", "attach", terminalId, "--takeover"],
    }),
  };
  return {
    client,
    calls,
    workspaces,
    hooks,
    stopServer: () => {
      running = false;
    },
  };
}
const labelOf = (kind: string, id: string, repo: string) =>
  `reels-dashboard:${kind}:${id}:${herdrSourceTag(repo)}`;

async function makeRepo(t: { after: (f: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "reels-herdr-wb-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await mkdir(path.join(repo, "sub"), { recursive: true });
  await writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({ name: "reels-dashboard", scripts: { dev: "vite", typecheck: "tsc" } }),
  );
  return { root, repo: await validateWorkspace(repo), state: path.join(root, "state") };
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
const UUIDS = Array.from(
  { length: 16 },
  (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
);

test("herdr is the default backend; shell and agents attach to a workspace while preview and checks stay direct", async (t) => {
  const { repo, state } = await makeRepo(t);
  const herdr = fakeHerdr();
  const ptys = fakePtys();
  const manager = new Workbench(state, () => {}, ptys.spawnPty, { env: {}, herdr: herdr.client });
  await manager.initialize(repo);
  await manager.whenReady();
  assert.deepEqual(manager.state().terminalBackend, {
    selected: "herdr",
    effective: "herdr",
    herdrInstalled: true,
    herdrVersion: "0.9.5",
    session: "reels-qa-unit",
    forcedByEnv: false,
    checking: false,
  });
  const task = "따옴표 ' \" $(touch /tmp/x) `id`\n다음 줄";
  const codex = await manager.start({ kind: "codex", phase: "implement", task });
  assert.equal(codex.backend, "herdr");
  // The label carries the source folder's tag, not just kind and id.
  const label = labelOf("codex", codex.id, repo);
  assert.equal(label.split(":").at(-1), herdrSourceTag(repo));
  assert.equal(
    herdr.workspaces.get(label)!.command,
    terminalCommand({ kind: "codex", phase: "implement", task }),
  );
  assert.equal(herdr.workspaces.get(label)!.cwd, repo);
  assert.equal(ptys.spawned[0].file, "/fake/bin/herdr");
  assert.deepEqual(ptys.spawned[0].args, [
    "--session",
    "reels-qa-unit",
    "terminal",
    "attach",
    "term_1",
    "--takeover",
  ]);
  assert.equal(ptys.spawned[0].options.env!.REELS_TERMINAL_BACKEND, undefined);
  const shell = await manager.start({ kind: "shell" });
  assert.equal(shell.backend, "herdr");
  assert.equal(herdr.workspaces.get(labelOf("shell", shell.id, repo))!.command, null);
  for (const kind of ["preview", "checks"] as const) {
    const s = await manager.start({ kind });
    assert.equal(s.backend, "direct");
    assert.equal(ptys.spawned.at(-1)!.file, "/bin/zsh");
  }
  assert.equal(herdr.workspaces.size, 2);
  // Output and input go through the attach PTY.
  ptys.spawned[0].emitData("hello");
  assert.equal(manager.snapshot(codex.id).output, "hello");
  manager.write(codex.id, "x");
  assert.deepEqual(ptys.spawned[0].writes, ["x"]);
  manager.resize(codex.id, 120, 40);
  assert.deepEqual(ptys.spawned[0].sizes, [[120, 40]]);
  manager.dispose();
});

test("Claude Code runs as a herdr workspace with the same label, command and title rules as Codex", async (t) => {
  const { repo, state } = await makeRepo(t);
  const herdr = fakeHerdr();
  const ptys = fakePtys();
  const manager = new Workbench(state, () => {}, ptys.spawnPty, { env: {}, herdr: herdr.client });
  await manager.initialize(repo);
  await manager.whenReady();
  const task = "따옴표 ' $(touch /tmp/x)\n다음 줄";
  const claude = await manager.start({ kind: "claude", phase: "review", task });
  assert.equal(claude.backend, "herdr");
  assert.equal(claude.title, "Claude Code");
  const label = labelOf("claude", claude.id, repo);
  assert.equal(
    herdr.workspaces.get(label)!.command,
    terminalCommand({ kind: "claude", phase: "review", task }),
  );
  assert.match(herdr.workspaces.get(label)!.command!, /^exec 'claude' '--permission-mode' 'plan' /);
  assert.doesNotMatch(herdr.workspaces.get(label)!.command!, /bypass|dangerously/i);
  manager.dispose();
});

test("tabs of one kind get distinct titles: the base name, then the lowest free number", async (t) => {
  assert.equal(terminalTitle("shell"), "터미널");
  assert.equal(terminalTitle("shell", ["터미널"]), "터미널 2");
  assert.equal(terminalTitle("shell", ["터미널 2"]), "터미널");
  assert.equal(terminalTitle("shell", ["터미널", "터미널 3"]), "터미널 2");
  assert.equal(terminalTitle("codex", ["터미널", "터미널 2"]), "Codex");
  assert.equal(terminalTitle("preview", ["웹 미리보기"]), "웹 미리보기 2");
  const { repo, state } = await makeRepo(t);
  const herdr = fakeHerdr();
  const manager = new Workbench(state, () => {}, fakePtys().spawnPty, { env: {}, herdr: herdr.client });
  await manager.initialize(repo);
  await manager.whenReady();
  const first = await manager.start({ kind: "shell" });
  const second = await manager.start({ kind: "shell" });
  const codex = await manager.start({ kind: "codex" });
  assert.deepEqual([first.title, second.title, codex.title], ["터미널", "터미널 2", "Codex"]);
  assert.deepEqual(
    manager.state().sessions.map((s) => s.title),
    ["터미널", "터미널 2", "Codex"],
  );
  manager.dispose();
});

test("without herdr installed the effective backend falls back to direct", async (t) => {
  const { repo, state } = await makeRepo(t);
  const herdr = fakeHerdr({ installed: false });
  const ptys = fakePtys();
  const manager = new Workbench(state, () => {}, ptys.spawnPty, { env: {}, herdr: herdr.client });
  await manager.initialize(repo);
  await manager.whenReady();
  const backend = manager.state().terminalBackend;
  assert.equal(backend.selected, "herdr");
  assert.equal(backend.effective, "direct");
  assert.equal(backend.herdrInstalled, false);
  assert.equal(backend.herdrVersion, undefined);
  const s = await manager.start({ kind: "codex" });
  assert.equal(s.backend, "direct");
  assert.equal(ptys.spawned[0].file, "/bin/zsh");
  assert.ok(!herdr.calls.some((c) => c.startsWith("ensure") || c === "list"));
  manager.dispose();
});

test("quitting detaches herdr sessions without closing them; closing a tab closes the workspace", async (t) => {
  const { repo, state } = await makeRepo(t);
  const herdr = fakeHerdr();
  const ptys = fakePtys();
  const manager = new Workbench(state, () => {}, ptys.spawnPty, { env: {}, herdr: herdr.client });
  await manager.initialize(repo);
  await manager.whenReady();
  const closed = await manager.start({ kind: "shell" });
  const stopped = await manager.start({ kind: "codex" });
  const kept = await manager.start({ kind: "shell" });
  const direct = await manager.start({ kind: "preview" });

  await manager.close(closed.id);
  assert.ok(herdr.calls.includes(`close ${labelOf("shell", closed.id, repo)}`));
  assert.equal(ptys.spawned[0].killed, 1);
  assert.equal(manager.state().sessions.length, 3);
  // The attach client's own exit afterwards changes nothing.
  ptys.spawned[0].emitExit(1);
  await settle();

  await manager.stop(stopped.id);
  const after = manager.snapshot(stopped.id).session;
  assert.equal(after.state, "exited");
  assert.equal(after.exitCode, undefined);
  assert.ok(!herdr.workspaces.has(labelOf("codex", stopped.id, repo)));
  manager.remove(stopped.id);

  const closes = herdr.calls.filter((c) => c.startsWith("close")).length;
  manager.dispose();
  assert.equal(herdr.calls.filter((c) => c.startsWith("close")).length, closes);
  assert.ok(herdr.workspaces.has(labelOf("shell", kept.id, repo)));
  assert.equal(ptys.spawned[2].killed, 1, "attach PTY is released");
  assert.equal(ptys.spawned[3].killed, 1, "direct process is ended");
  assert.equal(manager.snapshot(kept.id).session.state, "detached");
  assert.equal(manager.snapshot(direct.id).session.backend, "direct");
});

test("an ended attach becomes exited without a workspace, detached with one, and reattach reconnects", async (t) => {
  const { repo, state } = await makeRepo(t);
  const herdr = fakeHerdr();
  const ptys = fakePtys();
  let changes = 0;
  const manager = new Workbench(state, (e) => e.type === "changed" && changes++, ptys.spawnPty, {
    env: {},
    herdr: herdr.client,
  });
  await manager.initialize(repo);
  await manager.whenReady();
  const done = await manager.start({ kind: "codex" });
  const taken = await manager.start({ kind: "shell" });

  // The command finished: herdr closed the workspace, attach exits 1.
  herdr.workspaces.delete(labelOf("codex", done.id, repo));
  ptys.spawned[0].emitExit(1);
  await settle();
  const exited = manager.snapshot(done.id).session;
  assert.equal(exited.state, "exited");
  assert.ok(!("exitCode" in exited));
  await assert.rejects(manager.reattach(done.id), /이미 종료한/);

  // Another client took over: the workspace lives on, no automatic reconnect.
  const before = ptys.spawned.length;
  ptys.spawned[1].emitExit(1);
  await settle();
  assert.equal(manager.snapshot(taken.id).session.state, "detached");
  assert.equal(ptys.spawned.length, before);
  assert.throws(() => manager.write(taken.id, "x"), /다시 연결/);
  assert.throws(() => manager.remove(taken.id), /먼저 종료/);
  manager.resize(taken.id, 90, 25);
  const [again, twice] = await Promise.all([manager.reattach(taken.id), manager.reattach(taken.id)]);
  assert.equal(again.state, "running");
  assert.deepEqual(twice, again);
  assert.equal(ptys.spawned.length, before + 1, "concurrent reattach spawns once");
  assert.equal(ptys.spawned.at(-1)!.options.cols, 90, "reattach uses the last size");
  assert.equal(ptys.spawned.at(-1)!.options.rows, 25);
  ptys.spawned.at(-1)!.emitData("redraw");
  assert.match(manager.snapshot(taken.id).output, /redraw$/);

  // The reattached command ends: the workspace is gone, so the tab is exited.
  herdr.workspaces.delete(labelOf("shell", taken.id, repo));
  ptys.spawned.at(-1)!.emitExit(1);
  await settle();
  assert.equal(manager.snapshot(taken.id).session.state, "exited");
  const third = await manager.start({ kind: "shell" });
  ptys.spawned.at(-1)!.emitExit(1);
  await settle();
  assert.equal(manager.snapshot(third.id).session.state, "detached");
  herdr.workspaces.clear();
  await assert.rejects(manager.reattach(third.id), /이미 종료됐어요/);
  assert.equal(manager.snapshot(third.id).session.state, "exited");

  // A stopped server cannot say the workspace is gone; herdr restores it on start, so the tab is detached.
  const fourth = await manager.start({ kind: "shell" });
  herdr.stopServer();
  ptys.spawned.at(-1)!.emitExit(1);
  await settle();
  assert.equal(manager.snapshot(fourth.id).session.state, "detached");
  // Closing is refused rather than dropping a tab whose workspace would come back.
  await assert.rejects(manager.close(fourth.id), /서버가 꺼져 있어/);
  assert.equal(manager.snapshot(fourth.id).session.state, "detached");
  assert.ok(herdr.workspaces.has(labelOf("shell", fourth.id, repo)));
  // Reattach starts the server, finds the restored workspace and attaches.
  const spawnedBefore = ptys.spawned.length;
  assert.equal((await manager.reattach(fourth.id)).state, "running");
  assert.ok(herdr.calls.includes(`reopen ${labelOf("shell", fourth.id, repo)}`));
  assert.equal(ptys.spawned.length, spawnedBefore + 1);
  await manager.close(fourth.id);
  assert.ok(!herdr.workspaces.has(labelOf("shell", fourth.id, repo)));
  assert.ok(changes > 0);
  const direct = await manager.start({ kind: "preview" });
  await assert.rejects(manager.reattach(direct.id), /herdr 세션만/);
  manager.dispose();
});

test("a reattach that finishes after quit, stop or close does not attach", async (t) => {
  const { repo, state } = await makeRepo(t);
  const herdr = fakeHerdr();
  const ptys = fakePtys();
  const manager = new Workbench(state, () => {}, ptys.spawnPty, { env: {}, herdr: herdr.client });
  await manager.initialize(repo);
  await manager.whenReady();
  const detach = async () => {
    const s = await manager.start({ kind: "shell" });
    ptys.spawned.at(-1)!.emitExit(1);
    await settle();
    assert.equal(manager.snapshot(s.id).session.state, "detached");
    return s;
  };
  let release!: () => void;
  const hold = () => {
    herdr.hooks.reopen = () => new Promise<void>((r) => (release = r));
  };

  // Close wins: the workspace is closed while the reattach is still looking it up.
  const closed = await detach();
  hold();
  const lateAfterClose = manager.reattach(closed.id);
  const closing = manager.stop(closed.id);
  release();
  await closing;
  await assert.rejects(lateAfterClose, /이미 종료한/);
  assert.equal(manager.snapshot(closed.id).session.state, "exited");

  // Quit wins: no attach PTY may be spawned after dispose.
  const quit = await detach();
  hold();
  const spawned = ptys.spawned.length;
  const lateAfterQuit = manager.reattach(quit.id);
  await settle();
  manager.dispose();
  release();
  await assert.rejects(lateAfterQuit, /종료됐어요/);
  assert.equal(ptys.spawned.length, spawned, "no --takeover attach after quit");
  assert.ok(herdr.workspaces.has(labelOf("shell", quit.id, repo)), "the workspace is kept for the next launch");
});

test("a failed ensure closes whatever it may have created under the label and reports the failure", async (t) => {
  const { repo, state } = await makeRepo(t);
  const herdr = fakeHerdr();
  const ptys = fakePtys();
  const manager = new Workbench(state, () => {}, ptys.spawnPty, { env: {}, herdr: herdr.client });
  await manager.initialize(repo);
  await manager.whenReady();
  // The server created the workspace, but the CLI call timed out.
  herdr.hooks.ensure = async () => {
    throw new Error("herdr workspace create 실패: timed out");
  };
  await assert.rejects(manager.start({ kind: "codex" }), /herdr 세션을 시작하지 못했어요\. .*timed out/);
  assert.equal(herdr.workspaces.size, 0);
  const closes = herdr.calls.filter((c) => c.startsWith("close "));
  assert.equal(closes.length, 1);
  assert.match(closes[0], new RegExp(`^close reels-dashboard:codex:[0-9a-f-]{36}:${herdrSourceTag(repo)}$`));
  assert.equal(manager.state().sessions.length, 0);
  assert.equal(ptys.spawned.length, 0);
  // When the cleanup also fails, the error says so.
  const close = herdr.client.close;
  herdr.client.close = async () => {
    throw new Error("close boom");
  };
  await assert.rejects(manager.start({ kind: "shell" }), /정리하지 못했어요\. close boom/);
  herdr.client.close = close;
  manager.dispose();
});

test("initialize returns before herdr is checked; start and backend changes wait for the check", async (t) => {
  const { repo, state } = await makeRepo(t);
  const herdr = fakeHerdr();
  herdr.workspaces.set(labelOf("shell", UUIDS[0], repo), { cwd: repo, terminalId: "term_r" });
  let release!: () => void;
  herdr.hooks.detect = () => new Promise<void>((r) => (release = r));
  const ptys = fakePtys();
  const events: string[] = [];
  const manager = new Workbench(state, (e) => events.push(e.type), ptys.spawnPty, { env: {}, herdr: herdr.client });
  // A hung herdr does not hold initialize (and the window behind it).
  await manager.initialize(repo);
  const early = manager.state().terminalBackend;
  assert.equal(early.checking, true);
  assert.equal(manager.state().workspace, repo);
  assert.equal(manager.state().sessions.length, 0);
  let started: string | undefined;
  const pendingStart = manager.start({ kind: "shell" }).then((s) => (started = s.backend));
  let changed = false;
  const pendingBackend = manager.setTerminalBackend("direct").then(
    () => (changed = true),
    (e: Error) => e.message,
  );
  await settle();
  assert.equal(started, undefined, "start waits for the check");
  assert.equal(changed, false);
  assert.ok(!herdr.calls.some((c) => c.startsWith("ensure")));
  release();
  await manager.whenReady();
  assert.equal(manager.state().terminalBackend.checking, false);
  assert.equal(manager.state().terminalBackend.effective, "herdr");
  assert.ok(events.includes("changed"));
  await pendingStart;
  // The check restored one session and the start went to herdr; the backend change then sees live sessions.
  assert.equal(started, "herdr");
  assert.equal(manager.state().sessions.length, 2);
  assert.ok(manager.state().sessions.some((s) => s.restored));
  assert.match(String(await pendingBackend), /실행 중인 세션/);
  manager.dispose();
});

test("startup restores only this source folder's Reels workspaces, only from a running server, at most 12", async (t) => {
  const { repo, state } = await makeRepo(t);
  const OTHER = "11111111-1111-4111-8111-111111111111";
  const seed = (herdr: ReturnType<typeof fakeHerdr>) => {
    // Not restored: another checkout's tag even with this folder as cwd, the never-shipped 3-segment
    // label, a kind that always runs direct, and a workspace the app does not own.
    herdr.workspaces.set(`reels-dashboard:shell:${UUIDS[15]}:${herdrSourceTag("/other/checkout")}`, { cwd: repo, terminalId: "t" });
    herdr.workspaces.set(`reels-dashboard:shell:${OTHER}`, { cwd: repo, terminalId: "t" });
    herdr.workspaces.set(labelOf("preview", UUIDS[14], repo), { cwd: repo, terminalId: "t" });
    herdr.workspaces.set("someone-else", { cwd: repo, terminalId: "t" });
    UUIDS.slice(0, 14).forEach((id, i) =>
      herdr.workspaces.set(labelOf(i % 2 ? "codex" : "shell", id, repo), {
        // A shell that cd'd out of the folder is still this folder's session.
        cwd: i === 2 ? "/private/tmp" : i === 1 ? path.join(repo, "sub") : repo,
        terminalId: `term_${id}`,
      }),
    );
  };

  // The server is not running: nothing is listed and no server is started.
  const idle = fakeHerdr({ running: false });
  seed(idle);
  const ptysIdle = fakePtys();
  const cold = new Workbench(state, () => {}, ptysIdle.spawnPty, { env: {}, herdr: idle.client });
  await cold.initialize(repo);
  await cold.whenReady();
  assert.equal(cold.state().sessions.length, 0);
  assert.ok(!idle.calls.includes("list"));
  assert.ok(!idle.calls.some((c) => c.startsWith("ensure")));
  cold.dispose();

  // The direct backend never restores.
  const directHerdr = fakeHerdr();
  seed(directHerdr);
  const forced = new Workbench(state, () => {}, fakePtys().spawnPty, {
    env: { REELS_TERMINAL_BACKEND: "direct" },
    herdr: directHerdr.client,
  });
  await forced.initialize(repo);
  await forced.whenReady();
  assert.equal(forced.state().sessions.length, 0);
  assert.ok(!directHerdr.calls.includes("isServerRunning"));
  forced.dispose();

  const herdr = fakeHerdr();
  seed(herdr);
  const ptys = fakePtys();
  const manager = new Workbench(state, () => {}, ptys.spawnPty, { env: {}, herdr: herdr.client });
  await manager.initialize(repo);
  await manager.whenReady();
  const sessions = manager.state().sessions;
  assert.equal(sessions.length, 12);
  assert.deepEqual(
    sessions.map((s) => s.id),
    UUIDS.slice(0, 12),
  );
  assert.ok(sessions.every((s) => s.restored && s.backend === "herdr" && s.state === "running" && s.cwd === repo));
  assert.equal(sessions[1].kind, "codex");
  assert.equal(sessions[1].title, "Codex");
  // Restored tabs of one kind get distinct titles in tab order.
  assert.deepEqual(
    sessions.slice(0, 4).map((s) => s.title),
    ["터미널", "Codex", "터미널 2", "Codex 2"],
  );
  assert.equal(ptys.spawned.length, 12);
  assert.equal(ptys.spawned[0].args[4], `term_${UUIDS[0]}`);
  // Restored tabs fill the limit; the remaining workspaces are left untouched.
  await assert.rejects(manager.start({ kind: "shell" }), /최대 12개/);
  assert.ok(!herdr.calls.some((c) => c.startsWith("close")));
  manager.dispose();
});

test("the backend cannot change while a session runs or is detached, and the choice is saved with the workspace", async (t) => {
  const { repo, state } = await makeRepo(t);
  const herdr = fakeHerdr();
  const ptys = fakePtys();
  const manager = new Workbench(state, () => {}, ptys.spawnPty, { env: {}, herdr: herdr.client });
  await manager.initialize(repo);
  await manager.whenReady();
  const s = await manager.start({ kind: "shell" });
  await assert.rejects(manager.setTerminalBackend("direct"), /실행 중인 세션을 종료한 뒤 터미널 백엔드/);
  ptys.spawned[0].emitExit(1);
  await settle();
  assert.equal(manager.snapshot(s.id).session.state, "detached");
  await assert.rejects(manager.setTerminalBackend("direct"), /실행 중인 세션/);
  await assert.rejects(manager.chooseWorkspace(repo), /실행 중인 세션/);
  await manager.close(s.id);
  await assert.rejects(manager.setTerminalBackend("tmux" as never));
  const next = await manager.setTerminalBackend("direct");
  assert.equal(next.terminalBackend.selected, "direct");
  assert.equal(next.terminalBackend.effective, "direct");
  assert.equal((await manager.start({ kind: "shell" })).backend, "direct");
  // The candidate folder was never chosen explicitly, so it is not pinned by saving the backend.
  assert.deepEqual(JSON.parse(await readFile(path.join(state, "workbench.json"), "utf8")), {
    terminalBackend: "direct",
  });
  manager.dispose();

  const reopened = new Workbench(state, () => {}, fakePtys().spawnPty, { env: {}, herdr: herdr.client });
  await reopened.initialize(repo);
  await reopened.whenReady();
  assert.equal(reopened.state().workspace, repo);
  assert.equal(reopened.state().terminalBackend.selected, "direct");
  reopened.dispose();
});

test("REELS_TERMINAL_BACKEND overrides the saved choice; other values are ignored", async (t) => {
  const { repo, state } = await makeRepo(t);
  await mkdir(state, { recursive: true });
  await writeFile(
    path.join(state, "workbench.json"),
    JSON.stringify({ workspace: repo, terminalBackend: "herdr" }),
  );
  const cases: [Record<string, string>, string, boolean][] = [
    [{ REELS_TERMINAL_BACKEND: "direct" }, "direct", true],
    [{ REELS_TERMINAL_BACKEND: "herdr" }, "herdr", true],
    [{ REELS_TERMINAL_BACKEND: "tmux" }, "herdr", false],
    [{ REELS_TERMINAL_BACKEND: "" }, "herdr", false],
    [{}, "herdr", false],
  ];
  for (const [env, selected, forced] of cases) {
    const manager = new Workbench(state, () => {}, fakePtys().spawnPty, { env, herdr: fakeHerdr({ running: false }).client });
    await manager.initialize();
    await manager.whenReady();
    assert.equal(manager.state().terminalBackend.selected, selected, JSON.stringify(env));
    assert.equal(manager.state().terminalBackend.effective, selected);
    assert.equal(manager.state().terminalBackend.forcedByEnv, forced);
    manager.dispose();
  }
  // The default client takes its session name from REELS_HERDR_SESSION (main process env); "default" only when unset.
  const named = new Workbench(state, () => {}, undefined, { env: { REELS_HERDR_SESSION: "reels-qa-x" } }).state().terminalBackend;
  assert.equal(named.session, "reels-qa-x");
  assert.equal(named.error, undefined);
  assert.equal(new Workbench(state, () => {}, undefined, { env: {} }).state().terminalBackend.session, "default");
  // A malformed name disables herdr for the run and says why; it never becomes the default session.
  for (const bad of ["../bad", "reels qa 1", "x".repeat(65)]) {
    const backend = new Workbench(state, () => {}, undefined, { env: { REELS_HERDR_SESSION: bad } }).state().terminalBackend;
    assert.equal(backend.session, bad.slice(0, 80));
    assert.equal(backend.effective, "direct");
    assert.match(backend.error ?? "", /REELS_HERDR_SESSION/);
  }
  const herdr = fakeHerdr();
  const ptys = fakePtys();
  const disabled = new Workbench(state, () => {}, ptys.spawnPty, {
    env: { REELS_HERDR_SESSION: "../bad" },
    herdr: herdr.client,
  });
  await disabled.initialize();
  await disabled.whenReady();
  const backend = disabled.state().terminalBackend;
  assert.equal(backend.selected, "herdr");
  assert.equal(backend.herdrInstalled, true);
  assert.equal(backend.effective, "direct");
  assert.match(backend.error ?? "", /herdr를 쓰지 않고/);
  assert.equal((await disabled.start({ kind: "shell" })).backend, "direct");
  assert.deepEqual(herdr.calls, ["detect"], "no session call, so no restore and no workspace");
  disabled.dispose();
});

test("an existing workbench.json keeps working and unknown backend values fall back to herdr", async (t) => {
  const { repo, state } = await makeRepo(t);
  await mkdir(state, { recursive: true });
  const file = path.join(state, "workbench.json");
  const open = async (candidate?: string) => {
    const m = new Workbench(state, () => {}, fakePtys().spawnPty, { env: {}, herdr: fakeHerdr({ running: false }).client });
    await m.initialize(candidate);
    await m.whenReady();
    return m;
  };
  await writeFile(file, JSON.stringify({ workspace: repo }));
  let m = await open();
  assert.equal(m.state().workspace, repo);
  assert.equal(m.state().terminalBackend.selected, "herdr");
  // Saving the backend keeps the saved workspace, even a moved one.
  await writeFile(file, JSON.stringify({ workspace: "/moved/checkout" }));
  m = await open();
  assert.equal(m.state().workspace, null);
  await m.setTerminalBackend("direct");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
    workspace: "/moved/checkout",
    terminalBackend: "direct",
  });
  await writeFile(file, JSON.stringify({ workspace: repo, terminalBackend: "tmux" }));
  m = await open();
  assert.equal(m.state().terminalBackend.selected, "herdr");
  assert.equal(m.state().workspace, repo);
  // A file holding only the backend still offers the candidate folder.
  await writeFile(file, JSON.stringify({ terminalBackend: "direct" }));
  m = await open(repo);
  assert.equal(m.state().workspace, repo);
  assert.equal(m.state().terminalBackend.selected, "direct");
  await m.chooseWorkspace(repo);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { workspace: repo, terminalBackend: "direct" });
  // A corrupt file is still an error for the host to report.
  await writeFile(file, "{");
  await assert.rejects(open());
});
