import {
  workflowEndpoint,
  workflowFetchInit,
  type WorkflowAction,
} from "../../shared/workflow";

export async function workflowRequest(
  action: WorkflowAction,
  input: unknown = {},
  base = process.env.REELS_WORKFLOW_URL ?? "http://127.0.0.1:4318",
) {
  const url = new URL(base);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password
  )
    throw new Error("Workflow server must use loopback HTTP");
  const result = await fetch(
    new URL(workflowEndpoint(action, input), url),
    workflowFetchInit(action, input),
  );
  const data = await result.json();
  if (!result.ok) throw new Error(data.error ?? "Workflow request failed");
  return data;
}
