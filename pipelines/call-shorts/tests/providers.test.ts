import test from "node:test";
import assert from "node:assert/strict";

import { callOpenAI, omitsTemperature } from "../src/providers.js";
import { makeConfig } from "./helpers.js";

const originalFetch = globalThis.fetch;

/** fetch 를 가로채 실제 요청 payload 를 모읍니다 (키 없이 요청 형식만 검사). */
function stubFetch(reply: unknown): Array<{ url: string; body: Record<string, unknown> }> {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url: String(input), body });
    return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return calls;
}

test("gpt-5 and reasoning models reject temperature, others keep it", () => {
  for (const model of ["gpt-5", "GPT-5-mini", "gpt-5-chat-latest", "o1", "o3-mini", "o4-mini", "openai/gpt-5"]) {
    assert.equal(omitsTemperature(model), true, model);
  }
  for (const model of ["gpt-4.1", "gpt-4o", "gpt-4o-mini", "claude-sonnet-4-5", ""]) {
    assert.equal(omitsTemperature(model), false, model);
  }
});

test("a gpt-5 chat request leaves temperature out of the payload", async () => {
  const calls = stubFetch({ choices: [{ message: { content: '{"ok":true}' } }] });
  try {
    const config = makeConfig({ OPENAI_API_KEY: "test-key", GPT_MODEL: "gpt-5" });
    const text = await callOpenAI(config, { prompt: "hi", schema: { type: "object" } });
    assert.equal(text, '{"ok":true}');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.model, "gpt-5");
    assert.ok(!("temperature" in calls[0].body), JSON.stringify(calls[0].body));
    assert.ok("response_format" in calls[0].body);
    assert.ok("max_completion_tokens" in calls[0].body);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a gpt-4 class request still sends temperature", async () => {
  const calls = stubFetch({ choices: [{ message: { content: "ok" } }] });
  try {
    const config = makeConfig({ OPENAI_API_KEY: "test-key", GPT_MODEL: "gpt-4.1" });
    await callOpenAI(config, { prompt: "hi", temperature: 0.2 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.temperature, 0.2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
