import type { AiAttempt } from "../../shared/ai-observation";

/** Optional vendor mapping only. No Langfuse SDK, network, credentials or workflow imports. */
export function langfuseAttributes(attempt: AiAttempt): Record<string, string> {
  const model =
    attempt.responseModel ??
    (attempt.runtimeModels.length === 1 ? attempt.runtimeModels[0] : null);
  const generation =
    attempt.auth === "api-key" &&
    model &&
    attempt.runtimeModels.length <= 1 &&
    !attempt.warnings.includes("multiple-response-models");
  const values: Record<string, string> = {
    "langfuse.observation.type": generation ? "generation" : "agent",
    "langfuse.observation.metadata.auth_mode": attempt.auth,
    "langfuse.observation.metadata.role": attempt.role,
    "langfuse.observation.metadata.cost_status": attempt.cost.status,
  };
  if (generation && model) values["langfuse.observation.model.name"] = model;
  // Login/subscription spans stay agents so a public API price is never presented as their bill.
  if (generation && attempt.cost.status === "estimated")
    values["langfuse.observation.cost_details"] = JSON.stringify({
      total: attempt.cost.usd,
    });
  return values;
}
