import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace";
import {
  StaticPriceCatalog,
  estimateCost,
  type ModelRate,
} from "../../src/app/observability/pricing";
import {
  ObservationRecorder,
  type ObservationSink,
} from "../../src/app/observability/observation";
import { CodexObserver } from "../../src/app/observability/codex-observer";
import {
  consumeCodexMetadata,
  openCodexProbe,
} from "../../src/app/observability/codex-probe";
import { OtelObservationSink } from "../../src/app/observability/otel-sink";
import { configureObservation } from "../../src/app/observability/configure";
import { langfuseAttributes } from "../../src/app/observability/langfuse-projection";
import type { AiObservation, AiAttempt } from "../../src/shared/ai-observation";

const rate: ModelRate = {
  id: "synthetic-rate-v1",
  provider: "openai",
  model: "fixture-model",
  source: "https://example.org/synthetic-not-a-real-price",
  validFrom: "2020-01-01T00:00:00Z",
  validUntil: "2030-01-01T00:00:00Z",
  usdPerMillion: { input: 2, cachedInput: 0.5, output: 8 },
};
function attempt() {
  const observation: AiObservation = { version: 1, attempts: [] };
  return new ObservationRecorder().begin(
    observation,
    {
      auth: "api-key",
      provider: "openai",
      agent: "codex",
      role: "review",
      instructionHash: "hash",
    },
    { jobId: "job" },
    () => {},
  ).record;
}
const usage = {
  input: 1000,
  cachedInput: 200,
  cacheWriteInput: 0,
  output: 100,
  reasoningOutput: 40,
  source: "sdk-turn-completed" as const,
};

test("optional Langfuse mapping keeps subscription runs out of API generation billing", () => {
  const a = attempt();
  a.runtimeModels = ["fixture-model"];
  a.usage = usage;
  a.cost = estimateCost(a, new StaticPriceCatalog([rate]));
  assert.equal(
    langfuseAttributes(a)["langfuse.observation.type"],
    "generation",
  );
  assert.equal(
    JSON.parse(langfuseAttributes(a)["langfuse.observation.cost_details"])
      .total,
    0.0025,
  );
  const login = langfuseAttributes({
    ...a,
    auth: "codex-login",
    cost: { status: "not-applicable", usd: null },
  });
  assert.equal(login["langfuse.observation.type"], "agent");
  assert.equal(login["langfuse.observation.cost_details"], undefined);
});

test("pricing separates cached input and never charges reasoning twice; zero and missing are distinct", () => {
  const a = attempt();
  a.runtimeModels = ["fixture-model"];
  a.usage = usage;
  const catalog = new StaticPriceCatalog([rate]);
  assert.equal(estimateCost(a, catalog).usd, 0.0025);
  assert.equal(estimateCost(a, catalog).rateSource, rate.source);
  assert.deepEqual(estimateCost(a, catalog).usdPerMillion, rate.usdPerMillion);
  assert.equal(estimateCost({ ...a, usage: null }, catalog).usd, null);
  assert.equal(
    estimateCost({ ...a, auth: "codex-login" }, catalog).status,
    "not-applicable",
  );
  assert.equal(
    estimateCost(
      {
        ...a,
        usage: {
          ...usage,
          input: 0,
          cachedInput: 0,
          output: 0,
          reasoningOutput: 0,
        },
      },
      catalog,
    ).usd,
    0,
  );
  assert.equal(
    estimateCost({ ...a, usage: { ...usage, cachedInput: 1001 } }, catalog)
      .reason,
    "inconsistent-usage",
  );
  assert.equal(
    estimateCost({ ...a, usage: { ...usage, cacheWriteInput: 10 } }, catalog)
      .reason,
    "cache-write-rate-unavailable",
  );
  assert.equal(
    estimateCost({ ...a, runtimeModels: [] }, catalog).reason,
    "model-unconfirmed",
  );
  assert.equal(
    estimateCost({ ...a, runtimeModels: ["fixture-model", "other"] }, catalog)
      .reason,
    "multiple-runtime-models",
  );
  assert.equal(
    estimateCost(
      a,
      new StaticPriceCatalog([{ ...rate, validUntil: "2021-01-01T00:00:00Z" }]),
    ).usd,
    null,
  );
  assert.equal(estimateCost(a, new StaticPriceCatalog([rate, rate])).usd, null);
});

test("native OTLP metadata adapter discards prompt/tool/body content and preserves model provenance", async () => {
  const a = attempt();
  let changes = 0;
  const probe = await openCodexProbe(a, () => changes++);
  const endpoint = JSON.parse(
    probe.configOverrides
      .find((v) => v.startsWith("otel.exporter="))!
      .match(/endpoint=("[^"]+")/)![1],
  );
  const payload = {
    resourceLogs: [
      {
        resource: {
          attributes: [
            { key: "service.version", value: { stringValue: "0.166.0" } },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                body: { stringValue: "secret prompt" },
                attributes: [
                  { key: "model", value: { stringValue: "fixture-model" } },
                  { key: "reasoning_effort", value: { stringValue: "high" } },
                  {
                    key: "tool.output",
                    value: { stringValue: "sensitive output" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  try {
    assert.equal(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: "https://example.org",
          },
          body: JSON.stringify(payload),
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      ).status,
      200,
    );
    assert.equal(changes, 1);
    assert.deepEqual(a.runtimeModels, ["fixture-model"]);
    assert.equal(a.runtimeVersion, "0.166.0");
    assert.equal(a.modelSource, "codex-otel");
    assert.equal(a.responseModel, null);
    assert(!JSON.stringify(a).includes("secret"));
    assert(!JSON.stringify(a).includes("sensitive"));
    assert.equal(consumeCodexMetadata(payload, a), false);
  } finally {
    await probe.close();
  }
});

test("attempt lifecycle retains failed fallback attempts and unknown usage without blocking work on sink failure", async () => {
  const observation: AiObservation = { version: 1, attempts: [] };
  const broken: ObservationSink = {
    start() {
      throw new Error("unavailable");
    },
  };
  const recorder = new ObservationRecorder(
    new StaticPriceCatalog([rate]),
    broken,
  );
  const observer = new CodexObserver(recorder, async () => ({
    configOverrides: [],
    async close() {},
  }));
  const input = {
    observation,
    jobId: "job",
    role: "review",
    prompt: "sensitive prompt",
    changed() {},
  };
  const first = await observer.begin({ ...input, auth: "api-key" });
  await first.finish("failed", "authentication-or-quota");
  const second = await observer.begin({ ...input, auth: "codex-login" });
  second.event({
    type: "turn.completed",
    usage: {
      input_tokens: 10,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 3,
      reasoning_output_tokens: 1,
    },
  });
  await second.finish("completed");
  assert.equal(observation.attempts.length, 2);
  assert.equal(observation.attempts[0].usage, null);
  assert.equal(observation.attempts[0].cost.usd, null);
  assert.equal(observation.attempts[1].usage?.input, 10);
  assert.equal(observation.attempts[1].cost.status, "not-applicable");
  assert(!JSON.stringify(observation).includes("sensitive prompt"));
  assert(observation.attempts[0].warnings.includes("trace-start-failed"));
});

test("pricing adapter failure cannot turn successful model work into a workflow failure", () => {
  const observation: AiObservation = { version: 1, attempts: [] };
  const handle = new ObservationRecorder({
    find() {
      throw new Error("price service offline");
    },
  }).begin(
    observation,
    {
      auth: "api-key",
      provider: "openai",
      agent: "codex",
      role: "review",
      instructionHash: "hash",
    },
    { jobId: "job" },
    () => {},
  );
  handle.record.runtimeModels = ["fixture-model"];
  handle.usage(usage);
  handle.finish("completed");
  assert.equal(handle.record.status, "completed");
  assert.equal(handle.record.cost.reason, "pricing-unavailable");
  assert(handle.record.warnings.includes("pricing-failed"));
});

test("standard OpenTelemetry spans carry metadata/usage, never prompt or a guessed response model", async () => {
  const exporter = new InMemorySpanExporter();
  const sink = new OtelObservationSink(exporter);
  try {
    const observation: AiObservation = { version: 1, attempts: [] };
    const handle = new ObservationRecorder(
      new StaticPriceCatalog([rate]),
      sink,
    ).begin(
      observation,
      {
        auth: "api-key",
        provider: "openai",
        agent: "codex",
        role: "writer",
        instructionHash: "only-a-hash",
      },
      { jobId: "job" },
      () => {},
    );
    handle.record.runtimeModels = ["fixture-model"];
    handle.usage(usage);
    handle.finish("completed");
    await sink.provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0].attributes["gen_ai.operation.name"], "invoke_agent");
    assert.equal(spans[0].attributes["gen_ai.request.model"], "fixture-model");
    assert.equal(spans[0].attributes["gen_ai.response.model"], undefined);
    assert.equal(spans[0].attributes["gen_ai.usage.input_tokens"], 1000);
    assert.equal(spans[0].attributes["reels.cost.estimated_usd"], 0.0025);
    assert.match(handle.record.traceId!, /^[a-f0-9]{32}$/);
  } finally {
    await sink.close();
  }
});

test("explicit OTLP exporter sends real standard payload to a local collector", async () => {
  const payloads: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    payloads.push(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const telemetry = await configureObservation({
    REELS_OTEL_TRACES_ENDPOINT: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/traces`,
  });
  try {
    const observation: AiObservation = { version: 1, attempts: [] };
    const a = await telemetry.observer.begin({
      observation,
      jobId: "local-export",
      auth: "codex-login",
      role: "review",
      prompt: "private body never export",
      changed() {},
    });
    await a.finish("completed");
    await telemetry.close();
    assert.equal(payloads.length, 1);
    assert(Array.isArray(JSON.parse(payloads[0]).resourceSpans));
    assert(!payloads[0].includes("private body"));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
