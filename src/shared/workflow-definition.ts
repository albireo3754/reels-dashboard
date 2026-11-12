import { z } from "zod";

export const stepIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const id = stepIdSchema;
export const relativeFile = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (s) =>
      !s.startsWith("/") &&
      !s.includes("\\") &&
      !s.includes(":") &&
      s
        .split("/")
        .every((part) => part !== ".." && part !== "." && part !== ""),
    "Use a normalized workspace-relative file path",
  );
/**
 * Shared definition: a normalized absolute YAML path. The runtime only reads it when
 * its real path sits directly in `<ancestor of workspace>/workflows/`.
 */
const sharedDefinitionFile = z
  .string()
  .min(2)
  .max(1000)
  .refine(
    (s) =>
      s.startsWith("/") &&
      /\.ya?ml$/.test(s) &&
      !s.includes("\\") &&
      s
        .slice(1)
        .split("/")
        .every((part) => part !== ".." && part !== "." && part !== ""),
    "Use a workspace-relative path or a normalized absolute YAML path",
  );
/** Workspace-relative file, or an absolute YAML file in `<ancestor>/workflows/`. */
export const definitionPath = z.union([relativeFile, sharedDefinitionFile]);
/**
 * Definitions owned by the app, chosen by name. The flow (steps, transitions,
 * kinds, outputs) and public instructions live in the source; local guides add
 * private documents, instructions and skills per step.
 */
export const builtinDefinitionNames = ["blog"] as const;
export const builtinDefinitionName = z.enum(builtinDefinitionNames);
export type BuiltinDefinitionName = z.infer<typeof builtinDefinitionName>;
export const builtinDefinitionLabels: Record<BuiltinDefinitionName, string> = {
  blog: "블로그 · 촬영분에서 미리보기까지",
};
/** Exactly one of `definitionFile` and `builtinDefinition`; checked when read. */
export const definitionLocationInput = z.strictObject({
  workspace: z.string().min(1),
  definitionFile: definitionPath.optional(),
  builtinDefinition: builtinDefinitionName.optional(),
  /** Local guide file (see workflow-guide.ts); same path rule as definitionFile. */
  guideFile: definitionPath.optional(),
});
export const stepToolSchema = z.strictObject({
  server: z.string().trim().min(1).max(100),
  name: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .max(120),
  purpose: z.string().trim().min(1).max(1000),
});
export const stepSkillSchema = z.string().trim().min(1).max(1000);
const stepSchema = z.strictObject({
  id,
  title: z.string().trim().min(1).max(200),
  kind: z.enum(["task", "review", "input"]),
  instruction: z.string().trim().min(1).max(20000),
  skills: z.array(stepSkillSchema).max(20).default([]),
  tools: z.array(stepToolSchema).max(30).default([]),
  inputs: z.array(relativeFile).max(100).default([]),
  outputs: z.array(relativeFile).max(100).default([]),
  completion: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
  formFile: relativeFile.optional(),
  on: z.strictObject({
    done: z.string().optional(),
    pass: z.string().optional(),
    revise: z.string().optional(),
  }),
});
export const workflowDefinitionSchema = z
  .strictObject({
    version: z.literal(1),
    id,
    title: z.string().trim().min(1).max(200),
    entry: id,
    maxTransitions: z.number().int().min(1).max(500).default(100),
    steps: z.array(stepSchema).min(1).max(50),
  })
  .superRefine((definition, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const ids = new Set(definition.steps.map((s) => s.id));
    if (ids.size !== definition.steps.length) fail("Step IDs must be unique");
    if (!ids.has(definition.entry)) fail("Unknown entry step");
    if (definition.steps.filter((s) => s.kind === "input").length > 1)
      fail("Version 1 supports one shared input form per run");
    for (const step of definition.steps) {
      if (
        step.kind === "review"
          ? !step.on.pass || !step.on.revise || !!step.on.done
          : !step.on.done || !!step.on.pass || !!step.on.revise
      )
        fail(
          `${step.id}: task/input requires done; review requires pass and revise`,
        );
      if ((step.kind === "input") !== !!step.formFile)
        fail(`${step.id}: only input steps require formFile`);
      if (step.kind === "input" && step.outputs.length)
        fail(
          `${step.id}: input exports are assigned by the shared form service`,
        );
      if (step.kind !== "input" && !step.outputs.length)
        fail(`${step.id}: declare at least one output evidence file`);
      if (step.on.revise === "$complete")
        fail("Revision cannot complete a workflow");
      for (const target of Object.values(step.on))
        if (target !== "$complete" && !ids.has(target))
          fail(`${step.id}: unknown target ${target}`);
    }
    const reachable = (start: string, includeRevisions: boolean) => {
      const seen = new Set<string>();
      const visit = (key: string) => {
        if (seen.has(key)) return;
        seen.add(key);
        const step = definition.steps.find((s) => s.id === key);
        if (step)
          for (const [outcome, target] of Object.entries(step.on))
            if (includeRevisions || outcome !== "revise") visit(target);
      };
      visit(start);
      return seen;
    };
    const all = reachable(definition.entry, true);
    for (const step of definition.steps) {
      if (!all.has(step.id)) fail(`Unreachable step: ${step.id}`);
      if (!reachable(step.id, false).has("$complete"))
        fail(`No completion path from ${step.id}`);
      // Successful transitions must be acyclic; only explicit review revisions loop.
      for (const [outcome, target] of Object.entries(step.on)) {
        if (outcome !== "revise" && reachable(target, false).has(step.id))
          fail("Cycles require a review revise edge");
        if (
          outcome === "revise" &&
          [...reachable(target, true)].some((key) =>
            definition.steps.some((s) => s.id === key && s.kind === "input"),
          )
        )
          fail("Revision paths cannot revisit a submitted input form");
      }
    }
  });
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type DefinitionStep = WorkflowDefinition["steps"][number];
export interface DefinitionSnapshot {
  /** Path as given, or `builtin:<name>` for an app-owned definition. */
  file: string;
  sha256: string;
  source: string;
  definition: WorkflowDefinition;
}
export const definitionStage = (step: DefinitionStep) =>
  step.kind === "review"
    ? ("review" as const)
    : step.kind === "input"
      ? ("experience" as const)
      : ("prepare" as const);
export function definitionEdges(definition: WorkflowDefinition) {
  return definition.steps.flatMap((step) =>
    Object.entries(step.on).map(([outcome, to]) => ({
      from: step.id,
      outcome,
      to,
    })),
  );
}
