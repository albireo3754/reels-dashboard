import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { toolDefinitions } from "../../features/agent-tools";

export function createMcpServer(
  call: (name: string, args: unknown) => Promise<any>,
) {
  const server = new McpServer(
    { name: "reels-dashboard", version: "0.1.0" },
    {
      instructions:
        "Use get_app_state first, then get_project before editing. Respect unsaved UI changes and updatedAt revisions. Keep place guide, captions and cover independent. Preview the requested frame and inspect the actual image. Render jobs must reach terminal state before claiming completion. Do not retry uncertain writes automatically. No upload, publishing, Photos deletion or arbitrary shell execution is provided. Content prose stays in the content workspace.",
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
          destructiveHint: false,
          openWorldHint: false,
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
          const structuredContent =
            result && typeof result === "object" && !Array.isArray(result)
              ? result
              : { result };
          return {
            content: [
              { type: "text", text: JSON.stringify(structuredContent) },
            ],
            structuredContent,
          };
        } catch (error) {
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
      },
    );
  }
  return server;
}
