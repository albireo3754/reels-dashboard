import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CodexImageAnalyzer } from "../src/desktop/analysis-provider";
import { analyzeEvidence } from "../src/desktop/media-evidence";

const [manifestFile, outputDir, ...flags] = process.argv.slice(2);
if (
  !manifestFile ||
  !outputDir ||
  flags.some((flag) => flag !== "--check-only")
)
  throw new Error(
    "Usage: node --import tsx scripts/analyze-evidence.ts MANIFEST OUT [--check-only]",
  );
const cache = path.join(path.resolve(outputDir), "provider-scratch");
const analyzer = new CodexImageAnalyzer(cache);
try {
  // The adapter owns context receipts and temporary files; source media is never copied.
  if (!flags.includes("--check-only"))
    await mkdir(cache, { recursive: true, mode: 0o700 });
  const result = await analyzeEvidence(
    JSON.parse(await readFile(manifestFile, "utf8")),
    outputDir,
    analyzer,
    {
      checkOnly: flags.includes("--check-only"),
      onProgress: ({ completedBatches, totalBatches, failedBatches }) =>
        console.log(
          `Batches ${completedBatches}/${totalBatches}; failed ${failedBatches}`,
        ),
    },
  );
  console.log(JSON.stringify(result));
  if (result.status === "failed") process.exitCode = 1;
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Evidence analysis failed",
  );
  process.exitCode = 1;
}
