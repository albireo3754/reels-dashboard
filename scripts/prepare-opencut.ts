import { readFile } from "node:fs/promises";
import { agentRoot } from "../src/shared/lib/agent-socket";
import { prepareOpenCutPackage } from "../src/app/cli/opencut-package";

const [input, ...extra] = process.argv.slice(2);
if (!input || extra.length)
  throw new Error("Usage: npm run opencut:prepare -- /absolute/request.json");
try {
  const result = await prepareOpenCutPackage(
    JSON.parse(await readFile(input, "utf8")),
    agentRoot(),
  );
  console.log(JSON.stringify({ ok: true, data: result }));
} catch (error) {
  console.error(
    "Preparation stopped. Existing output may be partial; inspect it and the Dashboard before retrying.",
  );
  console.log(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
