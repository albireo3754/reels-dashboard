import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { errorMessage } from "../../shared/lib/errors";
import { startWorkflowServer } from "./server";
import { workflowRequest } from "./client";

const [command, arg] = process.argv.slice(2);
try {
  if (command === "serve") {
    const handle = await startWorkflowServer({
      root:
        process.env.REELS_WORKFLOW_DATA ??
        path.join(os.homedir(), ".local/share/reels-dashboard/workflows"),
      port: Number(process.env.REELS_WORKFLOW_PORT ?? 4318),
      webRoot: process.env.REELS_WORKFLOW_WEB_ROOT ?? "dist",
    });
    console.log(`Reels Dashboard workflows: ${handle.url}/?workflow=1`);
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await handle.close();
    };
    process.on("SIGINT", () => void close());
    process.on("SIGTERM", () => void close());
  } else if (command === "list" || command === "capabilities")
    console.log(JSON.stringify(await workflowRequest(command), null, 2));
  else if (command === "job" || command === "stop")
    console.log(
      JSON.stringify(await workflowRequest(command, { jobId: arg }), null, 2),
    );
  else if (command === "get" || command === "restart")
    console.log(
      JSON.stringify(await workflowRequest(command, { runId: arg }), null, 2),
    );
  else if (
    command === "create" ||
    command === "submit" ||
    command === "execute" ||
    command === "review-bundles" ||
    command === "review-markup" ||
    command === "experience-save" ||
    command === "experience-media" ||
    command === "followups-open"
  ) {
    if (!arg) throw new Error("Pass a JSON file path or '-' for stdin");
    let source = "";
    if (arg === "-") {
      for await (const chunk of process.stdin) source += chunk;
    } else source = await readFile(arg, "utf8");
    console.log(
      JSON.stringify(
        await workflowRequest(command, JSON.parse(source)),
        null,
        2,
      ),
    );
  } else
    throw new Error(
      "Usage: workflow serve | list | capabilities | get <id> | restart <id> | job <id> | stop <id> | create/submit/execute/review-bundles <json-file|->",
    );
} catch (e) {
  console.error(errorMessage(e));
  process.exitCode = 1;
}
