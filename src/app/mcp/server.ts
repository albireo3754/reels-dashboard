import { mcpResult, mcpError } from "../../shared/mcp-result";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { agentGuidance, toolDefinitions } from "../../features/agent-tools";
import { parseDataUrl } from "../../shared/lib/data-url";

export function createMcpServer(
  call: (name: string, args: unknown) => Promise<any>,
) {
  const server = new McpServer(
    { name: "reels-dashboard", version: "0.1.0" },
    { instructions: agentGuidance },
  );
  for (const [name, definition] of Object.entries(toolDefinitions)) {
    server.registerTool(
      name,
      {
        description: definition.description,
        inputSchema: definition.input,
        annotations: {
          readOnlyHint: definition.readOnly,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          const result = await call(name, args);
          if (name === "reels_preview_frame") {
            const image = parseDataUrl(result.image);
            if (image?.mimeType !== "image/png")
              throw new Error("Invalid preview image");
            return {
              content: [
                {
                  type: "image",
                  data: image.data,
                  mimeType: "image/png",
                },
                {
                  type: "text",
                  text: JSON.stringify({
                    manifest: result.manifest,
                    displaySize: result.displaySize,
                  }),
                },
              ],
              structuredContent: {
                manifest: result.manifest,
                displaySize: result.displaySize,
              },
            };
          }
          return mcpResult(result);
        } catch (error) {
          return mcpError(error);
        }
      },
    );
  }
  return server;
}
