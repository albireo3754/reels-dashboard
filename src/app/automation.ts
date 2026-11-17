import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAgentDispatch, type AgentPorts } from "../features/agent-tools";
import { startAgentSocket } from "../shared/lib/agent-socket";
import { mcpPort, startMcpHttpServer } from "./mcp/http";
import type { WorkflowCall } from "./workflow/mcp";

export const mcpConnectionFile = (root: string) =>
  path.join(root, "agent", "mcp.json");

/**
 * Connects the app's agent surfaces: the private unix socket (the `reels` CLI) and the
 * local HTTP MCP endpoint, which both run tools through the same in-process dispatch.
 * An HTTP failure (for example the port is taken by another app instance) is reported
 * in `mcp.error` and never stops the app or the socket.
 */
export async function connectAgent(
  root: string,
  ports: AgentPorts,
  workflow: WorkflowCall,
) {
  const dispatch = createAgentDispatch(ports);
  let mcp: { url: string; workflowUrl: string } | { error: string };
  let closeMcp: (() => Promise<void>) | undefined;
  try {
    const server = await startMcpHttpServer({
      port: mcpPort(),
      dispatch,
      workflow,
    });
    closeMcp = server.close;
    mcp = { url: server.url, workflowUrl: server.workflowUrl };
    // Lets tools and tests find an ephemeral (REELS_MCP_PORT=0) endpoint.
    const file = mcpConnectionFile(root);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify({ ...mcp, pid: process.pid }), {
      mode: 0o600,
    });
    await chmod(file, 0o600);
  } catch (error) {
    mcp = { error: error instanceof Error ? error.message : String(error) };
    await closeMcp?.().catch(() => {});
    closeMcp = undefined;
  }
  // After the HTTP endpoint, so a client that waits for the socket file finds MCP up too.
  const closeSocket = await startAgentSocket(root, dispatch).catch(
    async (error) => {
      await closeMcp?.().catch(() => {});
      throw error;
    },
  );
  return {
    mcp,
    close: async () => {
      await closeMcp?.();
      const file = mcpConnectionFile(root);
      const current = await readFile(file, "utf8").catch(() => "");
      if (current.includes(`"pid":${process.pid}`))
        await rm(file, { force: true });
      await closeSocket();
    },
  };
}
