import { errorMessage } from "./errors";
import { createConnection, createServer, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const agentRequestLimit = 2 * 1024 * 1024;
const responseLimit = 64 * 1024 * 1024;
// The server drops idle sockets at this limit, so a client cannot wait longer.
const socketTimeoutMs = 180_000;
const emptyErrorMessage = "앱이 오류 내용을 알려주지 않았어요.";
const connectionFile = (root: string) =>
  path.join(root, "agent", "connection.json");
type Connection = { version: 1; socket: string; token: string; pid: number };

/** The app's user-data folder, which holds the private connection file. */
export function agentRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.REELS_USER_DATA
    ? path.resolve(env.REELS_USER_DATA)
    : path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Reels Dashboard",
      );
}

export type AgentOfflineReason =
  | "no_connection_file"
  | "unsafe_connection_file"
  | "stale_connection";

/**
 * A transport failure, as opposed to an error the app returned. `requestSent`
 * separates "the app never saw this" from "the outcome is unknown". The message
 * keeps the `CODE: text` form so clients that only see text can still classify it.
 */
export class AgentCallError extends Error {
  constructor(
    readonly code: string,
    text: string,
    readonly requestSent: boolean,
    readonly reason?: AgentOfflineReason,
  ) {
    super(`${code}: ${text}`);
    this.name = "AgentCallError";
  }
}

export async function startAgentSocket(
  root: string,
  dispatch: (name: string, args: unknown) => Promise<unknown>,
) {
  const directory = await mkdtemp("/tmp/reels-mcp-");
  await chmod(directory, 0o700);
  const record: Connection = {
    version: 1,
    socket: path.join(directory, "app.sock"),
    token: randomBytes(32).toString("hex"),
    pid: process.pid,
  };
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(socketTimeoutMs, () => socket.destroy());
    let data = Buffer.alloc(0),
      received = false;
    socket.on("data", (chunk) => {
      if (received) return;
      data = Buffer.concat([data, chunk]);
      if (data.length > agentRequestLimit) {
        socket.destroy();
        return;
      }
      const newline = data.indexOf(10);
      if (newline < 0) return;
      received = true;
      void (async () => {
        try {
          const request = JSON.parse(
            data.subarray(0, newline).toString("utf8"),
          );
          if (
            request.token !== record.token ||
            request.version !== 1 ||
            typeof request.name !== "string"
          )
            throw new Error("Unauthorized agent request");
          const result = await dispatch(request.name, request.args);
          const response = JSON.stringify({ result }) + "\n";
          if (Buffer.byteLength(response) > responseLimit)
            throw new Error("Agent response too large");
          socket.end(response);
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          socket.end(
            JSON.stringify({
              error: errorMessage(error) || emptyErrorMessage,
              ...(typeof code === "string" ? { code } : {}),
            }) + "\n",
          );
        }
      })();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(record.socket, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(record.socket, 0o600);
    const folder = path.dirname(connectionFile(root));
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const info = await lstat(folder);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.()
    )
      throw new Error("Unsafe agent directory");
    await chmod(folder, 0o700);
    const temp = connectionFile(root) + `.${record.token.slice(0, 12)}.tmp`;
    await writeFile(temp, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    await rename(temp, connectionFile(root));
  } catch (error) {
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const current = await readFile(connectionFile(root), "utf8").catch(
      () => "",
    );
    if (current === JSON.stringify(record))
      await rm(connectionFile(root), { force: true });
    await rm(directory, { recursive: true, force: true });
  };
}

async function readConnection(root: string): Promise<Connection> {
  const offline = (reason: AgentOfflineReason) =>
    new AgentCallError(
      "APP_OFFLINE",
      "Reels Dashboard를 열어주세요. MCP는 실행 중인 앱에 연결해요.",
      false,
      reason,
    );
  const file = connectionFile(root);
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    throw offline(
      error.code === "ENOENT" || error.code === "ENOTDIR"
        ? "no_connection_file"
        : "unsafe_connection_file",
    );
  });
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    info.uid !== process.getuid?.()
  )
    throw offline("unsafe_connection_file");
  try {
    const record: Connection = JSON.parse(await readFile(file, "utf8"));
    if (
      record.version === 1 &&
      typeof record.socket === "string" &&
      /^[a-f0-9]{64}$/.test(record.token)
    )
      return record;
  } catch {
    // Reported below with the same reason as a well-formed but invalid record.
  }
  throw offline("unsafe_connection_file");
}

export async function callAgent(
  root: string,
  name: string,
  args: unknown,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<any> {
  const record = await readConnection(root);
  const request =
    JSON.stringify({ version: 1, token: record.token, name, args }) + "\n";
  if (Buffer.byteLength(request) > agentRequestLimit)
    throw new AgentCallError("REQUEST_TOO_LARGE", "요청이 너무 커요.", false);
  const { signal } = options;
  const timeoutMs = Math.min(
    Math.max(1, Math.ceil(options.timeoutMs ?? socketTimeoutMs)),
    socketTimeoutMs,
  );
  return new Promise((resolve, reject) => {
    const socket = createConnection(record.socket);
    const chunks: Buffer[] = [];
    let size = 0,
      settled = false,
      requestSent = false;
    const aborted = () =>
      finish(
        new AgentCallError(
          "ABORTED",
          "호출을 중단했어요. 작업은 앱에서 계속될 수 있어요.",
          requestSent,
        ),
      );
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", aborted);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const disconnected = () =>
      finish(
        requestSent
          ? new AgentCallError(
              "CONNECTION_LOST",
              "응답을 받기 전에 연결이 끊겼어요. 작업 결과가 불확실해요. 상태를 조회하고 쓰기 작업을 자동 재시도하지 마세요.",
              true,
            )
          : new AgentCallError(
              "APP_OFFLINE",
              "Dashboard 연결이 끊겼어요. 앱 상태를 확인해주세요.",
              false,
              "stale_connection",
            ),
      );
    const invalidResponse = () =>
      finish(
        new AgentCallError(
          "RESPONSE_INVALID",
          "앱 응답을 읽지 못했어요. 작업 결과가 불확실해요.",
          true,
        ),
      );
    // A limit on the whole call: a slow stream of data must not extend it.
    const deadline = setTimeout(
      () =>
        finish(
          new AgentCallError(
            "REQUEST_TIMEOUT",
            "작업 결과가 불확실해요. 상태를 조회하고 쓰기 작업을 자동 재시도하지 마세요.",
            requestSent,
          ),
        ),
      timeoutMs,
    );
    if (signal?.aborted) return aborted();
    signal?.addEventListener("abort", aborted, { once: true });
    socket.on("error", disconnected);
    socket.on("end", disconnected);
    socket.on("close", disconnected);
    socket.on("connect", () => {
      requestSent = true;
      socket.write(request);
    });
    socket.on("data", (chunk) => {
      // Only the new chunk is searched: a large image arrives in many pieces.
      const newline = chunk.indexOf(10);
      const line = newline < 0 ? chunk : chunk.subarray(0, newline);
      size += line.length;
      if (size > responseLimit) return invalidResponse();
      chunks.push(line);
      if (newline < 0) return;
      try {
        const response = JSON.parse(
          Buffer.concat(chunks, size).toString("utf8"),
        );
        // An empty message is still a failure, so test the key and not its value.
        finish(
          "error" in response
            ? Object.assign(
                new Error(String(response.error) || emptyErrorMessage),
                typeof response.code === "string"
                  ? { code: response.code }
                  : {},
              )
            : undefined,
          response.result,
        );
      } catch {
        invalidResponse();
      }
    });
  });
}
