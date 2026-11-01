import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  analysisCodexEnvironment,
  analysisCodexSettings,
} from "../../src/desktop/analysis-codex-isolation";

test("analysis subprocess does not inherit parent agent IDs, key env or extra settings", () => {
  const env = analysisCodexEnvironment({
    HOME: "/fixture",
    PATH: "/bin",
    CODEX_HOME: "/fixture/auth",
    CODEX_THREAD_ID: "parent",
    OPENAI_API_KEY: "secret",
    CODEX_API_KEY: "secret",
    UNRELATED_TOKEN: "secret",
    ELECTRON_RUN_AS_NODE: "1",
  });
  assert.equal(env.CODEX_HOME, "/fixture/auth");
  assert.equal(env.CODEX_LOCAL_CHANNEL_DISABLED, "1");
  for (const key of [
    "CODEX_THREAD_ID",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "UNRELATED_TOKEN",
    "ELECTRON_RUN_AS_NODE",
  ])
    assert.equal(env[key], undefined);
  const args = analysisCodexSettings(
    "/fixture/server.cjs",
    "/fixture/batch.json",
    "/fixture/receipt.json",
  );
  assert(args.includes("project_doc_max_bytes=0"));
  assert(args.includes("mcp_servers.reels_analysis.required=true"));
  assert(
    args.includes(
      'mcp_servers.reels_analysis.enabled_tools=["get_analysis_context"]',
    ),
  );
});
test("read-only batch MCP exposes exactly one tool, rejects extra selectors and freezes context", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "reels-context-mcp-test-"));
  const manifest = path.join(dir, "batch.json"),
    receipt = path.join(dir, "read.json");
  const snapshot = {
    context: JSON.stringify({
      projectTitle: "fixture",
      facts: { menus: "confirmed fixture menu" },
    }),
    request: "describe",
    images: [{ id: "one", filename: "one.jpg", kind: "photo", time: null }],
  };
  const bytes = JSON.stringify(snapshot);
  await writeFile(manifest, bytes);
  const client = new Client({ name: "context-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      "src/desktop/analysis-context-mcp.ts",
      manifest,
      receipt,
    ],
    cwd: process.cwd(),
    stderr: "pipe",
  });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ["get_analysis_context"],
    );
    assert.equal(tools[0].annotations?.readOnlyHint, true);
    const invalid = await client.callTool({
      name: "get_analysis_context",
      arguments: { projectId: "other", path: "/etc/passwd" },
    });
    assert.equal(invalid.isError, true);
    await assert.rejects(readFile(receipt));
    // No arbitrary read and no reload of changes after initialization.
    await writeFile(
      manifest,
      JSON.stringify({ ...snapshot, context: "unrelated replacement" }),
    );
    const result = await client.callTool({
      name: "get_analysis_context",
      arguments: {},
    });
    assert.deepEqual(result.structuredContent, snapshot);
    const ack = JSON.parse(await readFile(receipt, "utf8"));
    assert.equal(ack.digest, createHash("sha256").update(bytes).digest("hex"));
    await assert.rejects(client.callTool({name:"reels_start_analysis",arguments:{}}), /not found/);

  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
