import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, chmod, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  createHerdrClient,
  herdrLabel,
  herdrRunLine,
  herdrSessionName,
  herdrSourceTag,
  HerdrCommandError,
  HERDR_COMMAND_VARIABLE,
  parseHerdrLabel,
  type HerdrRun,
} from "../../src/desktop/herdr";
import { terminalCommand } from "../../src/desktop/workbench";
import { workPrompt } from "../../src/shared/workbench";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ID2 = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SRC = herdrSourceTag("/src");
const notRunning = (args: string[]) =>
  new HerdrCommandError(
    args,
    '{"id":"cli:workspace:list","error":{"code":"server_not_running","message":"no herdr server is running"}}',
  );
const ok = (result: unknown) => JSON.stringify({ id: "cli", result });

/** An in-memory herdr server behind the Run seam. */
function fakeServer(options: { running?: boolean } = {}) {
  let running = options.running ?? true;
  let next = 1;
  const workspaces: { workspace_id: string; label: string; cwd: string }[] = [];
  const calls: string[][] = [];
  const timeouts: number[] = [];
  const hooks: { beforeCreate?: () => Promise<void> } = {};
  const run: HerdrRun = async (args, timeoutMs) => {
    calls.push(args);
    timeouts.push(timeoutMs);
    if (args[0] === "--version") return "herdr 0.9.5";
    assert.equal(args[0], "--session", "every server call names its session");
    const [, , ...rest] = args;
    if (!running) throw notRunning(args);
    const [group, action] = rest;
    if (group === "workspace" && action === "list")
      return ok({
        type: "workspace_list",
        workspaces: workspaces.map(({ workspace_id, label }) => ({
          workspace_id,
          label,
        })),
      });
    if (group === "workspace" && action === "create") {
      await hooks.beforeCreate?.();
      const workspace_id = `w${next++}`;
      const cwd = rest[rest.indexOf("--cwd") + 1];
      const label = rest[rest.indexOf("--label") + 1];
      workspaces.push({ workspace_id, label, cwd });
      return ok({
        type: "workspace_created",
        root_pane: {
          pane_id: `${workspace_id}:p1`,
          terminal_id: `term_${workspace_id}`,
          cwd,
        },
        workspace: { workspace_id, label },
      });
    }
    if (group === "workspace" && action === "close") {
      const index = workspaces.findIndex((w) => w.workspace_id === rest[2]);
      if (index < 0)
        throw new HerdrCommandError(args, '{"error":{"code":"workspace_not_found"}}');
      workspaces.splice(index, 1);
      return ok({ type: "ok" });
    }
    if (group === "pane" && action === "list") {
      const w = workspaces.find((w) => w.workspace_id === rest[3]);
      if (!w)
        throw new HerdrCommandError(args, '{"error":{"code":"workspace_not_found"}}');
      return ok({
        type: "pane_list",
        panes: [
          {
            pane_id: `${w.workspace_id}:p1`,
            terminal_id: `term_${w.workspace_id}`,
            cwd: w.cwd,
          },
        ],
      });
    }
    if (group === "pane" && action === "run") return ok({ type: "ok" });
    throw new Error(`unexpected ${rest.join(" ")}`);
  };
  return {
    run,
    calls,
    timeouts,
    workspaces,
    hooks,
    start: () => {
      running = true;
    },
    stop: () => {
      running = false;
    },
  };
}

const client = (
  server: ReturnType<typeof fakeServer>,
  extra: { startServer?: () => void; sleep?: (ms: number) => Promise<void> } = {},
) =>
  createHerdrClient({
    session: "reels-qa-unit",
    env: {},
    binary: "/fake/herdr",
    run: server.run,
    startServer: extra.startServer ?? (() => {}),
    sleep: extra.sleep ?? (async () => {}),
  });

test("session names and labels accept only the Reels prefix with a known kind, uuid and source tag", () => {
  assert.equal(herdrSessionName(undefined), "default");
  assert.equal(herdrSessionName(""), "default");
  assert.equal(herdrSessionName("reels-qa-1"), "reels-qa-1");
  // A malformed name is rejected, never turned into the user's default session.
  for (const bad of ["../x", "-flag", "a b", "reels qa 1", "reels/qa", "x".repeat(65), "a;b"])
    assert.equal(herdrSessionName(bad), null);
  // The source tag is sha256(realpath) hex, first 12 characters.
  assert.equal(
    herdrSourceTag("/src"),
    execFileSync("/bin/sh", ["-c", "printf %s /src | shasum -a 256"]).toString().slice(0, 12),
  );
  assert.notEqual(herdrSourceTag("/src"), herdrSourceTag("/src2"));
  const label = herdrLabel("codex", ID, SRC);
  assert.equal(label, `reels-dashboard:codex:${ID}:${SRC}`);
  assert.deepEqual(parseHerdrLabel(label), { kind: "codex", id: ID, source: SRC });
  for (const bad of [
    "codex",
    `reels-dashboard:codex:not-a-uuid:${SRC}`,
    `reels-dashboard:bash:${ID}:${SRC}`,
    // The never-shipped 3-segment format is not the app's.
    `reels-dashboard:codex:${ID}`,
    `reels-dashboard:codex:${ID}:${SRC}:x`,
    `reels-dashboard:codex:${ID}:${SRC.toUpperCase()}`,
    `reels-dashboard:codex:${ID}:${SRC.slice(1)}`,
    `reels-dashboard:codex:${ID}:${SRC}0`,
    `other:codex:${ID}:${SRC}`,
    undefined,
    42,
  ])
    assert.equal(parseHerdrLabel(bad), null, String(bad));
});

test("a malformed session name never reaches herdr, so it cannot fall back to the default session", async () => {
  const server = fakeServer();
  let started = 0;
  const herdr = createHerdrClient({
    session: "../bad",
    env: {},
    binary: "/fake/herdr",
    run: server.run,
    startServer: () => {
      started++;
    },
    sleep: async () => {},
  });
  assert.equal(herdr.session, "../bad");
  assert.equal(await herdr.isServerRunning(), false);
  await assert.rejects(herdr.ensure(herdrLabel("shell", ID, SRC), { cwd: "/src" }), /세션 이름이 올바르지/);
  await assert.rejects(herdr.find(herdrLabel("shell", ID, SRC)), /세션 이름이 올바르지/);
  await assert.rejects(herdr.reopen(herdrLabel("shell", ID, SRC)), /세션 이름이 올바르지/);
  await assert.rejects(herdr.close(herdrLabel("shell", ID, SRC)), /세션 이름이 올바르지/);
  await assert.rejects(herdr.list(), /세션 이름이 올바르지/);
  assert.throws(() => herdr.attachCommand("term_1"), /세션 이름이 올바르지/);
  // Only the session-free version check ran.
  assert.deepEqual(await herdr.detect(), { installed: true, version: "0.9.5" });
  assert.deepEqual(server.calls, [["--version"]]);
  assert.equal(started, 0);
});

test("ensure starts a missing server in the background and waits until it answers", async () => {
  const server = fakeServer({ running: false });
  let started = 0;
  let slept = 0;
  const herdr = client(server, {
    startServer: () => {
      started++;
    },
    sleep: async () => {
      // The server answers on the second poll, as measured (about 0.1 s).
      if (++slept === 2) server.start();
    },
  });
  assert.equal(await herdr.isServerRunning(), false);
  // A server that cannot answer cannot say the workspace is gone (a restart restores it).
  await assert.rejects(
    herdr.find(herdrLabel("shell", ID, SRC)),
    (error: HerdrCommandError) => error.code === "server_not_running",
  );
  assert.deepEqual(await herdr.list(), []);
  await assert.rejects(
    herdr.close(herdrLabel("shell", ID, SRC)),
    (error: HerdrCommandError) => error.code === "server_not_running",
  );
  assert.equal(started, 0, "reads and close never start a server");

  const pane = await herdr.ensure(herdrLabel("shell", ID, SRC), { cwd: "/src" });
  assert.equal(started, 1);
  assert.equal(slept, 2);
  assert.equal(pane.terminal_id, "term_w1");
  assert.equal(await herdr.isServerRunning(), true);
  // The existing pane is reused without a second workspace.
  assert.equal(
    (await herdr.ensure(herdrLabel("shell", ID, SRC), { cwd: "/src" })).terminal_id,
    "term_w1",
  );
  assert.equal(server.workspaces.length, 1);
  assert.equal(started, 1);
});

test("reopen starts a stopped server, which restores labelled workspaces, and never creates one", async () => {
  const server = fakeServer();
  let started = 0;
  const herdr = client(server, {
    startServer: () => {
      started++;
      server.start();
    },
  });
  const label = herdrLabel("shell", ID, SRC);
  await herdr.ensure(label, { cwd: "/src" });
  // herdr keeps labelled workspaces across a server restart.
  server.stop();
  assert.equal((await herdr.reopen(label))?.terminal_id, "term_w1");
  assert.equal(started, 1);
  assert.equal(await herdr.reopen(herdrLabel("shell", ID2, SRC)), undefined);
  assert.equal(server.calls.filter((c) => c[3] === "create").length, 1);
  assert.equal(started, 1, "a running server is not started again");
});

test("read-only calls use a short timeout; changes keep the long one", async () => {
  const server = fakeServer();
  const herdr = client(server);
  await herdr.detect();
  await herdr.ensure(herdrLabel("codex", ID, SRC), { cwd: "/src", command: "exec true" });
  await herdr.list();
  await herdr.close(herdrLabel("codex", ID, SRC));
  const timeoutOf = (match: (c: string[]) => boolean) =>
    [...new Set(server.calls.flatMap((c, i) => (match(c) ? [server.timeouts[i]] : [])))];
  const reads = timeoutOf((c) => c[0] === "--version" || c[4] === "list" || c[3] === "list");
  assert.equal(reads.length, 1);
  assert.ok(reads[0] >= 3_000 && reads[0] <= 5_000, `read timeout ${reads[0]}`);
  assert.deepEqual(timeoutOf((c) => ["create", "run", "close"].includes(c[3])), [15_000]);
});

test("a server that never answers fails after the wait limit", async () => {
  const server = fakeServer({ running: false });
  let waited = 0;
  const herdr = client(server, {
    sleep: async (ms) => {
      waited += ms;
    },
  });
  await assert.rejects(
    herdr.ensure(herdrLabel("shell", ID, SRC), { cwd: "/src" }),
    (error: HerdrCommandError) => error.code === "server_not_running",
  );
  assert.equal(waited, 5000);
  assert.equal(server.workspaces.length, 0);
});

test("only workspaces with the Reels label prefix are listed or closed", async () => {
  const server = fakeServer();
  server.workspaces.push(
    { workspace_id: "w90", label: "my-project", cwd: "/src" },
    { workspace_id: "w91", label: "reels-dashboard:shell:broken", cwd: "/src" },
    { workspace_id: "w92", label: `reels-dashboard:codex:${ID2}:${SRC}`, cwd: "/src/sub" },
    { workspace_id: "w93", label: `reels-dashboard:shell:${ID}:${SRC}`, cwd: "/tmp" },
    { workspace_id: "w94", label: `reels-dashboard:shell:${ID}`, cwd: "/src" },
  );
  const herdr = client(server);
  assert.deepEqual(
    (await herdr.list()).map((s) => [s.kind, s.id, s.source, s.workspaceId, s.terminalId]),
    [
      ["codex", ID2, SRC, "w92", "term_w92"],
      ["shell", ID, SRC, "w93", "term_w93"],
    ],
  );
  // No pane list for a workspace the app does not own.
  assert.ok(!server.calls.some((c) => c.includes("w90") || c.includes("w91") || c.includes("w94")));
  await herdr.close(`reels-dashboard:shell:${ID}:${SRC}`);
  assert.deepEqual(
    server.workspaces.map((w) => w.workspace_id),
    ["w90", "w91", "w92", "w94"],
  );
  assert.ok(
    !server.calls.some(
      (c) => c[2] === "workspace" && c[3] === "close" && c[4] !== "w93",
    ),
  );
  assert.deepEqual(herdr.attachCommand("term_w92"), {
    file: "/fake/herdr",
    args: ["--session", "reels-qa-unit", "terminal", "attach", "term_w92", "--takeover"],
  });
});

test("the command travels in env unchanged and runs through a fixed pane line", async () => {
  const server = fakeServer();
  const herdr = client(server);
  const task = "따옴표 ' \" $HOME $(touch /tmp/should-not-run) `id`\n다음 줄";
  const command = terminalCommand({ kind: "codex", phase: "review", task })!;
  await herdr.ensure(herdrLabel("codex", ID, SRC), { cwd: "/src", command });
  const create = server.calls.find((c) => c[3] === "create")!;
  assert.equal(create[create.indexOf("--env") + 1], `${HERDR_COMMAND_VARIABLE}=${command}`);
  assert.deepEqual(create.slice(2), [
    "workspace",
    "create",
    "--cwd",
    "/src",
    "--label",
    herdrLabel("codex", ID, SRC),
    "--no-focus",
    "--env",
    `${HERDR_COMMAND_VARIABLE}=${command}`,
  ]);
  const runLine = server.calls.find((c) => c[3] === "run")!;
  assert.deepEqual(runLine.slice(2), ["pane", "run", "w1:p1", herdrRunLine()]);
  // A shell session has no command and no typed line.
  await herdr.ensure(herdrLabel("shell", ID2, SRC), { cwd: "/src", command: null });
  assert.equal(server.calls.filter((c) => c[3] === "run").length, 1);
  assert.ok(!server.calls.filter((c) => c[3] === "create")[1].includes("--env"));

  // What the pane shell does with that line: arguments survive, and neither the command variable nor
  // agent/runtime variables inherited from the herdr server reach the command. Other variables stay.
  const watched = [
    HERDR_COMMAND_VARIABLE,
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_HOME",
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "NODE_INSPECT_RESUME_ON_START",
    "REELS_HERDR_SESSION",
    "KEEP_ME",
    "HERDR_PANE_ID",
    "TRICKY",
  ];
  const capture = command.replace(
    /^exec /,
    `capture() { printf '%s\\0' "$@"; ${watched
      .map((name) => `printf '${name}=%s\\0' "\${${name}-unset}";`)
      .join(" ")} }; capture `,
  );
  const serverEnv = {
    PATH: "/usr/bin:/bin",
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "s",
    CODEX_HOME: "/x",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_OPTIONS: "--inspect",
    NODE_INSPECT_RESUME_ON_START: "1",
    REELS_HERDR_SESSION: "default",
    KEEP_ME: "kept $HOME 'q'",
    HERDR_PANE_ID: "w1:p1",
    // A value whose second line looks like a variable only adds a harmless `-u` for an unset name.
    TRICKY: "a\nCLAUDE_FAKE;touch /tmp/x=1\nCODEX_Y=2",
  };
  for (const shell of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    const actual = execFileSync(shell, ["-c", herdrRunLine()], {
      env: { ...serverEnv, SHELL: shell, [HERDR_COMMAND_VARIABLE]: capture },
    })
      .toString()
      .split("\0")
      .slice(0, -1);
    assert.deepEqual(
      actual,
      [
        "codex",
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "on-request",
        workPrompt("review", task),
        `${HERDR_COMMAND_VARIABLE}=unset`,
        "CLAUDECODE=unset",
        "CLAUDE_CODE_SESSION_ID=unset",
        "CODEX_HOME=unset",
        "ELECTRON_RUN_AS_NODE=unset",
        "NODE_OPTIONS=unset",
        "NODE_INSPECT_RESUME_ON_START=unset",
        "REELS_HERDR_SESSION=unset",
        "KEEP_ME=kept $HOME 'q'",
        "HERDR_PANE_ID=w1:p1",
        `TRICKY=${serverEnv.TRICKY}`,
      ],
      shell,
    );
  }
});

test("a workspace whose command could not be typed is closed again", async () => {
  const server = fakeServer();
  const run: HerdrRun = async (args, timeoutMs) => {
    if (args[3] === "run") throw new HerdrCommandError(args, "boom");
    return server.run(args, timeoutMs);
  };
  const herdr = createHerdrClient({
    session: "reels-qa-unit",
    env: {},
    binary: "/fake/herdr",
    run,
    startServer: () => {},
    sleep: async () => {},
  });
  await assert.rejects(
    herdr.ensure(herdrLabel("codex", ID, SRC), { cwd: "/src", command: "exec codex" }),
    /boom/,
  );
  assert.equal(server.workspaces.length, 0);
});

test("ensure and close run one at a time in call order", async () => {
  const server = fakeServer();
  const herdr = client(server);
  let release!: () => void;
  server.hooks.beforeCreate = () => new Promise<void>((r) => (release = r));
  const label = herdrLabel("shell", ID, SRC);
  const order: string[] = [];
  const first = herdr.ensure(label, { cwd: "/src" }).then(() => order.push("ensure1"));
  const second = herdr.ensure(label, { cwd: "/src" }).then(() => order.push("ensure2"));
  const closed = herdr.close(label).then(() => order.push("close"));
  await new Promise((r) => setImmediate(r));
  assert.equal(server.calls.filter((c) => c[3] === "create").length, 1);
  assert.equal(order.length, 0, "nothing finishes while the create is pending");
  release();
  await Promise.all([first, second, closed]);
  assert.deepEqual(order, ["ensure1", "ensure2", "close"]);
  // Racing ensures shared one workspace, and the close saw it.
  assert.equal(server.calls.filter((c) => c[3] === "create").length, 1);
  assert.equal(server.workspaces.length, 0);
  // A failure does not block the queue.
  server.hooks.beforeCreate = async () => {
    throw new Error("create failed");
  };
  await assert.rejects(herdr.ensure(label, { cwd: "/src" }), /create failed/);
  server.hooks.beforeCreate = undefined;
  assert.equal((await herdr.ensure(label, { cwd: "/src" })).terminal_id, "term_w2");
});

test("detect reports a missing binary, a failing binary and the version", async () => {
  const missing = createHerdrClient({
    session: "x",
    env: { PATH: "/nonexistent" },
    run: async () => "herdr 0.9.5",
  });
  assert.deepEqual(await missing.detect(), { installed: false });
  const failing = createHerdrClient({
    session: "x",
    env: {},
    binary: "/fake/herdr",
    run: async () => {
      throw new Error("bad binary");
    },
  });
  assert.deepEqual(await failing.detect(), { installed: false });
  const server = fakeServer();
  assert.deepEqual(await client(server).detect(), {
    installed: true,
    version: "0.9.5",
  });
});

test("the default runner finds herdr on PATH, strips HERDR_* and reads stderr error codes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reels-herdr-bin-"));
  try {
    const log = path.join(dir, "log");
    const bin = path.join(dir, "herdr");
    await writeFile(
      bin,
      `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
env | grep '^HERDR_' >> '${log}'
case "$*" in
  --version) echo "herdr 9.8.7";;
  *"workspace list"*)
    if [ -e '${dir}/down' ]; then
      echo '{"id":"cli:workspace:list","error":{"code":"server_not_running","message":"x"}}' >&2; exit 1
    fi
    echo '{"result":{"workspaces":[]}}';;
  *) exit 2;;
esac
`,
    );
    await chmod(bin, 0o755);
    const herdr = createHerdrClient({
      session: "reels-qa-runner",
      env: { PATH: `relative:${dir}:/usr/bin:/bin`, HERDR_SOCKET_PATH: "/elsewhere.sock", HERDR_PANE_ID: "w1:p1" },
      startServer: () => {},
      sleep: async () => {},
    });
    assert.deepEqual(await herdr.detect(), { installed: true, version: "9.8.7" });
    assert.equal(herdr.attachCommand("t").file, bin);
    assert.equal(await herdr.isServerRunning(), true);
    await writeFile(path.join(dir, "down"), "");
    assert.equal(await herdr.isServerRunning(), false);
    assert.deepEqual(await herdr.list(), []);
    const logged = await readFile(log, "utf8");
    assert.ok(!logged.includes("HERDR_"), "HERDR_* never reaches the CLI");
    assert.match(logged, /^--session reels-qa-runner workspace list$/m);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
