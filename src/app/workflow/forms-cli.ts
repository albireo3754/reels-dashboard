import { readFile } from "node:fs/promises";
import { workflowRequest } from "./client";
import { inputFormTools } from "../../shared/input-form-tools";
const [command, arg, flag] = process.argv.slice(2);
try {
  let action: (typeof inputFormTools)[number][0];
  let input: unknown;
  if (command === "wait") {
    action = "form-wait";
    input = {
      formId: arg,
      afterRevision: Number(flag ?? -1),
      timeoutMs: Number(process.argv[5] ?? 30000),
    };
  } else if (command === "list") {
    action = "forms-list";
    input = arg ? { projectId: arg } : {};
  } else if (["get", "results", "sync", "open"].includes(command)) {
    action = ("form-" + command) as typeof action;
    input =
      command === "open"
        ? { formId: arg, surface: flag === "--desktop" ? "desktop" : "link" }
        : { formId: arg };
  } else if (
    ["create", "save", "apply", "media", "artifact"].includes(command)
  ) {
    action = ("form-" + command) as typeof action;
    if (!arg) throw Error("Pass a JSON file or - for stdin");
    let source = "";
    if (arg === "-") {
      for await (const chunk of process.stdin) source += chunk;
    } else source = await readFile(arg, "utf8");
    input = JSON.parse(source);
  } else
    throw Error(
      "Usage: forms list [projectId] | get/results/sync <formId> | open <formId> [--desktop] | create/save/apply/media <json-file|->",
    );
  const definition = inputFormTools.find((t) => t[0] === action)!;
  definition[2].parse(input);
  console.log(JSON.stringify(await workflowRequest(action, input), null, 2));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
