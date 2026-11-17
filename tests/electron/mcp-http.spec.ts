import { test, expect } from "@playwright/test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { launchApp, closeApp, makeProfile, cleanProfile, mcpTransport, mcpUrl } from "./helpers";

// No editor runtime or personal media: the app only has to serve its MCP endpoints.
test("the running app serves Reels and workflow MCP over local HTTP", async () => {
  const profile = await makeProfile();
  const app = await launchApp(profile, false);
  await app.firstWindow();
  const clients: Client[] = [];
  const open = async (url?: string) => {
    const client = new Client({ name: "mcp-http-qa", version: "1" });
    await client.connect(url ? new StreamableHTTPClientTransport(new URL(url)) : mcpTransport(profile));
    clients.push(client);
    return client;
  };
  try {
    await expect
      .poll(() => readFile(path.join(profile, "agent/mcp.json"), "utf8").then(() => true, () => false))
      .toBe(true);
    const published = JSON.parse(await readFile(path.join(profile, "agent/mcp.json"), "utf8"));
    expect(published.url).toBe(mcpUrl(profile));
    expect(published.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const [a, b] = await Promise.all([open(), open()]);
    const tools = (await a.listTools()).tools.map((tool) => tool.name);
    expect(tools).toEqual(expect.arrayContaining(["reels_get_app_state", "reels_list_projects"]));
    const results = await Promise.all(
      [a, b, a, b].map((client) => client.callTool({ name: "reels_list_projects", arguments: {} })),
    );
    for (const result of results) expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    const workflow = await open(published.workflowUrl);
    const listed = await workflow.callTool({ name: "reels_workflow_list", arguments: {} });
    expect(listed.isError, JSON.stringify(listed.content)).not.toBe(true);
    expect(Array.isArray((listed.structuredContent as any).runs)).toBe(true);
    const forged = await fetch(published.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", origin: "https://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(forged.status).toBe(403);
  } finally {
    await Promise.all(clients.map((client) => client.close().catch(() => {})));
    await closeApp(app);
    await cleanProfile(profile);
  }
});
