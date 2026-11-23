// Exercise the production Worker with a fresh local database and the actual client assets.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Miniflare } from "miniflare";

const run = promisify(execFile);
const root = path.resolve("dist/server");
const config = JSON.parse(
  await readFile(path.join(root, "wrangler.json"), "utf8"),
);
const files = await readdir(root, { recursive: true });
const modules = [
  config.main,
  ...files.filter((f) => f !== config.main && f.endsWith(".js")),
].map((f) => ({ type: "ESModule", path: path.join(root, f) }));
const key = randomUUID();
const worker = new Miniflare({
  host: "127.0.0.1",
  modules,
  modulesRoot: root,
  compatibilityDate: config.compatibility_date,
  compatibilityFlags: config.compatibility_flags,
  assets: {
    directory: path.resolve(root, config.assets.directory),
    routerConfig: { has_user_worker: true },
  },
  d1Databases: ["DB"],
  r2Buckets: ["BUCKET"],
  bindings: { BRIDGE_SECRET: key },
});
try {
  const origin = (await worker.ready).origin;
  const db = await worker.getD1Database("DB");
  for (const file of (await readdir("drizzle"))
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = await readFile(path.join("drizzle", file), "utf8");
    await db.batch(
      sql.split("--> statement-breakpoint").map((s) => db.prepare(s.trim())),
    );
  }
  const env = {
    ...process.env,
    MONITOR_TEST_ORIGIN: origin,
    TOPICS_TEST_ORIGIN: origin,
    PWA_TEST_ORIGIN: origin,
    BRIEFING_QA_KEY: key,
  };
  for (const args of [
    ["check-monitor.mjs"],
    ["check-topics.mjs"],
    ["check-source-board.mjs", origin],
    ["check-pwa.mjs"],
  ]) {
    const { stdout } = await run(
      process.execPath,
      [path.join("scripts", args[0]), ...args.slice(1)],
      { env },
    );
    process.stdout.write(stdout);
  }
} finally {
  await worker.dispose();
}
