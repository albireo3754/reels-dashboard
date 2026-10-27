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
import path from "node:path";

const requestLimit = 2 * 1024 * 1024;
const responseLimit = 64 * 1024 * 1024;
const connectionFile = (root: string) =>
  path.join(root, "agent", "connection.json");
type Connection = { version: 1; socket: string; token: string; pid: number };
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
    socket.setTimeout(180_000, () => socket.destroy());
    let data = Buffer.alloc(0),
      received = false;
    socket.on("data", (chunk) => {
      if (received) return;
      data = Buffer.concat([data, chunk]);
      if (data.length > requestLimit) {
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
          socket.end(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
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

export async function callAgent(
  root: string,
  name: string,
  args: unknown,
): Promise<any> {
  let record: Connection;
  try {
    const file = connectionFile(root),
      info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.mode & 0o077 ||
      info.uid !== process.getuid?.()
    )
      throw new Error("Unsafe connection file");
    record = JSON.parse(await readFile(file, "utf8"));
    if (
      record.version !== 1 ||
      typeof record.socket !== "string" ||
      !/^[a-f0-9]{64}$/.test(record.token)
    )
      throw new Error("Invalid connection file");
  } catch {
    throw new Error(
      "APP_OFFLINE: Reels Dashboard를 열어주세요. MCP는 실행 중인 앱에 연결해요.",
    );
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection(record.socket);
    let data = Buffer.alloc(0),
      settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    socket.setTimeout(180_000, () =>
      finish(
        new Error(
          "REQUEST_TIMEOUT: 작업 결과가 불확실해요. 상태를 조회하고 쓰기 작업을 자동 재시도하지 마세요.",
        ),
      ),
    );
    socket.on("error", () =>
      finish(
        new Error(
          "APP_OFFLINE: Dashboard 연결이 끊겼어요. 앱 상태를 확인해주세요.",
        ),
      ),
    );
    socket.on("connect", () => {
      const request =
        JSON.stringify({ version: 1, token: record.token, name, args }) + "\n";
      if (Buffer.byteLength(request) > requestLimit)
        return finish(new Error("Request too large"));
      socket.write(request);
    });
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > responseLimit)
        return finish(new Error("Response too large"));
      const newline = data.indexOf(10);
      if (newline < 0) return;
      try {
        const response = JSON.parse(data.subarray(0, newline).toString("utf8"));
        finish(
          response.error ? new Error(response.error) : undefined,
          response.result,
        );
      } catch {
        finish(new Error("Invalid app response"));
      }
    });
    socket.on("end", () => {
      if (!settled) finish(new Error("Incomplete app response"));
    });
  });
}
