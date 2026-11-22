/**
 * 외부 모델 클라이언트 — Node 내장 fetch만 사용합니다.
 *
 *  Claude : 맥락·코믹 포인트·훅 5개 (plan/hooks.md)
 *  GPT    : episode.json 구조화 + 자막 타이밍 (JSON schema strict)
 *  Gemini : 캐릭터 시트·컷 이미지 (Nano Banana, 참조 이미지 슬롯)
 *  GPT Image: 대안 (글자·간판이 많은 컷)
 *
 * 라이브 API 호출은 키가 없어 이 저장소에서 검증되지 않았습니다. 요청 형식은 2026-11 공식 문서 기준입니다.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Config } from "./config.js";
import { ConfigError, ProviderError } from "./errors.js";
import { renderDoodleCut } from "./doodle.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_IMAGE_URL = "https://api.openai.com/v1/images/generations";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent";

export interface JsonRequest {
  payload?: unknown;
  headers?: Record<string, string>;
  method?: string;
  timeoutMs?: number;
  provider?: string;
}

export async function postJson<T = Record<string, unknown>>(url: string, request: JsonRequest = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 180_000);
  try {
    const response = await fetch(url, {
      method: request.method ?? (request.payload === undefined ? "GET" : "POST"),
      headers: {
        "Content-Type": "application/json",
        ...(request.headers ?? {}),
      },
      body: request.payload === undefined ? undefined : JSON.stringify(request.payload),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new ProviderError(`${request.provider ?? "api"} API 오류 HTTP ${response.status}: ${body.slice(0, 600)}`);
    }
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new ProviderError(`${request.provider ?? "api"} 응답이 JSON이 아닙니다: ${body.slice(0, 300)}`);
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if ((error as Error).name === "AbortError") {
      throw new ProviderError(`${request.provider ?? "api"} API 시간 초과`);
    }
    throw new ProviderError(`${request.provider ?? "api"} API 연결 실패: ${(error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

function stripFence(text: string): string {
  let value = (text ?? "").trim();
  if (value.startsWith("```")) {
    const lines = value.split("\n").slice(1);
    if (lines.at(-1)?.trim().startsWith("```")) lines.pop();
    value = lines.join("\n");
  }
  return value.trim();
}

export interface TextRequest {
  prompt: string;
  system?: string;
  maxTokens?: number;
  schema?: Record<string, unknown> | null;
  temperature?: number;
}

export interface TextClient {
  name: string;
  complete(request: TextRequest): Promise<string>;
  /** mock/테스트에서 프롬프트를 검사할 수 있게 호출 기록을 남깁니다. */
  calls?: TextRequest[];
}

export async function callAnthropic(config: Config, request: TextRequest): Promise<string> {
  if (!config.anthropicApiKey) throw new ConfigError("ANTHROPIC_API_KEY가 필요합니다 (.env).");
  const payload: Record<string, unknown> = {
    model: config.claudeModel,
    max_tokens: request.maxTokens ?? 4000,
    temperature: request.temperature ?? 0.7,
    messages: [{ role: "user", content: request.prompt }],
  };
  if (request.system) payload.system = request.system;
  if (request.schema) {
    payload.tools = [
      { name: "emit_json", description: "요청한 스키마의 JSON을 출력합니다.", input_schema: request.schema },
    ];
    payload.tool_choice = { type: "tool", name: "emit_json" };
  }
  const data = await postJson<{ content?: Array<Record<string, unknown>> }>(ANTHROPIC_URL, {
    payload,
    headers: { "x-api-key": config.anthropicApiKey, "anthropic-version": ANTHROPIC_VERSION },
    provider: "anthropic",
  });
  const chunks: string[] = [];
  for (const block of data.content ?? []) {
    if (block.type === "text") chunks.push(String(block.text ?? ""));
    if (block.type === "tool_use") chunks.push(JSON.stringify(block.input ?? {}));
  }
  if (!chunks.length) throw new ProviderError("anthropic 응답이 비었습니다.");
  return stripFence(chunks.join("\n"));
}

/**
 * gpt-5 · o1/o3/o4 계열(reasoning 모델)은 `temperature` 를 거부합니다(HTTP 400).
 * 요청 payload 에서 아예 빼야 합니다.
 */
export function omitsTemperature(model: string): boolean {
  const name = (model ?? "").trim().toLowerCase().replace(/^[a-z-]+\//, "");
  return /^gpt-5/.test(name) || /^o\d/.test(name);
}

export async function callOpenAI(config: Config, request: TextRequest): Promise<string> {
  if (!config.openaiApiKey) throw new ConfigError("OPENAI_API_KEY가 필요합니다 (.env).");
  const messages: Array<{ role: string; content: string }> = [];
  if (request.system) messages.push({ role: "system", content: request.system });
  messages.push({ role: "user", content: request.prompt });
  const payload: Record<string, unknown> = {
    model: config.gptModel,
    messages,
    max_completion_tokens: request.maxTokens ?? 4000,
  };
  if (!omitsTemperature(config.gptModel)) payload.temperature = request.temperature ?? 0.4;
  if (request.schema) {
    payload.response_format = {
      type: "json_schema",
      json_schema: { name: "episode", strict: true, schema: request.schema },
    };
  }
  const data = await postJson<{ choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> }>(
    OPENAI_CHAT_URL,
    {
      payload,
      headers: { Authorization: `Bearer ${config.openaiApiKey}` },
      provider: "openai",
    },
  );
  const content = data.choices?.[0]?.message?.content;
  if (content === undefined) throw new ProviderError("openai 응답 형식이 예상과 다릅니다.");
  const text = Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : content;
  return stripFence(text);
}

/** Gemini generateContent — 텍스트 응답 추출. */
export async function callGemini(config: Config, payload: unknown, model: string, timeoutMs = 300_000): Promise<string> {
  if (!config.geminiApiKey) throw new ConfigError("GEMINI_API_KEY가 필요합니다 (.env).");
  const url = `${GEMINI_URL.replace("{model}", model)}?key=${config.geminiApiKey}`;
  const data = await postJson<{ candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }> }>(url, {
    payload,
    timeoutMs,
    provider: "gemini",
  });
  let text = "";
  for (const candidate of data.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) text += String(part.text ?? "");
  }
  return stripFence(text);
}

// ──────────────────────────────────────────────────────────────
// 이미지
// ──────────────────────────────────────────────────────────────
export interface ImageRequest {
  prompt: string;
  dest: string;
  references?: string[];
  aspectRatio?: string;
}

export interface ImageModel {
  name: string;
  priceUsd: number;
  generate(request: ImageRequest): Promise<string>;
}

function writeBase64Image(data: string, dest: string): string {
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(data, "base64"));
  return dest;
}

export function createGeminiImage(config: Config): ImageModel {
  return {
    name: `gemini:${config.imageModel}`,
    priceUsd: config.imagePriceUsd,
    async generate(request) {
      if (!config.geminiApiKey) throw new ConfigError("GEMINI_API_KEY가 필요합니다 (.env).");
      const parts: Array<Record<string, unknown>> = [];
      for (const reference of request.references ?? []) {
        const mime = reference.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
        parts.push({ inline_data: { mime_type: mime, data: readFileSync(reference).toString("base64") } });
      }
      parts.push({ text: request.prompt });
      const payload = {
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: request.aspectRatio ?? "9:16", imageSize: "2K" },
        },
      };
      const url = `${GEMINI_URL.replace("{model}", config.imageModel)}?key=${config.geminiApiKey}`;
      const data = await postJson<{ candidates?: Array<{ content?: { parts?: Array<Record<string, unknown>> } }> }>(url, {
        payload,
        timeoutMs: 300_000,
        provider: "gemini-image",
      });
      for (const candidate of data.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          const inline = (part.inline_data ?? part.inlineData) as { data?: string } | undefined;
          if (inline?.data) return writeBase64Image(inline.data, request.dest);
        }
      }
      throw new ProviderError("gemini 이미지 응답에 이미지가 없습니다 (safety 필터 가능).");
    },
  };
}

export function createOpenAIImage(config: Config): ImageModel {
  return {
    name: `openai-image:${config.imageModelFallback}`,
    priceUsd: 0.08,
    async generate(request) {
      if (!config.openaiApiKey) throw new ConfigError("OPENAI_API_KEY가 필요합니다 (.env).");
      const payload = {
        model: config.imageModelFallback,
        prompt: request.prompt,
        size: "1024x1536",
        n: 1,
      };
      const data = await postJson<{ data?: Array<{ b64_json?: string; url?: string }> }>(OPENAI_IMAGE_URL, {
        payload,
        headers: { Authorization: `Bearer ${config.openaiApiKey}` },
        timeoutMs: 300_000,
        provider: "openai-image",
      });
      const first = data.data?.[0];
      if (!first) throw new ProviderError("openai 이미지 응답에 결과가 없습니다.");
      if (first.b64_json) return writeBase64Image(first.b64_json, request.dest);
      if (first.url) {
        const response = await fetch(first.url);
        mkdirSync(path.dirname(request.dest), { recursive: true });
        writeFileSync(request.dest, Buffer.from(await response.arrayBuffer()));
        return request.dest;
      }
      throw new ProviderError("openai 이미지 응답 형식을 해석할 수 없습니다.");
    },
  };
}

export const mockImage: ImageModel = {
  name: "mock-image",
  priceUsd: 0,
  async generate(request) {
    const index = Math.abs(hashString(request.dest)) % 97 + 1;
    return renderDoodleCut(request.dest, index, { width: 720, height: 1280 });
  },
};

function hashString(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return hash;
}

export function createImageModel(config: Config): ImageModel {
  if (config.dryRun || config.imageProvider === "mock") return mockImage;
  if (config.imageProvider === "gemini") {
    if (!config.geminiApiKey) {
      throw new ConfigError("GEMINI_API_KEY가 필요합니다 (.env).", { hint: "IMAGE_PROVIDER=mock 또는 dry-run으로 시험하세요." });
    }
    return createGeminiImage(config);
  }
  if (config.imageProvider === "openai") {
    if (!config.openaiApiKey) throw new ConfigError("OPENAI_API_KEY가 필요합니다 (.env).");
    return createOpenAIImage(config);
  }
  throw new ConfigError(`알 수 없는 이미지 제공자: ${config.imageProvider}`);
}
