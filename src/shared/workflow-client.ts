import type { WorkflowAction } from "./workflow";
export async function workflowCall(action: WorkflowAction, input: any = {}) {
  if (window.reels?.workflow)
    return window.reels.workflow.request(action, input);
  let endpoint = "/api/workflows";
  if (action === "get")
    endpoint += `/run?id=${encodeURIComponent(input.runId)}`;
  else if (action === "job")
    endpoint += `/job?id=${encodeURIComponent(input.jobId)}`;
  else if (action !== "list") endpoint += "/" + action;
  const response = await fetch(
    endpoint,
    ["list", "get", "job", "capabilities"].includes(action)
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
  );
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      "워크플로 서버에 연결되지 않았어요. 로컬 서버를 실행해주세요.",
    );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "워크플로 요청 실패");
  return result;
}
