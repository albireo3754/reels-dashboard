import {
  STALE_WORKFLOW_SERVER_MESSAGE,
  type WorkflowAction,
} from "../../shared/workflow";
export async function workflowRequest(
  action: WorkflowAction,
  input: unknown = {},
  base = process.env.REELS_WORKFLOW_URL ?? "http://127.0.0.1:4318",
  signal?: AbortSignal,
) {
  const url = new URL(base);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password
  )
    throw new Error("Workflow server must use loopback HTTP");
  let endpoint = "/api/workflows";
  if (action === "get")
    endpoint += `/run?id=${encodeURIComponent((input as { runId: string }).runId)}`;
  else if (action === "job")
    endpoint += `/job?id=${encodeURIComponent((input as { jobId: string }).jobId)}`;
  else if (action !== "list") endpoint += "/" + action;
  const result = await fetch(
    new URL(endpoint, url),
    ["list", "get", "job", "capabilities"].includes(action)
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal,
        },
  );
  const data = await result.json();
  // An older server rejects actions added since it started; say so instead of the raw route error.
  if (result.status === 404 && data.error === "Unknown workflow action")
    throw new Error(STALE_WORKFLOW_SERVER_MESSAGE);
  if (!result.ok) throw new Error(data.error ?? "Workflow request failed");
  return data;
}
