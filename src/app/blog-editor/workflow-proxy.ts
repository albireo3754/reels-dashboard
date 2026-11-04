import { readJsonBody } from "../lib/http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { workflowRequest } from "../workflow/client";
import {
  isReadOnlyWorkflowAction,
  workflowAction,
  type WorkflowAction,
} from "../../shared/workflow";

/** Same-origin bridge to the single workflow backend; no second SDK runtime or credential store. */
export async function proxyWorkflow(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
) {
  if (!url.pathname.startsWith("/api/workflows")) return false;
  let action: WorkflowAction;
  let input: unknown = {};
  if (req.method === "GET") {
    const route = url.pathname.slice("/api/workflows".length);
    if (route === "") action = "list";
    else if (route === "/run") {
      action = "get";
      input = { runId: url.searchParams.get("id") };
    } else if (route === "/job") {
      action = "job";
      input = { jobId: url.searchParams.get("id") };
    } else if (route === "/capabilities") action = "capabilities";
    else throw new Error("Unknown workflow route");
  } else if (req.method === "POST") {
    if (
      req.headers.origin !== url.origin ||
      !req.headers["content-type"]?.startsWith("application/json")
    )
      throw new Error("Same-origin JSON required");
    action = workflowAction.parse(url.pathname.slice("/api/workflows/".length));
    if (isReadOnlyWorkflowAction(action))
      throw new Error("Invalid workflow action");
    input = await readJsonBody(req, 256000);
  } else throw new Error("Method not allowed");
  const result = await workflowRequest(action, input);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(result));
  return true;
}
