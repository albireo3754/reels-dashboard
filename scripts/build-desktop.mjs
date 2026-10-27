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
