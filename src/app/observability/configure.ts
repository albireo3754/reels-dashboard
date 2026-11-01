import { readFile } from "node:fs/promises";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { StaticPriceCatalog, type ModelRate } from "./pricing";
import { ObservationRecorder } from "./observation";
import { CodexObserver } from "./codex-observer";
import { OtelObservationSink } from "./otel-sink";
import { langfuseAttributes } from "./langfuse-projection";

/** Composition root. Only explicit REELS_* settings enable remote export; default is local-only. */
export async function configureObservation(
  env: NodeJS.ProcessEnv = process.env,
) {
  const rates: ModelRate[] = env.REELS_AI_PRICING_FILE
    ? JSON.parse(await readFile(env.REELS_AI_PRICING_FILE, "utf8"))
    : [];
  if (!Array.isArray(rates))
    throw new Error("Pricing catalog must be an array");
  const catalog = new StaticPriceCatalog(rates);
  const vendor = env.REELS_OTEL_VENDOR ?? "standard";
  if (!["standard", "langfuse"].includes(vendor))
    throw new Error("Unknown OTel vendor mapping");
  let exporter: OTLPTraceExporter | undefined;
  if (env.REELS_OTEL_TRACES_ENDPOINT) {
    const url = new URL(env.REELS_OTEL_TRACES_ENDPOINT);
    if (
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        ))
    )
      throw new Error("Use HTTPS or a loopback OTLP endpoint");
    const headers = env.REELS_OTEL_HEADERS_JSON
      ? JSON.parse(env.REELS_OTEL_HEADERS_JSON)
      : {};
    if (
      !headers ||
      typeof headers !== "object" ||
      Array.isArray(headers) ||
      !Object.values(headers).every((value) => typeof value === "string")
    )
      throw new Error("Invalid OTLP headers");
    if (vendor === "langfuse") headers["x-langfuse-ingestion-version"] = "4";
    exporter = new OTLPTraceExporter({
      url: url.href,
      headers,
      timeoutMillis: 3000,
    });
  }
  const sink = new OtelObservationSink(
    exporter,
    vendor === "langfuse" ? langfuseAttributes : undefined,
  );
  return {
    observer: new CodexObserver(new ObservationRecorder(catalog, sink)),
    configuration: {
      exportEnabled: Boolean(exporter),
      vendor,
      priceRecords: rates.length,
    },
    close: () => sink.close(),
  };
}
