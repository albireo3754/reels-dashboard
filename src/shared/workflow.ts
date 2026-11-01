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
/** GET actions on the workflow server; every other action is a JSON POST. */
export const readOnlyWorkflowActions: readonly WorkflowAction[] = [
  "list",
  "get",
  "job",
  "capabilities",
];
export const isReadOnlyWorkflowAction = (action: WorkflowAction) =>
  readOnlyWorkflowActions.includes(action);
/** Server path for an action, shared by the browser and Node clients. */
export function workflowEndpoint(action: WorkflowAction, input: any = {}) {
  const base = "/api/workflows";
  if (action === "get")
    return `${base}/run?id=${encodeURIComponent(input.runId)}`;
  if (action === "job")
    return `${base}/job?id=${encodeURIComponent(input.jobId)}`;
  return action === "list" ? base : `${base}/${action}`;
}
export function workflowFetchInit(
  action: WorkflowAction,
  input: unknown = {},
): RequestInit {
  return isReadOnlyWorkflowAction(action)
    ? {}
    : {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      };
}
export const runStatusLabels: Record<WorkflowRun["status"], string> = {
  waiting: "작업 대기",
  ready: "검토 완료",
  blocked: "보류",
  cancelled: "취소",
};
export const isReviewStage = (stage: WorkflowStage) =>
  stage === "review" || stage === "visual_review";
/** Stages where submitted answers can be re-checked for follow-up requests. */
export const followupReopenStages: readonly WorkflowStage[] = [
  "draft",
  "review",
  "revise",
  "layout",
  "visual_review",
];
export const canReopenFollowups = (run: WorkflowRun) =>
  run.status === "waiting" &&
  followupReopenStages.includes(run.stage) &&
  run.experience?.status === "submitted";
export const currentFollowup = (run: WorkflowRun) =>
  run.followups?.tasks.find((t) => t.id === run.task?.followupId);
/** A follow-up assigned to the production session; the SDK must not run it. */
export const requiresSessionWork = (run: WorkflowRun) =>
  run.stage === "followup" && currentFollowup(run)?.executor === "session";
/** Stages shown as progress; revise folds into draft, intake stages only when collecting experience. */
export const visibleStages = (run: Pick<WorkflowRun, "collectExperience">) =>
  workflowStages.filter(
    (s) =>
      s !== "revise" &&
      (!["experience", "requests", "followup"].includes(s) ||
        run.collectExperience),
  );
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
