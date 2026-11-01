import { build } from "esbuild";
import { chmod } from "node:fs/promises";
// npm can disable dependency install scripts; node-pty's prebuilt helper still
// needs its executable bit in development and in the packaged asarUnpack tree.
if (process.platform === "darwin") {
  await chmod(`node_modules/node-pty/prebuilds/darwin-${process.arch}/spawn-helper`, 0o755);
}
await build({
  entryPoints: ["src/desktop/main.ts", "src/desktop/preload.ts", "src/desktop/analysis-context-mcp.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron", "node-pty"],
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  sourcemap: true,
});

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
