import { readFile, stat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseDocument } from "yaml";
import {
  definitionLocationInput,
  workflowDefinitionSchema,
  type BuiltinDefinitionName,
  type DefinitionSnapshot,
  type WorkflowDefinition,
} from "../../shared/workflow-definition";
import {
  workflowGuideSchema,
  type GuideSnapshot,
} from "../../shared/workflow-guide";
import { hashes, resolveFile } from "./files";
import { builtinDefinitions } from "./builtin-definitions";

/**
 * A shared definition is read only when its real path is a direct child of a
 * `workflows/` directory whose parent is a proper ancestor of the workspace
 * (e.g. `<root>/workflows/blog.yaml` for `<root>/research/<slug>`). Symlinks
 * are resolved first, so a link cannot reach a file outside that boundary.
 */
export async function resolveSharedDefinition(
  workspace: string,
  file: string,
  code = "SHARED_DEFINITION",
) {
  let resolved: string;
  try {
    resolved = await realpath(file);
  } catch {
    throw new Error(code + ": file not found: " + file);
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
      code +
        ": use a YAML file directly in a workflows/ folder of a workspace ancestor",
    );
  if (!(await stat(resolved)).isFile())
    throw new Error(code + ": expected a file");
  return resolved;
}

/** Workspace-relative file, or an absolute file under the shared `workflows/` rule. */
async function readLocalYaml(workspace: string, file: string, code: string) {
  const resolved = path.isAbsolute(file)
    ? await resolveSharedDefinition(workspace, file, code)
    : await resolveFile(workspace, file);
  if ((await stat(resolved)).size > 200000)
    throw new Error(code + ": file exceeds 200 KB");
  return { resolved, source: await readFile(resolved, "utf8") };
}

function parseYaml(source: string, label: string) {
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length)
    throw new Error(
      `Invalid ${label} YAML: ` +
        [...doc.errors, ...doc.warnings].map((e) => e.message).join("; "),
    );
  return doc.toJS({ maxAliasCount: 0 });
}

const sha256 = (source: string) =>
  createHash("sha256").update(source).digest("hex");

/** The app-owned definition text for `name`, validated like a YAML file. */
export function builtinDefinition(
  name: BuiltinDefinitionName,
): DefinitionSnapshot {
  const source = builtinDefinitions[name];
  return {
    file: "builtin:" + name,
    source,
    sha256: sha256(source),
    definition: workflowDefinitionSchema.parse(parseYaml(source, "workflow")),
  };
}

export async function readDefinition(
  raw: unknown,
): Promise<DefinitionSnapshot> {
  const input = definitionLocationInput.parse(raw);
  if (!input.definitionFile === !input.builtinDefinition)
    throw new Error(
      "DEFINITION: pass exactly one of definitionFile and builtinDefinition",
    );
  if (input.builtinDefinition)
    return builtinDefinition(input.builtinDefinition);
  const workspace = await realpath(input.workspace);
  const { source } = await readLocalYaml(
    workspace,
    input.definitionFile!,
    "SHARED_DEFINITION",
  );
  return {
    file: input.definitionFile!,
    source,
    sha256: sha256(source),
    definition: workflowDefinitionSchema.parse(parseYaml(source, "workflow")),
  };
}

/**
 * Read a local guide for `definition`. The guide file follows the definitionFile
 * path rule. Its document paths are relative to the guide's base folder: the
 * workspace for a workspace guide, or the folder that holds `workflows/` for a
 * shared guide; their real paths must stay inside that folder. Unknown step IDs,
 * flow keys and a mismatched `definition` are rejected. Documents are hashed, not
 * copied.
 */
export async function readGuide(
  workspace: string,
  file: string,
  definition: WorkflowDefinition,
): Promise<GuideSnapshot> {
  const { resolved, source } = await readLocalYaml(workspace, file, "GUIDE");
  const guide = workflowGuideSchema.parse(parseYaml(source, "guide"));
  if (guide.definition && guide.definition !== definition.id)
    throw new Error(
      `GUIDE: written for definition ${guide.definition}, not ${definition.id}`,
    );
  const base = path.isAbsolute(file)
    ? path.dirname(path.dirname(resolved))
    : workspace;
  const steps: GuideSnapshot["steps"] = {};
  for (const [stepId, step] of Object.entries(guide.steps)) {
    if (!definition.steps.some((s) => s.id === stepId))
      throw new Error(`GUIDE: unknown step ${stepId} in ${definition.id}`);
    let found: Record<string, string>;
    try {
      found = await hashes(base, step.docs);
    } catch (e) {
      throw new Error(
        `GUIDE: ${stepId} documents must be files inside ${base}: ${(e as Error).message}`,
      );
    }
    steps[stepId] = {
      ...step,
      docs: await Promise.all(
        step.docs.map(async (doc) => ({
          file: doc,
          path: await resolveFile(base, doc),
          sha256: found[doc],
        })),
      ),
    };
  }
  return { file, sha256: sha256(source), source, base, steps };
}
