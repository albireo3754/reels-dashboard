import { build } from "esbuild";
await build({
  entryPoints: ["src/desktop/main.ts", "src/desktop/preload.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  sourcemap: true,
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
