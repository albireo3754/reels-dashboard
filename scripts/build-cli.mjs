import { build } from "esbuild";
import { chmod, readFile } from "node:fs/promises";

// Single self-contained file: zod is bundled so the CLI runs from any directory.
// The agent guide is embedded too, so `reels help agent` matches this build without the repository.
export async function buildCli(outfile) {
  const agentGuide = await readFile("skills/reels-cli/SKILL.md", "utf8");
  await build({
    entryPoints: ["src/app/cli/main.ts"],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: true,
    banner: { js: "#!/usr/bin/env node" },
    define: { __REELS_AGENT_GUIDE__: JSON.stringify(agentGuide) },
  });
  await chmod(outfile, 0o755);
}
