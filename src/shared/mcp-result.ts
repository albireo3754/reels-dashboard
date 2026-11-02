import type { CallToolResult } from "@modelcontextprotocol/server";

/** Keep text and structured responses identical for all JSON-based MCP tools. */
export function mcpResult(result: unknown): CallToolResult {
  const structuredContent =
    result !== null && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : { result: result ?? null };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

export function mcpError(error: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}
