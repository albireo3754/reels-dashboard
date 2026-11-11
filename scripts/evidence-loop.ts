import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CodexImageAnalyzer } from "../src/desktop/analysis-provider";
import { connectEvidence, runEvidenceLoop } from "../src/desktop/media-evidence-loop";

const usage = `Usage:
  node --import tsx scripts/evidence-loop.ts run SPEC OUT [--check-only]
  node --import tsx scripts/evidence-loop.ts connect OUT USER_DATA_DIR PROJECT_ID`;
const [command, ...rest] = process.argv.slice(2);
try {
  if (command === "connect" && rest.length === 3) {
    console.log(JSON.stringify(await connectEvidence(rest[0], rest[1], rest[2])));
  } else if (command === "run" && rest.length >= 2 && rest.slice(2).every((flag) => flag === "--check-only")) {
    const [specFile, outputDir] = rest, checkOnly = rest.length > 2;
    const cache = path.join(path.resolve(outputDir), "provider-scratch");
    if (!checkOnly) await mkdir(cache, { recursive: true, mode: 0o700 });
    const result = await runEvidenceLoop(JSON.parse(await readFile(specFile, "utf8")), outputDir, new CodexImageAnalyzer(cache), { checkOnly, onProgress: (line) => console.error(line) });
    console.log(JSON.stringify(result));
    if (!result.pass) process.exitCode = 1;
  } else throw new Error(usage);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Evidence loop failed");
  process.exitCode = 1;
}
