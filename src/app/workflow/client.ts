export async function workflowRequest(
  action:
    | "list"
    | "get"
    | "create"
    | "submit"
    | "restart"
    | "execute"
    | "stop"
    | "job"
    | "capabilities"
    | "review-bundles"
    | "review-markup"
    | "experience-save"
    | "experience-media",
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
        },
  );
  const data = await result.json();
  if (!result.ok) throw new Error(data.error ?? "Workflow request failed");
  return data;
}
