// Same service as desktop IPC/MCP, usable without restarting an active editor.
// Run only while the app is not analyzing; the shared active.pid lock refuses overlaps.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { LocalStore } from "../src/shared/lib/storage";
import { ExecutionLogs } from "../src/shared/lib/execution-logs";
import { ContentLibrary } from "../src/features/content-library";
import { MediaAnalysis } from "../src/desktop/media-analysis";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string" },
    reasoning: { type: "string" },
    isolated: { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    "max-files": { type: "string" },
    "batch-images": { type: "string" },
  },
});
const [root, projectId, folder, contextFile] = positionals;
if (!root || !projectId || !folder)
  throw new Error(
    "Usage: node --import tsx scripts/analyze-project.ts USER_DATA PROJECT_ID LINKED_FOLDER [CONTEXT_JSON] [--model M] [--reasoning R] [--isolated] [--force] [--max-files N] [--batch-images N]",
  );
const store = new LocalStore(root);
await store.initialize();
const service = new MediaAnalysis(
  store,
  new ContentLibrary(store),
  path.resolve("native/editor-engine/.build/runtime"),
  new ExecutionLogs(root),
);
const prior = await service.search({ projectId });
const context = contextFile
  ? JSON.parse(await readFile(contextFile, "utf8"))
  : undefined;
const run = await service.start({
  projectId,
  folder,
  ...(context ? { context, expectedRevision: prior.revision } : {}),
  ...(values.model ? { model: values.model } : {}),
  ...(values.reasoning ? { reasoning: values.reasoning as "low" } : {}),
  ...(values["max-files"] ? { maxFiles: Number(values["max-files"]) } : {}),
  ...(values["batch-images"] ? { batchImages: Number(values["batch-images"]) } : {}),
  isolated: values.isolated,
  force: values.force,
});
console.log(JSON.stringify(run));
const timer = setInterval(async () => {
  const view = await service.search({ projectId });
  const latest = view.runs.find((r) => r.id === run.id)!;
  console.log(JSON.stringify(latest));
  if (latest.status !== "running") {
    clearInterval(timer);
    process.exitCode = latest.status === "completed" ? 0 : 1;
  }
}, 10000);
