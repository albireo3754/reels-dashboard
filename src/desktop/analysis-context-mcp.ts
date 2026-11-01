import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import {
  createAnalysisContextServer,
  batchContextSchema,
} from "./analysis-context-server";

async function main() {
  const [manifestPath, receiptPath] = process.argv.slice(2);
  if (!manifestPath || !receiptPath) throw new Error("Missing batch paths");
  const bytes = await readFile(manifestPath);
  if (bytes.length > 512 * 1024) throw new Error("Oversized batch context");
  const snapshot = batchContextSchema.parse(JSON.parse(bytes.toString("utf8")));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const handle = serveStdio(() =>
    createAnalysisContextServer(snapshot, async () => {
      await writeFile(
        receiptPath,
        JSON.stringify({ tool: "get_analysis_context", digest }),
        { mode: 0o600 },
      );
    }),
  );
  process.on("SIGTERM", () => void handle.close());
  process.on("SIGINT", () => void handle.close());
}
void main().catch(() => {
  process.stderr.write("Analysis context MCP initialization failed.\n");
  process.exitCode = 1;
});
