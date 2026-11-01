# AI execution observability

Execution telemetry uses the official OpenTelemetry JS SDK and Codex's native OTLP log export. It is not coupled to LangGraph, Electron, a hosted tracing account, or an API credential. Existing job JSON in the local SQLite store remains authoritative; external export is opt-in.

## Boundaries

| Layer | File | Dependencies |
| --- | --- | --- |
| Serializable data contract | `src/shared/ai-observation.ts` | None |
| Attempt lifecycle and optional sink | `src/app/observability/observation.ts` | Application types, Node crypto |
| Price catalog and arithmetic | `src/app/observability/pricing.ts` | Application types only |
| SDK event/native metadata translation | `codex-observer.ts`, `codex-probe.ts` | Codex event types, loopback HTTP |
| Standard trace export | `otel-sink.ts` | Official OTel API, trace SDK and resources |
| Optional Langfuse projection | `langfuse-projection.ts` | Application types only; no Langfuse SDK |
| Configuration/composition | `configure.ts` | Wires adapters; reads explicit server configuration |
| Workflow integration | `codex-executor.ts` | Injected `CodexObservationPort`; no OTel/vendor imports |
| Shared UI | `AiUsageDetails.tsx` | Serializable contract only |

`ObservationSink` and `PriceCatalog` are replaceable interfaces. `CodexObservationPort` keeps provider-specific instrumentation outside execution logic. No global tracer provider is registered, so this does not replace another application's instrumentation. The OTel package versions are pinned as a compatible set (`api` 1.9.1, `sdk-trace`/`resources` 2.12.0, OTLP HTTP exporter 0.223.0).

## What is recorded

Each authentication attempt has its own ID, ordinal, authentication mode, start/end/duration, outcome, thread ID, trace/span IDs, role and SHA-256 of the exact instructions/context supplied to that invocation. Agent identity is `codex`; workflow role is its stage, or `bundle-review` for the blog UI. This executor still disables subagents; it does not invent individual reviewer identities.

Model fields keep their provenance:

- `requestedModel`/`requestedReasoning`: explicitly supplied server overrides, or null when Codex defaults are used. Optional `REELS_CODEX_MODEL` and `REELS_CODEX_REASONING_EFFORT` are passed to the SDK only when configured.
- `runtimeModels`/`runtimeReasoning`/`runtimeVersion`: metadata emitted by the running Codex CLI, collected through its documented OTel exporter. The runtime model is not relabeled as a provider-confirmed response model.
- `responseModel`: set only if an explicit `gen_ai.response.model` field arrives. Otherwise it stays null.

The per-attempt loopback receiver accepts OTLP/HTTP JSON on a random capability path and immediately discards everything except a small metadata allowlist. It does not read `auth.json`, search session transcripts, persist raw OTel bodies, or export prompts/tool output. Native `otel.log_user_prompt=false` is set for this invocation only; user configuration files are not modified. The receiver closes after the SDK drains the process stream, allowing the native exporter to flush on shutdown.

Token usage comes from SDK `turn.completed`, not from summing native per-request logs. This avoids double counting. Input, cached input, cache-write input, output and reasoning-output counts are preserved. Missing values stay null. Failed/cancelled attempts without a completion event are unknown, not zero. The last-success `job.usage` field remains available to older clients, while new UIs show all attempts separately.

One exported span represents one **Codex attempt/turn**, potentially containing multiple underlying model calls. It is an `invoke_agent` span, not a fabricated trace of every API request. Multiple runtime models make local cost attribution unknown. SDK thread history and raw content are outside this telemetry contract.

## Cost rules

Codex-login execution is marked `not-applicable` for API billing; it is never displayed as a zero-dollar API call. For API-key attempts, a valid exact-model price entry and complete usage are required. Missing, expired, ambiguous, mixed-model or incomplete data produces `unknown`.

The estimate subtracts cached/cache-write input from total input before applying their respective rates. Reasoning output is already part of output and is not charged a second time. Nonzero cache-write tokens require an explicit cache-write rate. Each estimate stores the rate ID, source, validity window and model used for pricing. It is an estimate, not provider invoice data.

The default price catalog is empty: this repository does not silently ship guessed or stale model prices. Set `REELS_AI_PRICING_FILE` to a private JSON catalog sourced from the provider's current pricing. Schema example with **fictional test values, not production prices**:

```json
[
  {
    "id": "synthetic-example-v1",
    "provider": "openai",
    "model": "example-model-not-for-production",
    "validFrom": "2026-11-01T00:00:00Z",
    "validUntil": "2026-12-01T00:00:00Z",
    "source": "https://example.org/fictional-test-rates",
    "usdPerMillion": { "input": 2, "cachedInput": 0.5, "output": 8 }
  }
]
```

Alternatively, Langfuse can infer API cost using its maintained model definitions after receiving generation observations. That service's inferred amount is not automatically written back into the local estimate field.

## Optional export

No external collector is contacted by this application's observer unless `REELS_OTEL_TRACES_ENDPOINT` is explicitly set. Existing global `OTEL_*` settings alone do not enable it. The local workflow server already uses port 4318; configure a collector on a different port/host.

- `REELS_OTEL_TRACES_ENDPOINT`: full OTLP HTTP trace URL, including `/v1/traces`. HTTPS required except for loopback hosts.
- `REELS_OTEL_HEADERS_JSON`: optional JSON object of collector headers, supplied through the server environment. Never stored in jobs or the renderer.
- `REELS_OTEL_VENDOR`: `standard` (default) or `langfuse`.

The Langfuse projection adds vendor attributes at the export boundary and the v4 ingestion header. API-key attempts with an unambiguous model are generation observations; Codex-login attempts stay agent observations so public API rates are not mistaken for subscription charges. A known local estimate can be ingested explicitly. No Langfuse account, key, deployment, or external connection was created for this change.

Trace/export failures do not fail model work, and local observations remain available. In-flight attempts left by a process crash are marked interrupted at restart. Older jobs are not retroactively assigned a model or a cost.

## Sources and validation

- [Codex native observability](https://learn.chatgpt.com/docs/config-file/config-advanced#observability-and-telemetry): runtime metadata, token events and shutdown flushing.
- [OpenTelemetry JS instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/): standard SDK and exporter boundary.
- [Langfuse OTLP ingestion](https://langfuse.com/integrations/native/opentelemetry): optional mappings and generation classification.
- [Langfuse token/cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking): usage versus model-price inference.

Tests cover cache/reasoning arithmetic, unknown versus zero, expired/ambiguous prices, failed fallback attempts, metadata filtering, standard span attributes, real OTLP HTTP export to a local test collector, and exporter failure isolation. A live synthetic login run reported runtime model `gpt-6-astra`, reasoning `medium`, CLI `0.166.0`, SDK token counts and trace IDs without an API key. No live API bill or hosted Langfuse ingestion was tested.

Verification: the full unit suite passed (134 tests at that run); the added pricing-failure check and all 7 observation tests passed afterward. Dashboard browser flows (2), canonical SDK browser flow (1), Electron backend bridge (1), typecheck, architecture/spec checks and web/desktop builds passed. Only the local OTLP test collector received exported spans; hosted Langfuse remains unconfigured.
