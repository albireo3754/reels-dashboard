import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpResult, mcpError } from "../../src/shared/mcp-result";

test("MCP JSON responses preserve objects and wrap arrays/scalars with matching text", () => {
  for (const value of [
    { status: "running", nested: { count: 0 } },
    ["one", "two"],
    "text",
    0,
    false,
    null,
    undefined,
  ]) {
    const result = mcpResult(value);
    assert.equal(result.isError, undefined);
    const text = result.content[0];
    assert.equal(text.type, "text");
    assert.deepEqual(
      JSON.parse((text as { text: string }).text),
      result.structuredContent,
    );
    if (value && typeof value === "object" && !Array.isArray(value))
      assert.strictEqual(result.structuredContent, value);
    else assert.deepEqual(result.structuredContent, { result: value ?? null });
  }
});

test("MCP failures retain isError and human-readable text without structured success data", () => {
  for (const error of [new Error("APP_OFFLINE"), "STALE_TASK"]) {
    const result = mcpError(error);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.deepEqual(result.content, [
      { type: "text", text: error instanceof Error ? error.message : error },
    ]);
  }
});
