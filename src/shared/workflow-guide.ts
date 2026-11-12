import { z } from "zod";
import {
  relativeFile,
  stepIdSchema,
  stepSkillSchema,
  stepToolSchema,
  type DefinitionStep,
} from "./workflow-definition";

/**
 * Local guide: private per-step additions to a definition the app owns (or any
 * YAML definition). It can only point at documents, append instructions and name
 * skills/tools. It cannot add, remove or reorder steps or change kinds,
 * transitions, inputs, outputs or completion: those keys are not in the schema.
 */
export const guideStepSchema = z.strictObject({
  /** Documents to read, relative to the guide's base folder (see GuideSnapshot.base). */
  docs: z.array(relativeFile).max(30).default([]),
  instruction: z.string().trim().min(1).max(20000).optional(),
  skills: z.array(stepSkillSchema).max(20).default([]),
  tools: z.array(stepToolSchema).max(30).default([]),
});
export const workflowGuideSchema = z.strictObject({
  version: z.literal(1),
  /** Optional definition id this guide was written for; must match when given. */
  definition: stepIdSchema.optional(),
  steps: z.record(stepIdSchema, guideStepSchema),
});
export type WorkflowGuide = z.infer<typeof workflowGuideSchema>;
export type GuideStep = z.infer<typeof guideStepSchema>;

/** Stored with the run. Document contents are never copied: only their paths and hashes. */
export interface GuideSnapshot {
  /** Path as given at create. */
  file: string;
  sha256: string;
  source: string;
  /** Absolute folder the document paths are relative to. */
  base: string;
  steps: Record<
    string,
    Omit<GuideStep, "docs"> & {
      docs: { file: string; path: string; sha256: string }[];
    }
  >;
}

/** The step a session receives: built-in contract first, then the local guide. */
export function guidedStep(
  step: DefinitionStep,
  guide: GuideSnapshot | undefined,
): DefinitionStep {
  const local = guide?.steps[step.id];
  if (!local) return step;
  const lines = [`로컬 가이드 (${guide!.file}):`];
  if (local.instruction) lines.push(local.instruction);
  if (local.docs.length)
    lines.push("먼저 읽을 문서:", ...local.docs.map((d) => `- ${d.path}`));
  const tools = [...step.tools];
  for (const tool of local.tools)
    if (!tools.some((t) => t.server === tool.server && t.name === tool.name))
      tools.push(tool);
  return {
    ...step,
    instruction: `${step.instruction}\n\n${lines.join("\n")}`,
    skills: [...new Set([...step.skills, ...local.skills])],
    tools,
  };
}
