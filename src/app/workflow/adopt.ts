import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isMissing } from "../../shared/lib/fs";
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
import { checkedImage, hashes, readWorkspaceJson, resolveFile } from "./files";
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

const readJson = (workspace: string, file: string, limit = 2_000_000) =>
  readWorkspaceJson(workspace, file, limit, "File too large");

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

type FormState =
  | { state: "missing" }
  | { state: "invalid" }
  | { state: "ok"; form: ExperienceForm; evidence: string[] };

/**
 * Only a form file that does not exist counts as absent. A file that exists but is
 * unreadable, oversized, escapes the workspace or fails the schema is `invalid` and
 * blocks skipping. A valid form contributes itself and its question images.
 */
async function readForm(workspace: string, file: string): Promise<FormState> {
  try {
    await lstat(path.join(workspace, file));
  } catch (error) {
    if (isMissing(error)) return { state: "missing" };
    return { state: "invalid" };
  }
  try {
    const form = experienceFormSchema.parse(
      await readJson(workspace, file, 200000),
    );
    const images = form.questions.flatMap((q) => q.images.map((i) => i.path));
    for (const image of images) await checkedImage(workspace, image);
    return { state: "ok", form, evidence: [file, ...new Set(images)] };
  } catch {
    return { state: "invalid" };
  }
}

/**
 * Input step: skip when one submitted answers export covers every question of the
 * current form file. Without a form file, only `allowWithoutForm` (the leading,
 * not-yet-worked part of a new run) accepts the latest submitted answers.
 */
async function adoptInput(
  workspace: string,
  step: DefinitionStep,
  allowWithoutForm: boolean,
): Promise<Adoption | undefined> {
  const current = await readForm(workspace, step.formFile!);
  if (current.state === "invalid") return;
  if (current.state === "missing" && !allowWithoutForm) return;
  const form = current.state === "ok" ? current.form : undefined;
  const record = await coveringAnswers(workspace, form);
  if (!record) return;
  const evidence = [
    ...new Set([
      ...record.exports,
      ...(current.state === "ok" ? current.evidence : []),
    ]),
  ];
  // The run hashes the evidence when it records the skip; unreadable files run the step.
  if (!(await filesExist(workspace, evidence))) return;
  return {
    reason: form
      ? `제출된 답변(${record.file})이 ${step.formFile}의 질문 ${form.questions.length}개를 모두 덮어 입력 단계를 넘어갔어요.`
      : `${step.formFile}이 없고 제출된 답변(${record.file})이 있어 입력 단계를 넘어갔어요.`,
    evidence,
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
    const current = await readForm(workspace, file);
    if (current.state === "ok") return current.evidence;
    if (current.state === "invalid")
      throw new Error(`${file}: invalid form`);
    const answers = await coveringAnswers(workspace);
    if (answers) {
      notes.push(`${file} 대신 제출된 답변 ${answers.file}`);
      return answers.exports;
    }
    throw new Error(`${file}: no form or submitted answers`);
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

/** Task step: every declared output exists and the known outputs validate. */
async function adoptTask(
  workspace: string,
  definition: WorkflowDefinition,
  step: DefinitionStep,
): Promise<Adoption | undefined> {
  const formFile = definition.steps.find((s) => s.kind === "input")?.formFile;
  try {
    const evidence: string[] = [];
    const notes: string[] = [];
    for (const file of step.outputs)
      evidence.push(...(await adoptOutput(workspace, file, formFile, notes)));
    // The run hashes the evidence when it records the skip; unreadable files run the step.
    await hashes(workspace, [...new Set(evidence)]);
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

/** Exists inside the workspace and can actually be read (hashed), as a request will. */
async function filesExist(workspace: string, files: string[]) {
  try {
    await hashes(workspace, files);
    return true;
  } catch {
    return false;
  }
}

/**
 * The single skip rule shared by the runtime and the dry-run preview.
 * `step` is the declared step (`{attempt}` not expanded). `leading`: nothing in the
 * run has been worked yet. `visited`: the run already has a record for this step.
 * Never: reviews, `{attempt}` outputs, `done → $complete`, revisits, missing own or
 * next-step inputs. Task steps only while leading.
 */
export async function adoptStep(
  workspace: string,
  definition: WorkflowDefinition,
  step: DefinitionStep,
  context: { leading: boolean; visited: boolean },
): Promise<Adoption | undefined> {
  if (
    context.visited ||
    step.kind === "review" ||
    step.on.done === "$complete" ||
    step.outputs.some((file) => file.includes("{attempt}")) ||
    (step.kind === "task" && !context.leading)
  )
    return;
  const next = definition.steps.find((s) => s.id === step.on.done);
  if (
    !(await filesExist(workspace, step.inputs)) ||
    !(await filesExist(workspace, next?.inputs ?? []))
  )
    return;
  return step.kind === "input"
    ? adoptInput(workspace, step, context.leading)
    : adoptTask(workspace, definition, step);
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
  while (step) {
    const adopt = await adoptStep(workspace, definition, step, {
      leading: true,
      visited: skipped.some((s) => s.stepId === step!.id),
    });
    if (!adopt) break;
    skipped.push({ stepId: step.id, ...adopt });
    const next = step.on.done;
    step = definition.steps.find((s) => s.id === next);
  }
  return { skipped, startsAt: step?.id };
}
