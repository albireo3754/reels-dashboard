import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderEvidenceMetadataTable } from "../src/desktop/media-evidence";

const [resultsFile, outputFile, ...extra] = process.argv.slice(2);
if (!resultsFile || !outputFile || extra.length)
  throw new Error(
    "Usage: node --import tsx scripts/render-evidence-table.ts RESULTS_JSON OUT_MD",
  );
const resultsPath = path.resolve(resultsFile);
const outputPath = path.resolve(outputFile);
if (
  path.extname(outputPath).toLowerCase() !== ".md" ||
  outputPath === resultsPath
)
  throw new Error("Output must be a separate .md file");
const input = JSON.parse(await readFile(resultsPath, "utf8"));
await writeFile(outputPath, renderEvidenceMetadataTable(input, resultsPath), {
  mode: 0o600,
});
console.log(JSON.stringify({ output: outputPath, rows: input.images.length }));
