/** Render an already saved, template-only plan through the same service as the app. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CardNewsService } from "../src/desktop/card-news.ts";
import { LocalStore } from "../src/shared/lib/storage.ts";
import { cardPlanSchema } from "../src/shared/card-news.ts";
const [root, input, output] = process.argv.slice(2);
if (!root || !input || !output)
  throw new Error(
    "Usage: node --import tsx scripts/render-card-plan.mts USER_DATA_ROOT SAVED_PLAN_JSON OUTPUT_MP4",
  );
const store = new LocalStore(path.resolve(root));
await store.initialize();
const service = new CardNewsService({
  root: path.resolve(root),
  store,
  runtime: path.resolve("native/editor-engine/.build/runtime"),
  chooseAsset: async () => null,
  chooseOutput: async () => path.resolve(output),
  normalizeImage: () => {
    throw new Error("Imports are not supported by this command");
  },
  validateFrame: (b) => {
    if (b.readUInt32BE(16) !== 1080 || b.readUInt32BE(20) !== 1920)
      throw new Error("Invalid frame");
  },
  reveal: () => {},
  changed: () => {},
});
const plan = cardPlanSchema.parse(JSON.parse(await readFile(input, "utf8")));
const frames = await service.preview(plan);
const job = await service.export(plan, frames);
if (!job) throw new Error("No output selected");
while (true) {
  const result = await service.job(job.id);
  if (result.state !== "running") {
    console.log(JSON.stringify(result));
    if (result.state !== "completed") process.exitCode = 1;
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
