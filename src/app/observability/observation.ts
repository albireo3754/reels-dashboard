import { randomUUID } from "node:crypto";
import type {
  AiAttempt,
  AiObservation,
  AiUsage,
} from "../../shared/ai-observation";
import { estimateCost, StaticPriceCatalog, type PriceCatalog } from "./pricing";

export interface ObservationSpan {
  traceId: string;
  spanId: string;
  finish(attempt: AiAttempt): void;
}
export interface ObservationSink {
  start(
    attempt: AiAttempt,
    correlation: { jobId: string; runId?: string; taskId?: string },
  ): ObservationSpan;
  close?(): Promise<void>;
}
export interface AttemptMetadata {
  auth: AiAttempt["auth"];
  provider: string;
  agent: string;
  role: string;
  instructionHash: string;
  requestedModel?: string;
  requestedReasoning?: string;
}
/** Provider-independent lifecycle, pricing and export seam; local data remains authoritative. */
export class ObservationRecorder {
  constructor(
    readonly catalog: PriceCatalog = new StaticPriceCatalog(),
    private sink?: ObservationSink,
  ) {}
  begin(
    observation: AiObservation,
    meta: AttemptMetadata,
    correlation: { jobId: string; runId?: string; taskId?: string },
    changed: () => void,
  ) {
    const start = Date.now();
    const record: AiAttempt = {
      ...meta,
      id: randomUUID(),
      ordinal: observation.attempts.length + 1,
      requestedModel: meta.requestedModel ?? null,
      requestedReasoning: meta.requestedReasoning ?? null,
      runtimeModels: [],
      responseModel: null,
      runtimeReasoning: null,
      runtimeVersion: null,
      modelSource: null,
      threadId: null,
      startedAt: new Date(start).toISOString(),
      endedAt: null,
      durationMs: null,
      status: "running",
      usage: null,
      cost: { status: "unknown", usd: null, reason: "attempt-in-progress" },
      traceId: null,
      spanId: null,
      warnings: [],
    };
    observation.attempts.push(record);
    let span: ObservationSpan | undefined;
    try {
      span = this.sink?.start(record, correlation);
      if (span) {
        record.traceId = span.traceId;
        record.spanId = span.spanId;
      }
    } catch {
      record.warnings.push("trace-start-failed");
    }
    changed();
    return {
      record,
      usage: (usage: AiUsage) => {
        record.usage = usage;
        changed();
      },
      changed,
      finish: (
        status: Exclude<AiAttempt["status"], "running">,
        failureType?: string,
      ) => {
        if (record.status !== "running") return;
        record.status = status;
        record.endedAt = new Date().toISOString();
        record.durationMs = Math.max(0, Date.now() - start);
        record.failureType = failureType;
        try {
          record.cost = estimateCost(record, this.catalog);
        } catch {
          record.cost = {
            status: "unknown",
            usd: null,
            reason: "pricing-unavailable",
          };
          record.warnings.push("pricing-failed");
        }
        try {
          span?.finish(record);
        } catch {
          record.warnings.push("trace-finish-failed");
        }
        changed();
      },
    };
  }
}
