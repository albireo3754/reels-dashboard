import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { toolDefinitions } from "../../src/features/agent-tools";
import {
  DEFAULT_MCP_PORT,
  guardedDispatch,
  mcpPort,
  startMcpHttpServer,
} from "../../src/app/mcp/http";
import { KeyedLock, lockedTools, toolLockKey } from "../../src/app/mcp/locks";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Dispatch = (name: string, args: unknown) => Promise<unknown>;
async function withServer(
  dispatch: Dispatch,
  body: (server: Awaited<ReturnType<typeof startMcpHttpServer>>) => Promise<void>,
  workflow = async (action: string, input: unknown) => ({ action, input }),
) {
  const server = await startMcpHttpServer({
    port: 0,
    dispatch,
    workflow: workflow as never,
    timeoutMs: 5_000,
  });
  try {
    await body(server);
  } finally {
    await server.close();
  }
}
async function connect(url: string) {
  const client = new Client({ name: "mcp-http-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}
/** A raw request, because fetch cannot send a forged Host header. */
function raw(
  port: number,
  headers: Record<string, string>,
  pathname = "/mcp",
  body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: pathname, method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

test("initialize and tools/list work over HTTP for both endpoints", async () => {
  await withServer(async () => ({}), async (server) => {
    const reels = await connect(server.url);
    try {
      const { tools } = await reels.listTools();
      assert.deepEqual(
        tools.map((tool) => tool.name).sort(),
        Object.keys(toolDefinitions).sort(),
      );
      assert.ok(!tools.some((tool) => /delete|shell|move_apply/.test(tool.name)));
    } finally {
      await reels.close();
    }
    const workflow = await connect(server.workflowUrl);
    try {
      const { tools } = await workflow.listTools();
      assert.ok(tools.some((tool) => tool.name === "reels_workflow_create"));
      assert.ok(tools.every((tool) => tool.name.startsWith("reels_workflow_") || tool.name.startsWith("reels_form")));
      const result = await workflow.callTool({ name: "reels_workflow_list", arguments: {} });
      assert.deepEqual(result.structuredContent, { action: "list", input: {} });
    } finally {
      await workflow.close();
    }
  });
});

test("tool errors keep the app's message and invalid input is rejected before dispatch", async () => {
  let calls = 0;
  await withServer(
    async () => {
      calls++;
      throw Object.assign(new Error("STALE_PROJECT: 다시 조회해주세요."), { code: "STALE_PROJECT" });
    },
    async (server) => {
      const client = await connect(server.url);
      try {
        const failed = await client.callTool({ name: "reels_get_app_state", arguments: {} });
        assert.equal(failed.isError, true);
        assert.match(JSON.stringify(failed.content), /STALE_PROJECT/);
        const before = calls;
        const invalid = await client.callTool({ name: "reels_get_project", arguments: { projectId: "../../etc/passwd" } }).catch((error) => ({ isError: true, error }));
        assert.equal(invalid.isError, true);
        assert.equal(calls, before);
      } finally {
        await client.close();
      }
    },
  );
});

test("two concurrent clients never see each other's results", async () => {
  await withServer(
    async (name, args) => {
      await sleep((args as { pageSize?: number }).pageSize ? 30 : 5);
      return { name, args };
    },
    async (server) => {
      const [a, b] = await Promise.all([connect(server.url), connect(server.url)]);
      try {
        const rounds = await Promise.all(
          Array.from({ length: 12 }, (_, index) => {
            const client = index % 2 ? a : b;
            const args = { searchId: `search-${index}`, offset: index, pageSize: 1 + (index % 3) };
            return client
              .callTool({ name: "reels_photos_search_page", arguments: args })
              .then((result) => ({ args, result }));
          }),
        );
        for (const { args, result } of rounds)
          assert.deepEqual(result.structuredContent, { name: "reels_photos_search_page", args });
      } finally {
        await Promise.all([a.close(), b.close()]);
      }
    },
  );
});

test("a foreign Host or a browser Origin is refused, loopback names and no Origin pass", async () => {
  await withServer(async () => ({}), async (server) => {
    const ok = await raw(server.port, {});
    assert.equal(ok.status, 200);
    assert.equal((await raw(server.port, { host: `localhost:${server.port}` })).status, 200);
    for (const host of ["evil.example", `evil.example:${server.port}`, "192.168.0.10"]) {
      const response = await raw(server.port, { host });
      assert.equal(response.status, 403, host);
    }
    for (const origin of ["https://evil.example", "http://localhost:9999", "http://127.0.0.1:1", "null"]) {
      const response = await raw(server.port, { origin });
      assert.equal(response.status, 403, origin);
    }
    assert.equal((await raw(server.port, { origin: `http://127.0.0.1:${server.port}` })).status, 200);
    // The workflow endpoint is protected the same way.
    assert.equal((await raw(server.port, { origin: "https://evil.example" }, "/workflow/mcp")).status, 403);
    assert.equal((await raw(server.port, { host: "evil.example" }, "/workflow/mcp")).status, 403);
  });
});

test("other paths, non-JSON bodies and oversized bodies are refused", async () => {
  await withServer(async () => ({}), async (server) => {
    assert.equal((await raw(server.port, {}, "/")).status, 404);
    assert.equal((await raw(server.port, {}, "/api/workflows")).status, 404);
    assert.equal((await raw(server.port, { "content-type": "text/plain" })).status, 415);
    assert.equal((await raw(server.port, {}, "/mcp", "x".repeat(2 * 1024 * 1024 + 1))).status, 413);
  });
});

test("the server binds loopback only and closing releases the port", async () => {
  const server = await startMcpHttpServer({ port: 0, dispatch: async () => ({}), workflow: async () => ({}) });
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  await server.close();
  await assert.rejects(() => fetch(server.url, { method: "POST" }));
});

test("REELS_MCP_PORT overrides the default, 0 is ephemeral and junk falls back", () => {
  assert.equal(mcpPort({}), DEFAULT_MCP_PORT);
  assert.equal(mcpPort({ REELS_MCP_PORT: "5123" }), 5123);
  assert.equal(mcpPort({ REELS_MCP_PORT: "0" }), 0);
  for (const junk of ["abc", "-1", "70000", "1.5"])
    assert.equal(mcpPort({ REELS_MCP_PORT: junk }), DEFAULT_MCP_PORT);
});

test("locked tools run one at a time, in order; other tools and other locks stay parallel", async () => {
  let active = 0, peak = 0;
  const order: string[] = [];
  const dispatch: Dispatch = async (name, args) => {
    const id = (args as { date?: string }).date ?? name;
    order.push(`start ${id}`);
    active++;
    peak = Math.max(peak, active);
    await sleep(25);
    active--;
    order.push(`end ${id}`);
    return { id };
  };
  await withServer(dispatch, async (server) => {
    const clients = await Promise.all([connect(server.url), connect(server.url), connect(server.url)]);
    try {
      assert.equal(toolLockKey("reels_photos_index"), "photos-index");
      const results = await Promise.all(
        clients.map((client, index) =>
          client.callTool({ name: "reels_photos_index", arguments: { date: `2026-11-0${index + 1}` } }),
        ),
      );
      assert.equal(peak, 1, "reels_photos_index overlapped");
      assert.deepEqual(
        order.filter((line) => line.startsWith("end")).length,
        3,
      );
      for (let i = 0; i < order.length; i += 2)
        assert.equal(order[i].replace("start ", ""), order[i + 1].replace("end ", ""));
      assert.equal(results.every((r) => !r.isError), true);

      peak = 0;
      active = 0;
      await Promise.all(
        clients.map((client) => client.callTool({ name: "reels_get_app_state", arguments: {} })),
      );
      assert.equal(peak, 3, "an unlocked read was serialized");
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  });
});

test("guardedDispatch queues per lock key, releases after a failure and times out", async () => {
  let active = 0, peak = 0;
  const dispatch: Dispatch = async (name, args) => {
    active++;
    peak = Math.max(peak, active);
    await sleep(15);
    active--;
    if ((args as { fail?: boolean })?.fail) throw new Error("boom");
    return { name };
  };
  const call = guardedDispatch(dispatch, { locks: new KeyedLock() });
  const results = await Promise.allSettled([
    call("reels_import_video", { fail: true }),
    call("reels_update_project", {}),
    call("reels_start_render", {}),
  ]);
  assert.equal(peak, 1, "all editor tools share one lock");
  assert.deepEqual(results.map((r) => r.status), ["rejected", "fulfilled", "fulfilled"]);
  // Different keys do not block each other.
  peak = 0;
  await Promise.all([call("reels_photos_index", {}), call("reels_start_analysis", {}), call("reels_import_video", {})]);
  assert.equal(peak, 3);

  const slow = guardedDispatch(async () => sleep(200), { timeoutMs: 20 });
  await assert.rejects(slow("reels_get_app_state", {}), { code: "REQUEST_TIMEOUT" });
  const huge = guardedDispatch(async () => "x".repeat(65 * 1024 * 1024));
  await assert.rejects(huge("reels_get_app_state", {}), /too large/);
  const empty = guardedDispatch(async () => { throw new Error(""); });
  await assert.rejects(empty("reels_get_app_state", {}), /오류 내용을 알려주지/);
});

test("every locked tool is a real tool and reads are never locked", () => {
  for (const name of lockedTools) {
    assert.ok(Object.hasOwn(toolDefinitions, name), name);
    assert.equal((toolDefinitions as Record<string, { readOnly: boolean }>)[name].readOnly, false, name);
  }
  assert.equal(toolLockKey("reels_get_project"), undefined);
  assert.equal(toolLockKey("toString"), undefined);
});
