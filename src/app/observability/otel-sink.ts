import { SpanKind, SpanStatusCode, type Attributes } from "@opentelemetry/api";
import {
  TracerProvider,
  BatchSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { AiAttempt } from "../../shared/ai-observation";
import type { ObservationSink } from "./observation";

/** Standard OTel SDK adapter; no global provider registration and no vendor-specific runtime dependency. */
export class OtelObservationSink implements ObservationSink {
  readonly provider: TracerProvider;
  constructor(
    exporter?: SpanExporter,
    private projection?: (attempt: AiAttempt) => Attributes,
  ) {
    this.provider = new TracerProvider({
      resource: resourceFromAttributes({
        "service.name": "reels-workflow",
        "service.version": "0.1.0",
      }),
      spanProcessors: exporter
        ? [
            new BatchSpanProcessor({
              exporter,
              scheduledDelayMillis: 1000,
              exportTimeoutMillis: 3000,
            }),
          ]
        : [],
    });
  }
  start(
    attempt: AiAttempt,
    correlation: { jobId: string; runId?: string; taskId?: string },
  ) {
    const tracer = this.provider.getTracer("reels-ai-observation", "1");
    const attributes: Attributes = {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": attempt.provider,
      "gen_ai.agent.name": attempt.agent,
      "reels.agent.role": attempt.role,
      "reels.job.id": correlation.jobId,
      "reels.attempt.id": attempt.id,
      "reels.attempt.ordinal": attempt.ordinal,
      "reels.auth.mode": attempt.auth,
      "reels.instructions.sha256": attempt.instructionHash,
    };
    if (attempt.requestedModel)
      attributes["gen_ai.request.model"] = attempt.requestedModel;
    if (correlation.runId) attributes["reels.workflow.id"] = correlation.runId;
    if (correlation.taskId) attributes["reels.task.id"] = correlation.taskId;
    const span = tracer.startSpan(`invoke_agent ${attempt.agent}`, {
      kind: SpanKind.INTERNAL,
      attributes,
    });
    return {
      ...span.spanContext(),
      finish: (record: AiAttempt) => {
        const values: Attributes = {
          "reels.attempt.status": record.status,
          "reels.cost.status": record.cost.status,
          "reels.runtime.models": record.runtimeModels,
        };
        if (record.responseModel)
          values["gen_ai.response.model"] = record.responseModel;
        if (!record.requestedModel && record.runtimeModels.length === 1)
          values["gen_ai.request.model"] = record.runtimeModels[0];
        if (record.runtimeReasoning)
          values["reels.runtime.reasoning_effort"] = record.runtimeReasoning;
        if (record.runtimeVersion)
          values["reels.runtime.version"] = record.runtimeVersion;
        if (record.threadId) values["gen_ai.conversation.id"] = record.threadId;
        for (const [key, value] of Object.entries({
          "gen_ai.usage.input_tokens": record.usage?.input,
          "gen_ai.usage.output_tokens": record.usage?.output,
          "gen_ai.usage.cache_read.input_tokens": record.usage?.cachedInput,
          "gen_ai.usage.cache_creation.input_tokens":
            record.usage?.cacheWriteInput,
          "gen_ai.usage.reasoning.output_tokens": record.usage?.reasoningOutput,
        }))
          if (typeof value === "number") values[key] = value;
        if (record.cost.usd !== null)
          values["reels.cost.estimated_usd"] = record.cost.usd;
        if (record.cost.rateId)
          values["reels.cost.rate_id"] = record.cost.rateId;
        if (record.failureType) values["error.type"] = record.failureType;
        if (this.projection) Object.assign(values, this.projection(record));
        span.setAttributes(values);
        span.setStatus({
          code:
            record.status === "completed"
              ? SpanStatusCode.OK
              : SpanStatusCode.ERROR,
        });
        span.end();
      },
    };
  }
  async close() {
    await this.provider.shutdown();
  }
}
