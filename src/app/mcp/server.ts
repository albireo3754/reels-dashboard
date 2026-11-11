import { mcpResult, mcpError } from "../../shared/mcp-result";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { toolDefinitions } from "../../features/agent-tools";

export function createMcpServer(
  call: (name: string, args: unknown) => Promise<any>,
) {
  const server = new McpServer(
    { name: "reels-dashboard", version: "0.1.0" },
    {
      instructions:
        "Use get_app_state first, then get_project before editing. Respect unsaved UI changes and updatedAt revisions. Keep place guide, captions and cover independent. Preview the requested frame and inspect the actual image. Render jobs must reach terminal state before claiming completion. Do not retry uncertain writes automatically. Each project has one saved iCloud outbound folder. Delivery updates its managed files and keeps prior versions locally; do not create folders per version. Local copy is not upload completion. No social publishing, Photos deletion or arbitrary shell execution is provided. Content prose stays in the content workspace.",
    },
  );
  for (const [name, definition] of Object.entries(toolDefinitions)) {
    server.registerTool(
      name,
      {
        description: definition.description,
        inputSchema: definition.input,
        annotations: {
          readOnlyHint: definition.readOnly,
          destructiveHint: name === "reels_start_icloud_delivery",
          openWorldHint: name === "reels_start_icloud_delivery",
        },
      },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          const result = await call(name, args);
          if (name === "reels_preview_frame") {
            if (!result.image?.startsWith("data:image/png;base64,"))
              throw new Error("Invalid preview image");
            return {
              content: [
                {
                  type: "image",
                  data: result.image.slice("data:image/png;base64,".length),
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
