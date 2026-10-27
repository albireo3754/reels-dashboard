import os from "node:os";
import path from "node:path";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { callAgent } from "../../shared/lib/agent-socket";
import { createMcpServer } from "./server";

const root =
  process.env.REELS_USER_DATA ??
  path.join(os.homedir(), "Library", "Application Support", "Reels Dashboard");
const handle = serveStdio(() =>
  createMcpServer((name, args) => callAgent(root, name, args)),
);
process.on("SIGINT", () => {
  void handle.close();
});
process.on("SIGTERM", () => {
  void handle.close();
});
