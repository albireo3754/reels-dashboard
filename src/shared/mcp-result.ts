import { errorMessage } from "./lib/errors";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { editsErrorDetails } from "./edits";

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
  const details = editsErrorDetails((error as { details?: unknown })?.details);
  if (details && Object.keys(details).length) {
    const code = (error as { code?: unknown })?.code;
    const structuredContent = {
      verified: false,
      error: {
        message: errorMessage(error),
        ...(typeof code === "string" ? { code } : {}),
        details,
      },
    };
    return {
      isError: true,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
      structuredContent,
    };
  }
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: errorMessage(error),
      },
    ],
  };
}
