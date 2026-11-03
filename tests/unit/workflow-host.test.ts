import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DesktopWorkflowHost,
  guiCodexEnvironment,
  probeWorkflowServer,
  workflowCapabilitiesCompatible,
  type WorkflowProbe,
  type WorkflowProbeResult,
  type WorkflowServerHandle,
} from "../../src/desktop/workflow-host";
import { startWorkflowServer } from "../../src/app/workflow/server";
import { workflowRequest } from "../../src/app/workflow/client";
import { codexEnvironment } from "../../src/app/workflow/codex-executor";
import {
  NEWER_WORKFLOW_SERVER_MESSAGE,
  STALE_WORKFLOW_SERVER_MESSAGE,
  WORKFLOW_PROTOCOL_VERSION,
  workflowAction,
} from "../../src/shared/workflow";

// Synthetic only: every server here listens on an ephemeral port with a temp data
// dir. Nothing touches 127.0.0.1:4318 or ~/.local/share/reels-dashboard.
const PORT = "45999"; // never bound: probe/start are injected for this port
const fakeHandle = (url: string, closed: string[] = []): WorkflowServerHandle => ({
  url,
  close: async () => {
    closed.push(url);
  },
  runningJobs: () => 0,
});
type ProbeAnswer = WorkflowProbe | WorkflowProbeResult;
function host(
  probe: ProbeAnswer | (() => Promise<ProbeAnswer>),
  start: () => Promise<WorkflowServerHandle>,
  env: NodeJS.ProcessEnv = { REELS_WORKFLOW_PORT: PORT },
  now?: () => number,
  root = "/nonexistent-test-root",
) {
  const calls = { probe: 0, start: 0 };
  const instance = new DesktopWorkflowHost({
    env,
    root,
    webRoot: "/nonexistent-web-root",
    raceProbeDelaysMs: [0, 0, 0],
    sleep: async () => {},
    probe: async () => {
      calls.probe++;
      return typeof probe === "function" ? probe() : probe;
    },
    start: async () => {
      calls.start++;
      return start();
    },
    now,
  });
  return { instance, calls, env };
}

test("no server on the port -> starts embedded and publishes its URL", async () => {
  const { instance, calls, env } = host("none", async () => fakeHandle(`http://127.0.0.1:${PORT}`));
  const status = await instance.start();
  assert.equal(status.state, "embedded");
  assert.equal(env.REELS_WORKFLOW_URL, `http://127.0.0.1:${PORT}`);
  assert.deepEqual(calls, { probe: 1, start: 1 });
});

test("compatible server -> shared, no second server", async () => {
  const { instance, calls } = host("compatible", async () => assert.fail("must not start"));
  assert.deepEqual(await instance.start(), { state: "shared", url: `http://127.0.0.1:${PORT}` });
  assert.equal(calls.start, 0);
});

test("old capabilities -> stale with the restart message, never starts", async () => {
  const { instance, calls } = host("stale", async () => assert.fail("must not start"));
  const status = await instance.start();
  assert.equal(status.state, "stale");
  assert.equal(status.message, STALE_WORKFLOW_SERVER_MESSAGE);
  assert.equal(calls.start, 0);
});

test("start failure -> error with a readable message", async () => {
  const lock = host("none", async () => {
    throw new Error("Workflow data directory already has a running server");
  });
  const status = await lock.instance.start();
  assert.equal(status.state, "error");
  assert.match(status.message!, /같은 데이터 폴더/);
  const other = host("none", async () => {
    throw new Error("boom");
  });
  assert.match((await other.instance.start()).message!, /시작하지 못했어요: boom/);
});

test("REELS_WORKFLOW_URL at launch -> external: no probe, no start, env untouched", async () => {
  const env = { REELS_WORKFLOW_URL: "http://127.0.0.1:45998", REELS_WORKFLOW_PORT: PORT };
  const { instance, calls } = host("none", async () => assert.fail("must not start"), env);
  assert.deepEqual(await instance.start(), { state: "external", url: "http://127.0.0.1:45998" });
  assert.deepEqual(calls, { probe: 0, start: 0 });
  assert.equal(env.REELS_WORKFLOW_URL, "http://127.0.0.1:45998");
});

test("port 0 skips the probe and uses the bound URL", async () => {
  const { instance, calls, env } = host("compatible", async () => fakeHandle("http://127.0.0.1:41234"), {
    REELS_WORKFLOW_PORT: "0",
  });
  assert.equal((await instance.start()).state, "embedded");
  assert.equal(calls.probe, 0);
  assert.equal(env.REELS_WORKFLOW_URL, "http://127.0.0.1:41234");
});

test("shared owner disappears -> adopt once per 5s and retry the refused request", async () => {
  let clock = 0;
  let answer: WorkflowProbe = "compatible";
  const { instance, calls } = host(
    async () => answer,
    async () => fakeHandle(`http://127.0.0.1:${PORT}`),
    { REELS_WORKFLOW_PORT: PORT },
    () => clock,
  );
  await instance.start();
  answer = "none";
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  let attempts = 0;
  const result = await instance.request(async () => {
    if (++attempts === 1) throw refused;
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(instance.status().state, "embedded");
  assert.equal(calls.start, 1);
  // Embedded now: later refusals are not re-adopted, and other errors pass through.
  await assert.rejects(instance.request(async () => { throw refused; }), /fetch failed/);
  clock += 1000;
  assert.equal(await instance.ensure(), false);
  assert.equal(calls.start, 1);
});

test("adoption is rate limited", async () => {
  let clock = 10_000;
  const { instance, calls } = host(
    async () => (calls.probe === 1 ? "compatible" : "none"),
    async () => {
      throw new Error("EADDRINUSE");
    },
    { REELS_WORKFLOW_PORT: PORT },
    () => clock,
  );
  await instance.start();
  assert.equal(await instance.ensure(), false);
  assert.equal(instance.status().state, "shared");
  assert.equal(await instance.ensure(), false);
  assert.equal(calls.start, 1, "second attempt within 5s is skipped");
  clock += 5000;
  await instance.ensure();
  assert.equal(calls.start, 2);
});

test("compatibility requires this protocol version, every action and a data root", () => {
  const current = { protocol: WORKFLOW_PROTOCOL_VERSION, root: "/data" };
  assert.equal(workflowCapabilitiesCompatible({ sdk: true }), false);
  assert.equal(
    workflowCapabilitiesCompatible({ server: { ...current, actions: workflowAction.options.slice(1) } }),
    false,
  );
  assert.equal(
    workflowCapabilitiesCompatible({ server: { ...current, actions: [...workflowAction.options, "future"] } }),
    true,
  );
  // Same action set, older handler code: the protocol version decides.
  assert.equal(workflowCapabilitiesCompatible({ server: { actions: workflowAction.options, root: "/data" } }), false);
  assert.equal(
    workflowCapabilitiesCompatible({
      server: { ...current, protocol: WORKFLOW_PROTOCOL_VERSION - 1, actions: workflowAction.options },
    }),
    false,
  );
  assert.equal(
    workflowCapabilitiesCompatible({ server: { protocol: WORKFLOW_PROTOCOL_VERSION, actions: workflowAction.options } }),
    false,
    "no data root -> cannot prove it uses the same data",
  );
});

test("same actions but another protocol version -> stale (older) or newer message, never shared", async () => {
  const fake = (protocol: number | undefined) =>
    listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sdk: true, server: { protocol, actions: workflowAction.options, root: "/x" } }));
    });
  const older = await fake(WORKFLOW_PROTOCOL_VERSION - 1);
  const missing = await fake(undefined);
  const newer = await fake(WORKFLOW_PROTOCOL_VERSION + 1);
  try {
    assert.deepEqual(await probeWorkflowServer(older.url), { kind: "stale" });
    assert.deepEqual(await probeWorkflowServer(missing.url), { kind: "stale" });
    assert.deepEqual(await probeWorkflowServer(newer.url), { kind: "stale", newer: true });
    const port = new URL(older.url).port;
    const old = new DesktopWorkflowHost({ env: { REELS_WORKFLOW_PORT: port }, root: "/x", webRoot: "/nonexistent-web-root", start: async () => assert.fail("must not start") });
    assert.deepEqual(await old.start(), { state: "stale", url: older.url, message: STALE_WORKFLOW_SERVER_MESSAGE });
    const ahead = new DesktopWorkflowHost({ env: { REELS_WORKFLOW_PORT: new URL(newer.url).port }, root: "/x", webRoot: "/nonexistent-web-root", start: async () => assert.fail("must not start") });
    assert.deepEqual(await ahead.start(), { state: "stale", url: newer.url, message: NEWER_WORKFLOW_SERVER_MESSAGE });
  } finally {
    await Promise.all([older.close(), missing.close(), newer.close()]);
  }
});

test("a compatible server on another data dir -> error naming both dirs; same dir (via symlink) -> shared", async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), "workflow-host-root-"));
  const a = path.join(base, "a");
  const server = await startWorkflowServer({ root: a, port: 0, embedded: true, sdkEnv: { PATH: process.env.PATH } });
  try {
    const port = new URL(server.url).port;
    const make = (root: string) =>
      new DesktopWorkflowHost({ env: { REELS_WORKFLOW_PORT: port }, root, webRoot: "/nonexistent-web-root", start: async () => assert.fail("must not start") });
    const other = await make(path.join(base, "b")).start();
    assert.equal(other.state, "error");
    assert.ok(other.message!.includes(await realpath(a)), other.message);
    assert.ok(other.message!.includes(path.join(await realpath(base), "b")), other.message);
    await symlink(a, path.join(base, "link"));
    assert.deepEqual(await make(path.join(base, "link")).start(), { state: "shared", url: server.url });
    // Injected probes: a reported root that differs from this.root is never shared.
    const injected = host({ kind: "compatible", root: "/elsewhere" }, async () => assert.fail("must not start"), { REELS_WORKFLOW_PORT: PORT }, undefined, a);
    assert.equal((await injected.instance.start()).state, "error");
  } finally {
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});

test("losing a simultaneous start (owner lock or EADDRINUSE) re-probes, shares the winner and can take over later", async () => {
  for (const failure of ["Workflow data directory already has a running server", "listen EADDRINUSE: address already in use"]) {
    let clock = 0;
    const answers: ProbeAnswer[] = ["none", "none", "compatible"];
    let starts = 0;
    const { instance, calls } = host(
      async () => answers.shift() ?? "none",
      async () => {
        if (++starts === 1) throw new Error(failure);
        return fakeHandle(`http://127.0.0.1:${PORT}`);
      },
      { REELS_WORKFLOW_PORT: PORT },
      () => clock,
    );
    assert.deepEqual(await instance.start(), { state: "shared", url: `http://127.0.0.1:${PORT}` }, failure);
    assert.equal(calls.probe, 3, "initial probe + two re-probes");
    // The winner quits: the next refused request takes over the port.
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    let attempts = 0;
    assert.equal(await instance.request(async () => (++attempts === 1 ? Promise.reject(refused) : "ok")), "ok");
    assert.equal(instance.status().state, "embedded");
  }
  // Nobody ever answers: keep the readable error (no endless retry).
  const lost = host("none", async () => {
    throw new Error("Workflow data directory already has a running server");
  });
  const status = await lost.instance.start();
  assert.equal(status.state, "error");
  assert.match(status.message!, /같은 데이터 폴더/);
  assert.equal(lost.calls.probe, 4, "initial probe + three re-probes");
  // Port 0 never re-probes: an ephemeral bind cannot collide with another instance.
  const ephemeral = host("compatible", async () => {
    throw new Error("listen EADDRINUSE");
  }, { REELS_WORKFLOW_PORT: "0" });
  assert.equal((await ephemeral.instance.start()).state, "error");
  assert.equal(ephemeral.calls.probe, 0);
});

test("takeover that loses the race shares the new winner and retries there", async () => {
  let clock = 0;
  const answers: ProbeAnswer[] = ["compatible", "none", "compatible"];
  const { instance, calls } = host(
    async () => answers.shift() ?? "none",
    async () => {
      throw new Error("listen EADDRINUSE");
    },
    { REELS_WORKFLOW_PORT: PORT },
    () => clock,
  );
  await instance.start();
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  let attempts = 0;
  assert.equal(await instance.request(async () => (++attempts === 1 ? Promise.reject(refused) : "ok")), "ok");
  assert.deepEqual(instance.status(), { state: "shared", url: `http://127.0.0.1:${PORT}` });
  assert.equal(calls.start, 1);
});

async function listen(handler: Parameters<typeof createServer>[1]) {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("probe classifies real responses: none, stale, foreign, compatible", async () => {
  const closed = await listen(() => {});
  await closed.close();
  assert.equal((await probeWorkflowServer(closed.url)).kind, "none");
  const old = await listen((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sdk: true, apiKeyConfigured: false }));
  });
  const other = await listen((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html></html>");
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-host-"));
  const real = await startWorkflowServer({ root, port: 0, embedded: true, sdkEnv: { PATH: process.env.PATH } });
  try {
    assert.equal((await probeWorkflowServer(old.url)).kind, "stale");
    assert.equal((await probeWorkflowServer(other.url)).kind, "foreign");
    assert.deepEqual(await probeWorkflowServer(real.url), {
      kind: "compatible",
      root: await realpath(root),
    });
  } finally {
    await Promise.all([old.close(), other.close(), real.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("capabilities report server actions, pid and embedded flag; old routes map to the stale message", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-host-"));
  const standalone = await startWorkflowServer({ root: path.join(root, "a"), port: 0, sdkEnv: { PATH: process.env.PATH } });
  const embedded = await startWorkflowServer({ root: path.join(root, "b"), port: 0, embedded: true, sdkEnv: { PATH: process.env.PATH } });
  const old = await listen((_req, res) => {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unknown workflow action" }));
  });
  try {
    const a = await workflowRequest("capabilities", {}, standalone.url);
    assert.deepEqual(a.server, {
      protocol: WORKFLOW_PROTOCOL_VERSION,
      actions: workflowAction.options,
      root: await realpath(path.join(root, "a")),
      pid: process.pid,
      embedded: false,
    });
    assert.equal(a.sdk, true, "existing fields are kept");
    const b = await workflowRequest("capabilities", {}, embedded.url);
    assert.equal(b.server.embedded, true);
    assert.equal(embedded.runningJobs(), 0);
    await assert.rejects(
      workflowRequest("suggest-inline", {}, old.url),
      (error: Error) => error.message === STALE_WORKFLOW_SERVER_MESSAGE,
    );
  } finally {
    await Promise.all([standalone.close(), embedded.close(), old.close()]);
    await rm(root, { recursive: true, force: true });
  }
});

test("GUI PATH: user bin dirs are prepended and the SDK child resolves codex through them", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "workflow-host-home-"));
  try {
    const bin = path.join(home, ".local/bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "codex"), "#!/bin/sh\necho synthetic-codex\n");
    await chmod(path.join(bin, "codex"), 0o755);
    const env = guiCodexEnvironment({ PATH: "/usr/bin:/bin" }, (dir) => dir === bin, home);
    assert.equal(env.PATH, `${bin}:/usr/bin:/bin`);
    assert.equal(guiCodexEnvironment({ PATH: "/usr/bin", REELS_CODEX_BIN: "/x/codex" }, () => true, home).PATH, "/usr/bin");
    // Same lookup the Codex SDK performs: spawn("codex", args, { env: codexEnvironment(sdkEnv) }).
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn("codex", [], { env: codexEnvironment(env) });
      let text = "";
      child.stdout.on("data", (chunk) => (text += chunk));
      child.on("error", reject);
      child.on("close", () => resolve(text.trim()));
    });
    assert.equal(output, "synthetic-codex");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
