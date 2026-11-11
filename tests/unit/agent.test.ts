import test from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConnection } from "node:net";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  createAgentDispatch,
  type AgentPorts,
} from "../../src/features/agent-tools";
import { EditorService } from "../../src/features/reel-editing";
import { validateRequest } from "../../src/desktop/native";
import { AgentSession, patchProject } from "../../src/entities/agent-session";
import {
  defaultEditSettings,
  type EditorProject,
} from "../../src/shared/editor";
import {
  AgentCallError,
  agentRoot,
  callAgent,
  startAgentSocket,
} from "../../src/shared/lib/agent-socket";

const project: EditorProject = {
  schemaVersion: 1,
  id: "11111111-1111-4111-8111-111111111111",
  updatedAt: "2026-10-27T00:00:00.000Z",
  source: {
    id: "source",
    name: "synthetic.mp4",
    duration: 10,
    width: 1080,
    height: 1920,
    hdr: false,
    hasAudio: true,
    videoURL: "reels-media://video/test",
  },
  settings: defaultEditSettings(10),
};
test("agent patches preserve independent overlays, select manual positioning and reject stale/unknown fields", () => {
  const result = patchProject(project, project.updatedAt, {
    place: { x: 0.55, description: "example" },
  });
  assert.deepEqual(result.settings.cover, project.settings.cover);
  assert.deepEqual(result.settings.captions, project.settings.captions);
  assert.equal(result.settings.place.useDefaultPosition, false);
  assert.equal(project.settings.place.x, 0.5);
  const cover = patchProject(project, project.updatedAt, {
    cover: { time: 7.25, hookSize: null },
  });
  assert.equal(cover.settings.cover.time, 7.25);
  assert.deepEqual(cover.settings.place, project.settings.place);
  assert.throws(() => patchProject(project, "old", {}), /STALE_PROJECT/);
  assert.throws(() =>
    patchProject(project, project.updatedAt, {
      place: { arbitrary: true },
    } as never),
  );
  assert.throws(() =>
    patchProject(project, project.updatedAt, {
      captions: { items: [{ id: "x", start: 0, end: 11, text: "outside" }] },
    }),
  );
});
test("agent session protects dirty or busy UI state and validates context", () => {
  const session = new AgentSession();
  session.update({
    projectId: project.id,
    dirty: true,
    time: 1,
    active: true,
    busy: false,
  });
  assert.throws(() => session.assertWritable(project.id), /EDITOR_BUSY/);
  assert.throws(() => session.assertWritable(), /EDITOR_BUSY/);
  session.assertWritable("another-project");
  assert.throws(() =>
    session.update({
      projectId: project.id,
      dirty: false,
      time: -1,
      active: true,
      busy: false,
    }),
  );
});
test("private socket authenticates, returns errors, cleans up and reconnects after app restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reels-agent-unit-"));
  let calls = 0;
  let close = await startAgentSocket(root, async (name, args) => {
    calls++;
    if (name === "fail") throw new Error("expected failure");
    return args;
  });
  try {
    const file = path.join(root, "agent/connection.json");
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const connection = JSON.parse(await readFile(file, "utf8"));
    const denial = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(connection.socket);
      socket.on("error", reject);
      socket.on("connect", () =>
        socket.write(
          JSON.stringify({ version: 1, name: "read", token: "bad", args: {} }) +
            "\n",
        ),
      );
      let response = "";
      socket.on("data", (chunk) => (response += chunk.toString()));
      socket.on("end", () => resolve(response));
    });
    assert.match(denial, /Unauthorized/);
    assert.equal(calls, 0);
    assert.deepEqual(await callAgent(root, "read", { text: "한글" }), {
      text: "한글",
    });
    await assert.rejects(callAgent(root, "fail", {}), /expected failure/);
    await close();
    await assert.rejects(callAgent(root, "read", {}), /APP_OFFLINE/);
    close = await startAgentSocket(root, async () => ({ restarted: true }));
    assert.deepEqual(await callAgent(root, "read", {}), { restarted: true });
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});
test("callAgent separates unsent, uncertain and app-reported failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reels-agent-errors-"));
  const failure = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => assert.fail("expected a rejection"),
      (reason) => reason,
    );
    return error as AgentCallError;
  };
  let close: () => Promise<void> = async () => {};
  try {
    const missing = await failure(callAgent(root, "read", {}));
    assert.equal(missing.code, "APP_OFFLINE");
    assert.equal(missing.requestSent, false);
    assert.equal(missing.reason, "no_connection_file");
    assert.match(missing.message, /^APP_OFFLINE: /);

    const file = path.join(root, "agent/connection.json");
    await mkdir(path.dirname(file), { mode: 0o700 });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        socket: path.join(root, "dead.sock"),
        token: "a".repeat(64),
        pid: 1,
      }),
      { mode: 0o600 },
    );
    const stale = await failure(callAgent(root, "read", {}));
    assert.equal(stale.reason, "stale_connection");
    assert.equal(stale.requestSent, false);
    await chmod(file, 0o644);
    assert.equal(
      (await failure(callAgent(root, "read", {}))).reason,
      "unsafe_connection_file",
    );
    await rm(file);

    let calls = 0;
    let dropped: Promise<void> | undefined;
    close = await startAgentSocket(root, async (name) => {
      calls++;
      if (name === "coded")
        throw Object.assign(new Error("메시지"), { code: "EDITOR_BUSY" });
      if (name === "drop") dropped = close();
      return new Promise(() => {});
    });
    const coded = await failure(callAgent(root, "coded", {}));
    assert.equal(coded.code, "EDITOR_BUSY");
    assert.equal(coded.message, "메시지");

    const timedOut = await failure(
      callAgent(root, "hang", {}, { timeoutMs: 50 }),
    );
    assert.equal(timedOut.code, "REQUEST_TIMEOUT");
    assert.equal(timedOut.requestSent, true);
    assert.match(timedOut.message, /자동 재시도하지 마세요/);

    const controller = new AbortController();
    const abort = failure(
      callAgent(root, "hang", {}, { signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 20);
    const aborted = await abort;
    assert.equal(aborted.code, "ABORTED");
    assert.equal(aborted.requestSent, true);

    const before = calls;
    const large = await failure(
      callAgent(root, "read", { text: "x".repeat(2 * 1024 * 1024) }),
    );
    assert.equal(large.code, "REQUEST_TOO_LARGE");
    assert.equal(large.requestSent, false);
    assert.equal(calls, before);

    const lost = await failure(callAgent(root, "drop", {}));
    assert.equal(lost.code, "CONNECTION_LOST");
    assert.equal(lost.requestSent, true);
    await dropped;
  } finally {
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("editor errors gain machine codes and keep their messages", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reels-agent-codes-"));
  try {
    const service = new EditorService({ root, runtime: root } as never);
    await assert.rejects(service.job(project.id), {
      code: "RENDER_JOB_NOT_FOUND",
      message: "내보내기 작업을 찾지 못했어요.",
    });
    await service.dispose();
    await assert.rejects(service.save(project), {
      code: "EDITOR_BUSY",
      message: "진행 중인 편집 작업이 끝난 뒤 다시 시도해주세요.",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("agentRoot resolves the override and falls back to the app folder", () => {
  assert.equal(
    agentRoot({ REELS_USER_DATA: "relative/profile" }),
    path.resolve("relative/profile"),
  );
  assert.match(agentRoot({}), /Reels Dashboard$/);
});

test("real stdio MCP lists typed tools, forwards calls and reports app-offline errors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reels-mcp-unit-"));
  let calls = 0;
  const close = await startAgentSocket(root, async (name) => {
    calls++;
    return { name, connected: true };
  });
  const client = new Client({ name: "reels-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/app/mcp/main.ts"],
    cwd: process.cwd(),
    env: { ...(process.env as Record<string, string>), REELS_USER_DATA: root },
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const list = await client.listTools();
    assert.ok(list.tools.some((t) => t.name === "reels_update_project"));
    assert.ok(!list.tools.some((t) => /delete|shell|move_apply/.test(t.name)));
    const result = await client.callTool({
      name: "reels_get_app_state",
      arguments: {},
    });
    assert.equal(result.isError, undefined);
    assert.equal((result.structuredContent as any)?.connected, true);
    assert.equal(calls, 1);
    try {
      const invalid = await client.callTool({
        name: "reels_get_project",
        arguments: { projectId: "../../etc/passwd" },
      });
      assert.equal(invalid.isError, true);
    } catch (error) {
      assert.match(String(error), /valid|uuid|Invalid/i);
    }
    assert.equal(calls, 1);
    await close();
    const offline = await client.callTool({
      name: "reels_get_app_state",
      arguments: {},
    });
    assert.equal(offline.isError, true);
    assert.match(JSON.stringify(offline.content), /APP_OFFLINE/);
  } finally {
    await client.close();
    await transport.close();
    await close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Photos tools preserve required native evidence arguments and do not expose arbitrary native commands", async () => {
  const calls: { method: string; args: Record<string, string> }[] = [];
  const dispatch = createAgentDispatch({
    session: new AgentSession(),
    photos: async (method, args) => {
      validateRequest(method, args);
      calls.push({ method, args });
      return { ok: true };
    },
  } as AgentPorts);
  await dispatch("reels_photos_inspect", {
    groupId: "group",
    indexRunId: "run",
    page: 2,
    pageSize: 10,
  });
  assert.deepEqual(calls[0], {
    method: "groups.inspect",
    args: {
      id: "group",
      "index-run": "run",
      page: "2",
      "page-size": "10",
      samples: "10",
    },
  });
  await assert.rejects(
    dispatch("reels_photos_inspect", {
      groupId: "group",
      indexRunId: "run",
      page: 1,
      pageSize: 11,
    }),
  );
  await assert.rejects(dispatch("move.apply", {}), /UNKNOWN_TOOL/);
  await assert.rejects(
    dispatch("reels_photos_group", {
      groupId: "group",
      indexRunId: "run",
      output: "/untrusted",
    }),
  );
  assert.equal(calls.length, 1);
});

test("Photos location and OCR search validate inputs and preserve pagination", async () => {
  const calls: { method: string; args: Record<string, string> }[] = [];
  const dispatch = createAgentDispatch({
    session: new AgentSession(),
    photos: async (method, args) => {
      validateRequest(method, args);
      calls.push({ method, args });
      return { searchId: "search_test" };
    },
  } as AgentPorts);
  await dispatch("reels_photos_search", {
    text: "태백관",
    location: { latitude: 35.2, longitude: 129.08, radiusMeters: 300 },
    startDate: "2026-01-01",
  });
  assert.deepEqual(calls[0], {
    method: "photos.search",
    args: {
      text: "태백관",
      latitude: "35.2",
      longitude: "129.08",
      "radius-meters": "300",
      "start-date": "2026-01-01",
      "page-size": "5",
    },
  });
  const terminal = await dispatch("reels_photos_search_page", {
    searchId: "search_test",
    offset: 5,
    pageSize: 10,
  });
  assert.equal((terminal as any).nextOffset, null);
  assert.equal(calls[1].args.offset, "5");
  for (const args of [
    {},
    { text: " " },
    { location: { latitude: 91, longitude: 0, radiusMeters: 100 } },
    { text: "x", pageSize: 11 },
    { text: "x", shell: "ls" },
  ]) {
    await assert.rejects(dispatch("reels_photos_search", args));
  }
  assert.equal(calls.length, 2);
});
