// Same service as desktop IPC/MCP, usable without restarting an active editor.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LocalStore } from "../src/shared/lib/storage";
import { ContentLibrary } from "../src/features/content-library";
import { MediaAnalysis } from "../src/desktop/media-analysis";
const [root, projectId, folder, contextFile] = process.argv.slice(2);
if (!root || !projectId || !folder)
  throw new Error(
    "Usage: node --import tsx scripts/analyze-project.ts USER_DATA PROJECT_ID LINKED_FOLDER",
  );
const store = new LocalStore(root);
await store.initialize();
const service = new MediaAnalysis(
  store,
  new ContentLibrary(store),
  path.resolve("native/editor-engine/.build/runtime"),
);
const prior = await service.search({ projectId });
const context = contextFile
  ? JSON.parse(await readFile(contextFile, "utf8"))
  : undefined;
const run = await service.start({
  projectId,
  folder,
  ...(context ? { context, expectedRevision: prior.revision } : {}),
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
