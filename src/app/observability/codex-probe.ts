import { readBody, RequestTooLargeError } from "../lib/http";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AiAttempt } from "../../shared/ai-observation";

/** OTLP/HTTP JSON boundary. Only these metadata fields survive; bodies/prompts/tool output are discarded. */
export function consumeCodexMetadata(
  payload: unknown,
  attempt: AiAttempt,
): boolean {
  if (!payload || typeof payload !== "object") return false;
  const before = JSON.stringify([
    attempt.runtimeModels,
    attempt.responseModel,
    attempt.runtimeReasoning,
    attempt.runtimeVersion,
  ]);
  const object = payload as any;
  if (!Array.isArray(object.resourceLogs)) return false;
  const value = (attributes: any[], key: string) => {
    const raw = attributes.find((a) => a?.key === key)?.value?.stringValue;
    return typeof raw === "string" &&
      /^[a-zA-Z0-9_.:/-]{1,160}$/.test(raw) &&
      !raw.startsWith("sk-")
      ? raw
      : undefined;
  };
  for (const resource of object.resourceLogs.slice(0, 100)) {
    for (const scope of (Array.isArray(resource.scopeLogs)
      ? resource.scopeLogs
      : []
    ).slice(0, 100)) {
      for (const log of (Array.isArray(scope.logRecords)
        ? scope.logRecords
        : []
      ).slice(0, 1000)) {
        const attrs = [
          ...(Array.isArray(log.attributes) ? log.attributes : []),
          ...(Array.isArray(resource.resource?.attributes)
            ? resource.resource.attributes
            : []),
        ];
        const model = value(attrs, "model");
        const response = value(attrs, "gen_ai.response.model");
        const reasoning =
          value(attrs, "reasoning_effort") ??
          value(attrs, "model_reasoning_effort");
        const version =
          value(attrs, "app.version") ?? value(attrs, "service.version");
        if (
          model &&
          !attempt.runtimeModels.includes(model) &&
          attempt.runtimeModels.length < 20
        )
          attempt.runtimeModels.push(model);
        if (response) {
          if (
            attempt.responseModel &&
            attempt.responseModel !== response &&
            !attempt.warnings.includes("multiple-response-models")
          )
            attempt.warnings.push("multiple-response-models");
          attempt.responseModel = response;
        }
        if (reasoning) attempt.runtimeReasoning = reasoning;
        if (version) attempt.runtimeVersion = version;
      }
    }
  }
  const changed =
    before !==
    JSON.stringify([
      attempt.runtimeModels,
      attempt.responseModel,
      attempt.runtimeReasoning,
      attempt.runtimeVersion,
    ]);
  if (attempt.runtimeModels.length || attempt.responseModel)
    attempt.modelSource = "codex-otel";
  return changed;
}
export interface CodexProbe {
  configOverrides: string[];
  close(): Promise<void>;
}
export type CodexProbeFactory = (
  attempt: AiAttempt,
  changed: () => void,
) => Promise<CodexProbe>;
export const openCodexProbe: CodexProbeFactory = async (attempt, changed) => {
  const route = `/v1/logs/${randomUUID()}`;
  const server = createServer(async (req, res) => {
    const port = (server.address() as { port: number }).port;
    if (
      req.method !== "POST" ||
      req.url !== route ||
      req.headers.host !== `127.0.0.1:${port}` ||
      req.headers.origin ||
      !req.headers["content-type"]?.includes("application/json")
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      let body: string;
      try {
        body = await readBody(req, 4 * 1024 * 1024);
      } catch (error) {
        if (!(error instanceof RequestTooLargeError)) throw error;
        res.writeHead(413);
        res.end();
        return;
      }
      if (consumeCodexMetadata(JSON.parse(body), attempt)) changed();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    } catch {
      res.writeHead(400);
      res.end("{}");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}${route}`;
  return {
    configOverrides: [
      "otel.log_user_prompt=false",
      `otel.exporter={otlp-http={endpoint=${JSON.stringify(endpoint)},protocol="json"}}`,
    ],
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeIdleConnections();
      }),
  };
};
