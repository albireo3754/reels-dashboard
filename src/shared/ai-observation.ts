/** Serializable application contract. No Codex, LangGraph, pricing vendor or OTel imports. */
export interface AiUsage {
  input: number | null;
  cachedInput: number | null;
  cacheWriteInput: number | null;
  output: number | null;
  reasoningOutput: number | null;
  source: "sdk-turn-completed";
}
export interface AiCost {
  status: "estimated" | "unknown" | "not-applicable";
  usd: number | null;
  reason?: string;
  rateId?: string;
  rateSource?: string;
  rateValidFrom?: string;
  rateValidUntil?: string;
  modelBasis?: string;
  usdPerMillion?: {
    input: number;
    cachedInput: number;
    output: number;
    cacheWriteInput?: number;
  };
}
export interface AiAttempt {
  id: string;
  ordinal: number;
  auth: "api-key" | "codex-login";
  provider: string;
  agent: string;
  role: string;
  instructionHash: string;
  requestedModel: string | null;
  requestedReasoning: string | null;
  runtimeModels: string[];
  responseModel: string | null;
  runtimeReasoning: string | null;
  runtimeVersion: string | null;
  modelSource: "codex-otel" | null;
  threadId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  failureType?: string;
  usage: AiUsage | null;
  cost: AiCost;
  traceId: string | null;
  spanId: string | null;
  warnings: string[];
}
export interface AiObservation {
  version: 1;
  attempts: AiAttempt[];
}
