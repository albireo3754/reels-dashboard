// Export the two source roots into an empty directory for review before Sites publication.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
if (process.argv.length !== 3)
  throw new Error(
    "Usage: node scripts/mobile-briefing/export-site.mjs <empty-directory>",
  );
const destination = path.resolve(process.argv[2]);
mkdirSync(destination, { recursive: true });
if (readdirSync(destination).length)
  throw new Error("Export requires an empty directory.");

for (const [source, prefix] of [
  ["apps/mobile-briefing", ""],
  ["packages/briefing", "shared"],
]) {
  const files = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "-z",
      "--",
      source,
    ],
    { cwd: root },
  )
    .toString()
    .split("\0")
    .filter(Boolean);
  for (const name of files) {
    const file = path.join(root, name);
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue; // A tracked source may have been removed in the working tree.
    if (!stat.isFile())
      throw new Error(`Expected a regular source file: ${name}`);
    const output = path.join(destination, prefix, path.relative(source, name));
    mkdirSync(path.dirname(output), { recursive: true });
    copyFileSync(file, output);
  }
}

const configPath = path.join(destination, "tsconfig.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.compilerOptions.paths["@briefing/*"] = ["./shared/*"];
writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
console.log(`Site source ready at ${destination}`);
