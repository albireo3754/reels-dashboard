import { readFile, stat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";
import {
  definitionLocationInput,
  workflowDefinitionSchema,
  type DefinitionSnapshot,
} from "../../shared/workflow-definition";
import { resolveFile } from "./files";

export async function readDefinition(
  raw: unknown,
): Promise<DefinitionSnapshot> {
  const input = definitionLocationInput.parse(raw);
  const workspace = await realpath(input.workspace);
  const file = await resolveFile(workspace, input.definitionFile);
  if ((await stat(file)).size > 200000)
    throw new Error("Definition exceeds 200 KB");
  const source = await readFile(file, "utf8");
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length)
    throw new Error(
      "Invalid workflow YAML: " +
        [...doc.errors, ...doc.warnings].map((e) => e.message).join("; "),
    );
  const definition = workflowDefinitionSchema.parse(
    doc.toJS({ maxAliasCount: 0 }),
  );
  return {
    file: input.definitionFile,
    source,
    sha256: createHash("sha256").update(source).digest("hex"),
    definition,
  };
}
