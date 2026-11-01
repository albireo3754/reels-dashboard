import { createHash } from "node:crypto";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { AiObservation } from "../../shared/ai-observation";
import { ObservationRecorder, type AttemptMetadata } from "./observation";
import {
  openCodexProbe,
  type CodexProbeFactory,
  type CodexProbe,
} from "./codex-probe";

export type CodexObservationInput = Omit<
  AttemptMetadata,
  "instructionHash" | "provider" | "agent"
> & {
  jobId: string;
  runId?: string;
  taskId?: string;
  prompt: string;
  observation: AiObservation;
  changed(): void;
};
export interface CodexObservationPort {
  begin(input: CodexObservationInput): Promise<{
    configOverrides: string[];
    event(event: ThreadEvent): void;
    finish(
      status: "completed" | "failed" | "cancelled",
      failureType?: string,
    ): Promise<void>;
  }>;
}

/** All Codex-specific events and runtime telemetry are translated here, outside workflow execution. */
export class CodexObserver implements CodexObservationPort {
  constructor(
    private recorder = new ObservationRecorder(),
    private probeFactory: CodexProbeFactory = openCodexProbe,
  ) {}
  async begin(input: CodexObservationInput) {
    const attempt = this.recorder.begin(
      input.observation,
      {
        auth: input.auth,
        provider: "openai",
        agent: "codex",
        role: input.role,
        requestedModel: input.requestedModel,
        requestedReasoning: input.requestedReasoning,
        instructionHash: createHash("sha256")
          .update(input.prompt)
          .digest("hex"),
      },
      { jobId: input.jobId, runId: input.runId, taskId: input.taskId },
      input.changed,
    );
    let probe: CodexProbe | undefined;
    try {
      probe = await this.probeFactory(attempt.record, input.changed);
    } catch {
      attempt.record.warnings.push("runtime-metadata-probe-unavailable");
      input.changed();
    }
    const count = (value: unknown): number | null =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= 0
        ? value
        : null;
    return {
      configOverrides: probe?.configOverrides ?? [],
      event: (event: ThreadEvent) => {
        if (event.type === "thread.started") {
          attempt.record.threadId = event.thread_id;
          input.changed();
        }
        if (event.type === "turn.completed") {
          const usage = event.usage;
          attempt.usage({
            input: count(usage.input_tokens),
            cachedInput: count(usage.cached_input_tokens),
            cacheWriteInput: count(usage.cache_write_input_tokens),
            output: count(usage.output_tokens),
            reasoningOutput: count(usage.reasoning_output_tokens),
            source: "sdk-turn-completed",
          });
        }
      },
      finish: async (
        status: "completed" | "failed" | "cancelled",
        failureType?: string,
      ) => {
        // CLI flushes native OTel on exit; SDK's event iterator drains before this closes the probe.
        try {
          await probe?.close();
        } catch {
          attempt.record.warnings.push("runtime-metadata-close-failed");
        }
        attempt.finish(status, failureType);
      },
    };
  }
}
