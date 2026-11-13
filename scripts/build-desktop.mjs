import { build } from "esbuild";
import { chmod, readFile } from "node:fs/promises";
// npm can disable dependency install scripts; node-pty's prebuilt helper still
// needs its executable bit in development and in the packaged asarUnpack tree.
if (process.platform === "darwin") {
  await chmod(`node_modules/node-pty/prebuilds/darwin-${process.arch}/spawn-helper`, 0o755);
}
const desktop = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron", "node-pty"],
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  sourcemap: true,
};
// main embeds the workflow server. ESM-only deps such as @openai/codex-sdk call
// createRequire(import.meta.url) at load; in a CJS bundle import.meta is empty, so give
// them the bundle's own file URL. Not applied to the sandboxed preload (no __filename).
await build({
  ...desktop,
  entryPoints: ["src/desktop/main.ts", "src/desktop/analysis-context-mcp.ts"],
  define: { "import.meta.url": "__reelsImportMetaUrl" },
  inject: ["scripts/import-meta-url-shim.mjs"],
});
await build({ ...desktop, entryPoints: ["src/desktop/preload.ts"] });

// Restore viewer copied into each blog extraction result folder (served by BlogResults.preview).
await build({
  entryPoints: { "restore-viewer": "tools/blog-restore/viewer.jsx" },
  outdir: "dist-electron/blog-restore-viewer",
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  external: ["fonts/*"],
  define: { "process.env.NODE_ENV": '"production"' },
  minify: true,
  logLevel: "warning",
});

await build({
  entryPoints: ["src/app/mcp/main.ts"],
  outfile: "dist-mcp/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
});

// Single self-contained file: zod is bundled so the CLI runs from any directory.
// The agent guide is embedded too, so `reels help agent` matches this build without the repository.
const agentGuide = await readFile("skills/reels-cli/SKILL.md", "utf8");
await build({
  entryPoints: ["src/app/cli/main.ts"],
  outfile: "dist-cli/reels.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  define: { __REELS_AGENT_GUIDE__: JSON.stringify(agentGuide) },
});
await chmod("dist-cli/reels.mjs", 0o755);
