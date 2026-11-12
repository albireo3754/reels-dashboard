import { readFile, stat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseDocument } from "yaml";
import {
  definitionLocationInput,
  workflowDefinitionSchema,
  type DefinitionSnapshot,
} from "../../shared/workflow-definition";
import { resolveFile } from "./files";

/**
 * A shared definition is read only when its real path is a direct child of a
 * `workflows/` directory whose parent is a proper ancestor of the workspace
 * (e.g. `<root>/workflows/blog.yaml` for `<root>/research/<slug>`). Symlinks
 * are resolved first, so a link cannot reach a file outside that boundary.
 */
export async function resolveSharedDefinition(
  workspace: string,
  file: string,
) {
  let resolved: string;
  try {
    resolved = await realpath(file);
  } catch {
    throw new Error("SHARED_DEFINITION: file not found: " + file);
  }
  const dir = path.dirname(resolved);
  const owner = path.dirname(dir);
  if (
    path.basename(dir) !== "workflows" ||
    owner === path.parse(owner).root ||
    !/\.ya?ml$/.test(resolved) ||
    !workspace.startsWith(owner + path.sep)
  )
    throw new Error(
      "SHARED_DEFINITION: use a YAML file directly in a workflows/ folder of a workspace ancestor",
    );
  if (!(await stat(resolved)).isFile())
    throw new Error("SHARED_DEFINITION: expected a file");
  return resolved;
}

export async function readDefinition(
  raw: unknown,
): Promise<DefinitionSnapshot> {
  const input = definitionLocationInput.parse(raw);
  const workspace = await realpath(input.workspace);
  const file = path.isAbsolute(input.definitionFile)
    ? await resolveSharedDefinition(workspace, input.definitionFile)
    : await resolveFile(workspace, input.definitionFile);
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
