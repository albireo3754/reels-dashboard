import {
  createMcpHandler,
  isJsonContentType,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { errorMessage } from "../../shared/lib/errors";
import { editsErrorDetails } from "../../shared/edits";
import {
  agentRequestLimit,
  agentResponseLimit,
  emptyErrorMessage,
  socketTimeoutMs,
} from "../../shared/lib/agent-socket";
import { createWorkflowMcpServer, type WorkflowCall } from "../workflow/mcp";
import { createMcpServer } from "./server";
import { KeyedLock, toolLockKey } from "./locks";

export const DEFAULT_MCP_PORT = 4319;
export const REELS_MCP_PATH = "/mcp";
export const WORKFLOW_MCP_PATH = "/workflow/mcp";

/** `REELS_MCP_PORT`: a port, or 0 for an ephemeral one (tests). Anything else falls back. */
export function mcpPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REELS_MCP_PORT;
  if (raw === undefined || raw === "") return DEFAULT_MCP_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port < 65536
    ? port
    : DEFAULT_MCP_PORT;
}

/** A failure the app reports in the same shape the socket protocol used to carry. */
class AgentToolError extends Error {}

/**
 * Wraps the in-process dispatch with what the unix socket used to enforce: a 180 s limit
 * on the whole call, the response size cap, a non-empty error message and Edits error
 * details only for Edits tools. Locked tools queue first; the wait counts against the
 * deadline, but the lock is only released when the operation really ends.
 */
export function guardedDispatch(
  dispatch: (name: string, args: unknown) => Promise<unknown>,
  options: { locks?: KeyedLock; timeoutMs?: number } = {},
) {
  const locks = options.locks ?? new KeyedLock();
  const timeoutMs = options.timeoutMs ?? socketTimeoutMs;
  return async (name: string, args: unknown): Promise<any> => {
    const key = toolLockKey(name);
    const run = () => dispatch(name, args);
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            Object.assign(
              new Error(
                "REQUEST_TIMEOUT: 작업 결과가 불확실해요. 상태를 조회하고 쓰기 작업을 자동 재시도하지 마세요.",
              ),
              { code: "REQUEST_TIMEOUT" },
            ),
          ),
        timeoutMs,
      );
    });
    try {
      const result = await Promise.race([
        key ? locks.run(key, run) : run(),
        deadline,
      ]);
      if (Buffer.byteLength(JSON.stringify({ result })) > agentResponseLimit)
        throw new Error("Agent response too large");
      return result;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      const details = name.startsWith("reels_edits_")
        ? editsErrorDetails((error as { details?: unknown })?.details)
        : undefined;
      throw Object.assign(
        new AgentToolError(errorMessage(error) || emptyErrorMessage),
        typeof code === "string" ? { code } : {},
        details && Object.keys(details).length ? { details } : {},
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

export interface McpHttpOptions {
  port: number;
  /** Runs one Reels tool inside the app (`createAgentDispatch`). */
  dispatch: (name: string, args: unknown) => Promise<unknown>;
  /** Runs one workflow action against the workflow server the app hosts or shares. */
  workflow: WorkflowCall;
  locks?: KeyedLock;
  timeoutMs?: number;
}

/**
 * Headers in front of the SDK handler: the Host must be a loopback name (DNS rebinding)
 * and a browser Origin must be this very server. Non-browser MCP clients send no Origin.
 */
function reject(request: Request, port: number): Response | undefined {
  const host = hostHeaderValidationResponse(request, [
    ...localhostAllowedHostnames(),
    "127.0.0.1",
  ]);
  if (host) return host;
  const origin = request.headers.get("origin");
  if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin))
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32000, message: "Invalid Origin" }, id: null },
      { status: 403 },
    );
  return undefined;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += bytes.length;
    if (size > limit) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function send(res: ServerResponse, response: Response) {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => (headers[key] = value));
  res.writeHead(response.status, headers);
  if (!response.body) return void res.end();
  const reader = response.body.getReader();
  res.once("close", () => void reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value))
        await new Promise<void>((resolve) => res.once("drain", resolve));
    }
  } catch {
    // The client went away mid-stream.
  }
  res.end();
}

/**
 * The app's MCP endpoint: Reels tools at `/mcp`, workflow tools at `/workflow/mcp`, both
 * stateless streamable HTTP on 127.0.0.1. Each request builds its own server, so clients
 * never share state. A dedicated port, not the workflow server's, because that server may
 * be shared with another process or an external one while these tools need this app.
 */
export async function startMcpHttpServer(options: McpHttpOptions) {
  const locks = options.locks ?? new KeyedLock();
  const call = guardedDispatch(options.dispatch, { locks, timeoutMs: options.timeoutMs });
  const handlerOptions = {
    maxRequestBodySize: agentRequestLimit,
    onerror: (error: Error) => console.warn("[mcp-http]", error.message),
  };
  const handlers: Record<string, McpHttpHandler> = {
    [REELS_MCP_PATH]: createMcpHandler(() => createMcpServer(call), handlerOptions),
    [WORKFLOW_MCP_PATH]: createMcpHandler(
      () => createWorkflowMcpServer(options.workflow),
      handlerOptions,
    ),
  };
  const server = createServer(async (req, res) => {
    const abort = new AbortController();
    res.once("close", () => abort.abort());
    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `127.0.0.1:${port}`}`);
      const handler = Object.hasOwn(handlers, url.pathname) ? handlers[url.pathname] : undefined;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const method = req.method ?? "GET";
      const hasBody = method !== "GET" && method !== "HEAD";
      const body = hasBody ? await readBody(req, agentRequestLimit) : undefined;
      if (body === null)
        return void (await send(res, Response.json({ error: "Request too large" }, { status: 413 })));
      const request = new Request(url, {
        method,
        headers,
        signal: abort.signal,
        ...(body && body.length ? { body: new Uint8Array(body) } : {}),
      });
      const rejected = reject(request, port);
      if (rejected) return void (await send(res, rejected));
      if (!handler) return void (await send(res, Response.json({ error: "Not found" }, { status: 404 })));
      if (method === "POST" && !isJsonContentType(headers.get("content-type") ?? ""))
        return void (await send(res, Response.json({ error: "JSON required" }, { status: 415 })));
      await send(res, await handler.fetch(request));
    } catch (error) {
      if (res.headersSent) return void res.end();
      await send(res, Response.json({ error: errorMessage(error) }, { status: 500 }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", resolve);
  });
  const { port } = server.address() as { port: number };
  return {
    port,
    url: `http://127.0.0.1:${port}${REELS_MCP_PATH}`,
    workflowUrl: `http://127.0.0.1:${port}${WORKFLOW_MCP_PATH}`,
    close: async () => {
      await Promise.all(Object.values(handlers).map((handler) => handler.close()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
