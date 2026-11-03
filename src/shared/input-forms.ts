import { z } from "zod";
import {
  experienceFormSchema,
  experienceAnswerSchema,
  type ExperienceRecord,
} from "./experience";
export const formIdInput = z.strictObject({ formId: z.string().uuid() });
export const createFormInput = z.strictObject({
  formId: z.string().uuid().optional(),
  workspace: z.string().min(1),
  projectId: z.string().max(160).default(""),
  form: experienceFormSchema,
  sourceFiles: z.array(z.string().min(1)).max(100).default([]),
});
export const listFormsInput = z.strictObject({
  projectId: z.string().max(160).optional(),
});
export const saveFormInput = z.strictObject({
  formId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  answers: z.array(experienceAnswerSchema).max(30),
  submit: z.boolean().default(false),
});
export const formMediaInput = z.strictObject({
  formId: z.string().uuid(),
  questionId: z.string().min(1),
  imageIndex: z.number().int().min(0).max(3),
});
export const applyFormInput = z.strictObject({
  formId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  summary: z.string().trim().min(1).max(10000),
  evidence: z.array(z.string().min(1)).min(1).max(100),
});
export const openFormInput = z.strictObject({
  formId: z.string().uuid(),
  surface: z.enum(["link", "desktop"]).default("link"),
});
export interface InputFormRecord extends ExperienceRecord {
  schemaVersion: 1;
  formId: string;
  workspace: string;
  projectId: string;
  registeredAt: string;
  workflowRunId?: string;
  creationHash?: string;
  submissionRevision?: number;
  applications: {
    at: string;
    submissionRevision: number;
    summary: string;
    evidence: Record<string, string>;
  }[];
}
export const inputFormActions = [
  "forms-list",
  "form-create",
  "form-get",
  "form-save",
  "form-media",
  "form-results",
  "form-apply",
  "form-open",
  "form-sync",
  "form-artifact",
  "form-wait",
] as const;
export type InputFormAction = (typeof inputFormActions)[number];

/** Stable machine output for either execution mode. Text is never normalized. */
export const formResultsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  formId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  submissionRevision: z.number().int().nonnegative().optional(),
  status: z.enum(["draft", "submitted"]),
  projectId: z.string(),
  workflowRunId: z.string().uuid().optional(),
  workspace: z.string(),
  title: z.string(),
  sourceFacts: experienceFormSchema.shape.facts,
  sourceHashes: z.record(z.string(), z.string()),
  responses: z.array(
    z.strictObject({
      questionId: z.string(),
      section: z.string(),
      prompt: z.string(),
      status: z.enum(["answered", "unknown", "omit", "unanswered"]),
      text: z.string(),
      images: experienceFormSchema.shape.questions.element.shape.images,
    }),
  ),
  exports: z.array(z.string()),
  applications: z.array(
    z.strictObject({
      at: z.string(),
      submissionRevision: z.number().int().nonnegative(),
      summary: z.string(),
      evidence: z.record(z.string(), z.string()),
    }),
  ),
});
export type InputFormResults = z.infer<typeof formResultsSchema>;
export const formArtifactInput = z.strictObject({
  formId: z.string().uuid(),
  path: z.string().min(1).max(1000),
});
export const waitFormInput = z.strictObject({
  formId: z.string().uuid(),
  afterRevision: z.number().int().min(-1),
  timeoutMs: z.number().int().min(0).max(60000).default(30000),
});
