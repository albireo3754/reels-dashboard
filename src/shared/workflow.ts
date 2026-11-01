import { z } from "zod";

export const workflowStages = [
  "prepare",
  "experience",
  "requests",
  "followup",
  "draft",
  "review",
  "revise",
  "layout",
  "visual_review",
] as const;
export type WorkflowStage = (typeof workflowStages)[number];
export const stageLabels: Record<WorkflowStage, string> = {
  prepare: "근거 준비",
  experience: "내 경험 채우기",
  requests: "답변 요청 분류",
  followup: "추가 작업",
  draft: "초안 작성",
  review: "문안 검토",
  revise: "문안 수정",
  layout: "화면 구성",
  visual_review: "화면 검토",
};
export const createWorkflowInput = z.strictObject({
  title: z.string().trim().min(1).max(200),
  workspace: z.string().min(1),
  instructions: z.string().trim().min(1).max(20000),
  trackedFiles: z.array(z.string().min(1)).min(1).max(100),
  collectExperience: z.boolean().default(false),
  maxRevisions: z.number().int().min(1).max(5).default(2),
});
export const submitWorkflowInput = z.strictObject({
  runId: z.string().uuid(),
  taskId: z.string().min(1),
  outcome: z.enum(["done", "pass", "revise", "blocked", "cancel"]),
  summary: z.string().trim().min(1).max(20000),
  evidence: z.array(z.string().min(1)).max(100).default([]),
});
export const workflowIdInput = z.strictObject({ runId: z.string().uuid() });
export const executeWorkflowInput = z.strictObject({
  runId: z.string().uuid(),
  taskId: z.string().min(1),
});
export const sdkJobIdInput = z.strictObject({ jobId: z.string().uuid() });
export const workflowAction = z.enum([
  "list",
  "get",
  "create",
  "submit",
  "restart",
  "execute",
  "stop",
  "job",
  "capabilities",
  "review-bundles",
  "review-markup",
  "experience-save",
  "experience-media",
  "followups-open",
]);
export type WorkflowAction = z.infer<typeof workflowAction>;
export interface WorkflowBridge {
  request(action: WorkflowAction, input?: unknown): Promise<any>;
}
export interface SdkJob {
  inputHash?: string;
  id: string;
  kind: "workflow" | "bundle-review";
  runId?: string;
  taskId?: string;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  createdAt: string;
  updatedAt: string;
  authModes: ("api-key" | "codex-login")[];
  events: { at: string; message: string }[];
  threadIds: string[];
  usage?: { input_tokens: number; output_tokens: number };
  role?: string;
  observation?: import("./ai-observation").AiObservation;
  error?: string;
  result?: unknown;
}
export interface WorkflowRecord {
  stage: WorkflowStage;
  taskId: string;
  outcome: z.infer<typeof submitWorkflowInput>["outcome"];
  summary: string;
  evidence: Record<string, string>;
  at: string;
}
export interface WorkflowTask {
  followupId?: string;
  taskId: string;
  stage: WorkflowStage;
  instruction: string;
  inputHashes: Record<string, string>;
}
export interface WorkflowRun {
  followups?: import("./followups").Followups;
  collectExperience?: boolean;
  experience?: import("./experience").ExperienceRecord;
  runId: string;
  title: string;
  workspace: string;
  instructions: string;
  trackedFiles: string[];
  maxRevisions: number;
  revisions: number;
  sequence: number;
  stage: WorkflowStage;
  status: "waiting" | "ready" | "blocked" | "cancelled";
  history: WorkflowRecord[];
  textApproval: Record<string, string>;
  layoutFiles: string[];
  task: WorkflowTask | null;
  checkpoint: string;
  execution?: SdkJob;
}
