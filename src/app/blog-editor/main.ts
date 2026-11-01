import { readFile } from "node:fs/promises";
import { startCanonicalEditor } from "./server";
const file = process.argv[2];
if (!file)
  throw new Error(
    "Usage: npm run blog:editor -- /absolute/path/to/editor-config.json",
  );
const handle = await startCanonicalEditor(
  JSON.parse(await readFile(file, "utf8")),
);
console.log(`정본 스마트 에디터: ${handle.url}/?blogEditor=1`);
process.on("SIGTERM", () => void handle.close());
process.on("SIGINT", () => void handle.close());
