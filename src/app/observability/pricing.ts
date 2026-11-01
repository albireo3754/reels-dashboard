import type { AiAttempt, AiCost } from "../../shared/ai-observation";
export interface ModelRate {
  id: string;
  provider: string;
  model: string;
  validFrom: string;
  validUntil: string;
  source: string;
  usdPerMillion: {
    input: number;
    cachedInput: number;
    output: number;
    cacheWriteInput?: number;
  };
}
export interface PriceCatalog {
  find(provider: string, model: string, at: string): ModelRate | undefined;
}
export class StaticPriceCatalog implements PriceCatalog {
  constructor(private rates: ModelRate[] = []) {
    for (const rate of rates) {
      if (
        !rate.id ||
        !rate.provider ||
        !rate.model ||
        !/^https?:\/\//.test(rate.source) ||
        !Number.isFinite(Date.parse(rate.validFrom)) ||
        !(Date.parse(rate.validUntil) > Date.parse(rate.validFrom)) ||
        ![
          rate.usdPerMillion?.input,
          rate.usdPerMillion?.cachedInput,
          rate.usdPerMillion?.output,
        ].every((n) => Number.isFinite(n) && n >= 0) ||
        (rate.usdPerMillion.cacheWriteInput !== undefined &&
          !(
            Number.isFinite(rate.usdPerMillion.cacheWriteInput) &&
            rate.usdPerMillion.cacheWriteInput >= 0
          ))
      )
        throw new Error("Invalid model pricing record");
    }
  }
  find(provider: string, model: string, at: string) {
    const matches = this.rates.filter(
      (rate) =>
        rate.provider === provider &&
        rate.model === model &&
        Date.parse(rate.validFrom) <= Date.parse(at) &&
        Date.parse(at) < Date.parse(rate.validUntil),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
}
export function estimateCost(
  attempt: AiAttempt,
  catalog: PriceCatalog,
): AiCost {
  if (attempt.auth === "codex-login")
    return {
      status: "not-applicable",
      usd: null,
      reason: "subscription-auth-not-api-billing",
    };
  const unknown = (reason: string): AiCost => ({
    status: "unknown",
    usd: null,
    reason,
  });
  const usage = attempt.usage;
  if (
    !usage ||
    [usage.input, usage.cachedInput, usage.cacheWriteInput, usage.output].some(
      (v) => v === null,
    )
  )
    return unknown("usage-unavailable");
  if (
    attempt.runtimeModels.length > 1 ||
    attempt.warnings.includes("multiple-response-models")
  )
    return unknown("multiple-runtime-models");
  const model =
    attempt.responseModel ??
    (attempt.runtimeModels.length === 1 ? attempt.runtimeModels[0] : null);
  if (!model)
    return unknown(
      attempt.runtimeModels.length > 1
        ? "multiple-runtime-models"
        : "model-unconfirmed",
    );
  const rate = catalog.find(attempt.provider, model, attempt.startedAt);
  if (!rate) return unknown("no-unambiguous-current-rate");
  const uncached = usage.input! - usage.cachedInput! - usage.cacheWriteInput!;
  if (
    uncached < 0 ||
    (usage.reasoningOutput !== null && usage.reasoningOutput > usage.output!)
  )
    return unknown("inconsistent-usage");
  if (
    usage.cacheWriteInput! > 0 &&
    rate.usdPerMillion.cacheWriteInput === undefined
  )
    return unknown("cache-write-rate-unavailable");
  // Cached input is a subset of input; reasoning output is a subset of output. Never count twice.
  const usd =
    (uncached * rate.usdPerMillion.input +
      usage.cachedInput! * rate.usdPerMillion.cachedInput +
      usage.cacheWriteInput! * (rate.usdPerMillion.cacheWriteInput ?? 0) +
      usage.output! * rate.usdPerMillion.output) /
    1e6;
  return {
    status: "estimated",
    usd,
    rateId: rate.id,
    rateSource: rate.source,
    rateValidFrom: rate.validFrom,
    rateValidUntil: rate.validUntil,
    modelBasis: model,
    usdPerMillion: { ...rate.usdPerMillion },
  };
}
