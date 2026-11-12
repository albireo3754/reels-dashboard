import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  experienceAnswerSchema,
  experienceFormSchema,
  type ExperienceForm,
} from "../../shared/experience";
import {
  mediaScenesSchema,
  storyMediaPlanSchema,
  validateSceneCoverage,
} from "../../shared/story-media";
import type {
  DefinitionStep,
  WorkflowDefinition,
} from "../../shared/workflow-definition";
import { resolveFile } from "./files";
import { mediaSceneInputs } from "./story-media";

/** Existing outputs that let a step be skipped, with the reason recorded in history. */
export interface Adoption {
  reason: string;
  evidence: string[];
}

const submittedAnswers = z.object({
  version: z.literal(1),
  status: z.literal("submitted"),
  form: experienceFormSchema,
  answers: z.array(experienceAnswerSchema),
  exports: z.array(z.string()).min(1),
  updatedAt: z.string(),
});
type SubmittedAnswers = z.infer<typeof submittedAnswers> & { file: string };

async function readJson(workspace: string, file: string, limit = 2_000_000) {
  const resolved = await resolveFile(workspace, file);
  if ((await stat(resolved)).size > limit) throw new Error("File too large");
  return JSON.parse(await readFile(resolved, "utf8"));
}

/** Submitted form exports in the workspace root, newest first. Unreadable files are ignored. */
export async function submittedAnswerExports(workspace: string) {
  const names = (await readdir(workspace))
    .filter((name) => /^experience-answers-[\w-]+\.json$/.test(name))
    .slice(0, 200);
  const found: SubmittedAnswers[] = [];
  for (const name of names) {
    try {
      const parsed = submittedAnswers.parse(await readJson(workspace, name));
      if (!parsed.exports.includes(name)) continue;
      for (const file of parsed.exports) await resolveFile(workspace, file);
      found.push({ ...parsed, file: name });
    } catch {
      // Not a submitted export of the shared form service.
    }
  }
  return found.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Every question in `form` has a recorded answer (answered/unknown/omit) for the same prompt. */
export function answersCover(form: ExperienceForm, record: SubmittedAnswers) {
  return form.questions.every((q) => {
    const asked = record.form.questions.find((p) => p.id === q.id);
    const answer = record.answers.find((a) => a.questionId === q.id);
    return (
      asked?.prompt === q.prompt &&
      !!answer &&
      (answer.status !== "answered" || !!answer.text.trim())
    );
  });
}

async function coveringAnswers(workspace: string, form?: ExperienceForm) {
  const records = await submittedAnswerExports(workspace);
  return form ? records.find((r) => answersCover(form, r)) : records[0];
}

async function readForm(workspace: string, file: string) {
  try {
    return experienceFormSchema.parse(await readJson(workspace, file, 200000));
  } catch {
    return undefined;
  }
}

/**
 * Input step: skip when one submitted answers export covers every question of the
 * current form file. Without a form file, only `allowWithoutForm` (the leading,
 * not-yet-worked part of a new run) accepts the latest submitted answers.
 */
export async function adoptInput(
  workspace: string,
  step: DefinitionStep,
  allowWithoutForm: boolean,
): Promise<Adoption | undefined> {
  const form = await readForm(workspace, step.formFile!);
  if (!form && !allowWithoutForm) return;
  const record = await coveringAnswers(workspace, form);
  if (!record) return;
  return {
    reason: form
      ? `제출된 답변(${record.file})이 ${step.formFile}의 질문 ${form.questions.length}개를 모두 덮어 입력 단계를 넘어갔어요.`
      : `${step.formFile}이 없고 제출된 답변(${record.file})이 있어 입력 단계를 넘어갔어요.`,
    evidence: record.exports,
  };
}

/** Validate one existing output; returns the evidence files it contributes. */
async function adoptOutput(
  workspace: string,
  file: string,
  formFile: string | undefined,
  notes: string[],
): Promise<string[]> {
  const name = path.basename(file);
  if (file === formFile) {
    if (await readForm(workspace, file)) return [file];
    const answers = await coveringAnswers(workspace);
    if (answers) {
      notes.push(`${file} 대신 제출된 답변 ${answers.file}`);
      return answers.exports;
    }
    throw new Error(`${file}: no valid form or submitted answers`);
  }
  if (name === "media-scenes.json") {
    const previews = await mediaSceneInputs(workspace, [file]);
    return [file, ...previews];
  }
  if (name === "story-media-plan.json") {
    const plan = storyMediaPlanSchema.parse(await readJson(workspace, file));
    const inventory = mediaScenesSchema.parse(
      await readJson(workspace, plan.inventory),
    );
    validateSceneCoverage(inventory, plan);
    return [file, plan.inventory];
  }
  const resolved = await resolveFile(workspace, file);
  if (!(await stat(resolved)).size) throw new Error(`${file}: empty`);
  return [file];
}

/**
 * Task step: skip when every declared input and output already exists and the known
 * outputs validate. Per-attempt outputs and the step that would complete the run are
 * never adopted. Reviews are never adopted (callers do not pass them here).
 */
export async function adoptTask(
  workspace: string,
  definition: WorkflowDefinition,
  step: DefinitionStep,
): Promise<Adoption | undefined> {
  if (
    step.kind !== "task" ||
    step.on.done === "$complete" ||
    step.outputs.some((file) => file.includes("{attempt}"))
  )
    return;
  const formFile = definition.steps.find((s) => s.kind === "input")?.formFile;
  try {
    for (const file of step.inputs) await resolveFile(workspace, file);
    const evidence: string[] = [];
    const notes: string[] = [];
    for (const file of step.outputs)
      evidence.push(...(await adoptOutput(workspace, file, formFile, notes)));
    return {
      reason:
        `선언된 산출물(${step.outputs.join(", ")})이 이미 있고 검증을 통과해 이 단계를 넘어갔어요.` +
        (notes.length ? ` (${notes.join("; ")})` : ""),
      evidence: [...new Set(evidence)],
    };
  } catch {
    return;
  }
}

/**
 * Dry run for a new run: the leading steps that would be skipped from `entry`.
 * Later input steps can still be skipped mid-run once their form file exists.
 */
export async function previewAdoption(
  workspace: string,
  definition: WorkflowDefinition,
) {
  const skipped: ({ stepId: string } & Adoption)[] = [];
  let step = definition.steps.find((s) => s.id === definition.entry);
  while (step && step.kind !== "review" && step.on.done !== "$complete") {
    const adopt =
      step.kind === "input"
        ? await adoptInput(workspace, step, true)
        : await adoptTask(workspace, definition, step);
    if (!adopt) break;
    skipped.push({ stepId: step.id, ...adopt });
    const next = step.on.done;
    step = definition.steps.find((s) => s.id === next);
  }
  return { skipped, startsAt: step?.id };
}
