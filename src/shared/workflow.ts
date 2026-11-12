import { inputFormActions } from "./input-forms";
import { z } from "zod";
import {
  builtinDefinitionName,
  definitionPath,
  type DefinitionSnapshot,
  type DefinitionStep,
} from "./workflow-definition";
import type { GuideSnapshot } from "./workflow-guide";

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
  definitionFile: z.string().min(1).optional(),
  /** App-owned definition by name, instead of definitionFile. */
  builtinDefinition: builtinDefinitionName.optional(),
  /** Local guide file adding documents/instructions/skills per step (YAML runs). */
  guideFile: definitionPath.optional(),
  projectId: z.string().trim().min(1).max(200).optional(),
  title: z.string().trim().min(1).max(200),
  workspace: z.string().min(1),
  instructions: z.string().trim().min(1).max(20000),
  trackedFiles: z.array(z.string().min(1)).min(1).max(100),
  inputFormId: z.string().uuid().optional(),
  collectExperience: z.boolean().default(false),
  maxRevisions: z.number().int().min(1).max(5).default(2),
  /** YAML runs: skip steps whose outputs already exist and validate (reviews never skip). */
  skipCompleted: z.boolean().default(true),
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
  ...inputFormActions,
  "list",
  "get",
  "create",
  "submit",
  "restart",
  "execute",
  "stop",
  "job",
  "capabilities",
  "validate-definition",
  "context",
  "review-bundles",
  "review-markup",
  "suggest-inline",
  "chat-blog",
  "experience-save",
  "experience-media",
  "followups-open",
]);
export type WorkflowAction = z.infer<typeof workflowAction>;
/**
 * Workflow server protocol version, reported as `capabilities.server.protocol`.
 * Bump it whenever a handler's request/response semantics change, even if
 * `workflowAction` stays the same, so a long-running standalone server with older
 * handler code is reported as stale instead of being reused. Dev and installed
 * builds of the same protocol share one server and data dir by design.
 */
export const WORKFLOW_PROTOCOL_VERSION = 7;
/** Shown when the server answering the workflow URL predates this app's actions. */
export const STALE_WORKFLOW_SERVER_MESSAGE =
  "실행 중인 워크플로 서버가 이전 버전이에요. 따로 실행한 서버(npm run start:server)를 종료한 뒤 앱을 다시 시작해주세요.";
/** Shown when the server answering the workflow URL speaks a newer protocol than this app. */
export const NEWER_WORKFLOW_SERVER_MESSAGE =
  "실행 중인 워크플로 서버가 이 앱보다 새 버전이에요. 앱을 업데이트하거나 그 서버(다른 앱 또는 npm run start:server)를 종료한 뒤 앱을 다시 시작해주세요.";
/**
 * How the desktop app reaches the workflow server: started in-process (embedded),
 * reused from another compatible app/server (shared), pinned by REELS_WORKFLOW_URL
 * (external), or unusable (stale/error).
 */
export interface WorkflowHostStatus {
  state: "external" | "embedded" | "shared" | "stale" | "error";
  url: string;
  message?: string;
}
/** GET actions on the workflow server; every other action is a JSON POST. */
export const readOnlyWorkflowActions: readonly WorkflowAction[] = [
  "list",
  "get",
  "job",
  "capabilities",
  "context",
];
export const isReadOnlyWorkflowAction = (action: WorkflowAction) =>
  readOnlyWorkflowActions.includes(action);
/** Server path for an action, shared by the browser and Node clients. */
export function workflowEndpoint(action: WorkflowAction, input: any = {}) {
  const base = "/api/workflows";
  if (action === "get")
    return `${base}/run?id=${encodeURIComponent(input.runId)}`;
  if (action === "context")
    return `${base}/context?id=${encodeURIComponent(input.runId)}`;
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
  !run.definition &&
  run.status === "waiting" &&
  followupReopenStages.includes(run.stage) &&
  run.experience?.status === "submitted";
export const currentFollowup = (run: WorkflowRun) =>
  run.followups?.tasks.find((t) => t.id === run.task?.followupId);
/** A follow-up assigned to the production session; the SDK must not run it. */
export const requiresSessionWork = (run: WorkflowRun) =>
  !!run.definition ||
  (run.stage === "followup" && currentFollowup(run)?.executor === "session");
export const workflowStepLabel = (
  run: WorkflowRun,
  stepId = run.stepId,
  stage = run.stage,
) =>
  run.definition?.definition.steps.find((s) => s.id === stepId)?.title ??
  stageLabels[stage];
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
  onOpen?(callback: (runId: string) => void): () => void;
  hostStatus?(): Promise<WorkflowHostStatus>;
}
export interface SdkJob {
  inputHash?: string;
  id: string;
  kind: "workflow" | "bundle-review" | "inline-suggest" | "blog-chat";
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
  stepId?: string;
  stage: WorkflowStage;
  taskId: string;
  /** `skipped`: existing outputs were adopted instead of running the step. */
  outcome: z.infer<typeof submitWorkflowInput>["outcome"] | "skipped";
  summary: string;
  evidence: Record<string, string>;
  at: string;
}
export interface WorkflowTask {
  step?: DefinitionStep;
  followupId?: string;
  taskId: string;
  stage: WorkflowStage;
  instruction: string;
  inputHashes: Record<string, string>;
  /** Existing outputs found for this step; the runtime advances past it without a worker. */
  adopt?: { reason: string; evidence: string[] };
}
export interface WorkflowRun {
  blockedReason?: string;
  definition?: DefinitionSnapshot;
  definitionFile?: string;
  builtinDefinition?: import("./workflow-definition").BuiltinDefinitionName;
  /** Local guide frozen at create; merged into each task after the definition's text. */
  guide?: GuideSnapshot;
  guideFile?: string;
  stepId?: string;
  projectId?: string;
  followups?: import("./followups").Followups;
  collectExperience?: boolean;
  skipCompleted?: boolean;
  inputFormId?: string;
  experience?: import("./input-forms").InputFormRecord;
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
