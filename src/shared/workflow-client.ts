import {
  workflowEndpoint,
  workflowFetchInit,
  type WorkflowAction,
} from "./workflow";
export async function workflowCall(action: WorkflowAction, input: any = {}) {
  if (window.reels?.workflow)
    return window.reels.workflow.request(action, input);
  const response = await fetch(
    workflowEndpoint(action, input),
    workflowFetchInit(action, input),
  );
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      "워크플로 서버에 연결되지 않았어요. 로컬 서버를 실행해주세요.",
    );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "워크플로 요청 실패");
  return result;
}
