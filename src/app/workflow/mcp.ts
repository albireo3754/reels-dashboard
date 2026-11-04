import { mcpResult, mcpError } from "../../shared/mcp-result";
import { inputFormTools } from "../../shared/input-form-tools";
import { openFollowupsInput } from "../../shared/followups";
import {
  saveExperienceInput,
  experienceMediaInput,
} from "../../shared/experience";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import {
  createWorkflowInput,
  submitWorkflowInput,
  workflowIdInput,
  executeWorkflowInput,
  sdkJobIdInput,
  isReadOnlyWorkflowAction,
} from "../../shared/workflow";
import { workflowRequest } from "./client";
import { errorMessage } from "../../shared/errors";

const handle = serveStdio(() => {
  const server = new McpServer(
    { name: "reels-workflows", version: "1.0.0" },
    {
      instructions:
        "Coordinate work performed by the current session, or explicitly execute one pending step with Codex SDK. Create/get a workflow and read its task before manual work or execute. execute returns an asynchronous job; inspect job until terminal status. Do not also submit or restart while an SDK job is running. The SDK uses saved login without a key; a configured API key takes priority with limited auth/quota fallback. Review stages must not edit tracked inputs. On STALE_INPUT use restart and review fresh inputs. ready is not published. No automatic next-step execution or publication.",
    },
  );
  for (const [
    action,
    name,
    inputSchema,
    description,
    readOnly,
  ] of inputFormTools) {
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (input: unknown): Promise<CallToolResult> => {
        try {
          const result = await workflowRequest(action, input);
          return mcpResult(result);
        } catch (error) {
          return mcpError(error);
        }
      },
    );
  }
  const tools = [
    [
      "followups-open",
      openFollowupsInput,
      "Reconcile submitted answers and explicitly supplied additional instructions before continuing an existing draft/review. Preserves history; refuses stale tasks.",
    ],
    [
      "experience-save",
      saveExperienceInput,
      "Save user-provided answers together, or submit them to unlock drafting. Never invent answers. Use expectedRevision from get.",
    ],
    [
      "experience-media",
      experienceMediaInput,
      "Read a registered question image from this workflow only.",
    ],
    [
      "capabilities",
      z.strictObject({}),
      "Read SDK availability and configured authentication priority without exposing credentials.",
    ],
    [
      "execute",
      executeWorkflowInput,
      "Explicitly run only the pending workflow step using Codex SDK. Returns an asynchronous job. No automatic next-step execution.",
    ],
    [
      "job",
      sdkJobIdInput,
      "Read SDK progress, authentication attempts, usage and result.",
    ],
    [
      "stop",
      sdkJobIdInput,
      "Cancel an active SDK job and leave the workflow task pending.",
    ],
    ["list", z.strictObject({}), "List saved workflow runs."],
    [
      "get",
      workflowIdInput,
      "Get current task, input hashes, history and status.",
    ],
    [
      "create",
      createWorkflowInput,
      "Start a local blog editorial workflow. Existing source files and workspace instructions are required.",
    ],
    [
      "submit",
      submitWorkflowInput,
      "Submit completed external work. Evidence paths are relative to workspace. done for work stages, pass/revise for reviews, blocked/cancel for any stage.",
    ],
    [
      "restart",
      workflowIdInput,
      "Invalidate the pending task and issue fresh input hashes; resume a blocked run or reopen a ready run for review. Does not reset revision limits.",
    ],
  ] as const;
  for (const [action, inputSchema, description] of tools) {
    server.registerTool(
      `reels_workflow_${action}`,
      {
        description,
        inputSchema,
        annotations: {
          readOnlyHint: isReadOnlyWorkflowAction(action),
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (input: unknown): Promise<CallToolResult> => {
        try {
          const result = await workflowRequest(action, input);
          return mcpResult(result);
        } catch (error) {
          return mcpError(error);
        }
      },
    );
  }
  return server;
});
process.on("SIGINT", () => void handle.close());
process.on("SIGTERM", () => void handle.close());
