import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { agentRoot, callAgent } from "../../shared/lib/agent-socket";
import { createMcpServer } from "./server";

const root = agentRoot();
const handle = serveStdio(() =>
  createMcpServer((name, args) => callAgent(root, name, args)),
);
process.on("SIGINT", () => {
  void handle.close();
});
process.on("SIGTERM", () => {
  void handle.close();
});
