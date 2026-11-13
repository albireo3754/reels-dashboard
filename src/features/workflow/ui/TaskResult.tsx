import { useState } from "react";
import {
  isReviewStage,
  workflowStepLabel,
  type WorkflowRun,
} from "../../../shared/workflow";
export interface ResultDraft {
  summary: string;
  evidence: string;
  outcome: string;
}
export function TaskResult({
  run,
  busy,
  drafts,
  onSubmit,
}: {
  run: WorkflowRun;
  drafts: Map<string, ResultDraft>;
  busy: boolean;
  onSubmit: (input: unknown) => Promise<void>;
}) {
  const review = isReviewStage(run.stage);
  const draftKey = `${run.runId}:${run.task!.taskId}`;
  const [draft, setDraft] = useState<ResultDraft>(
    () =>
      drafts.get(draftKey) ?? {
        summary: "",
        evidence: "",
        outcome: review ? "pass" : "done",
      },
  );
  const update = (patch: Partial<ResultDraft>) => {
    setDraft((current) => {
      const next = { ...current, ...patch };
      drafts.set(draftKey, next);
      return next;
    });
  };
  return (
    <form
      className="workflow-result"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        void onSubmit({
          runId: run.runId,
          taskId: run.task!.taskId,
          outcome: data.get("outcome"),
          summary: data.get("summary"),
          evidence: String(data.get("evidence"))
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
        });
      }}
    >
      <label>
        판단·변경 내용
        <textarea
          name="summary"
          required
          value={draft.summary}
          onChange={(e) => update({ summary: e.target.value })}
          placeholder="수행한 작업과 판단 근거를 적어주세요. Markdown을 사용할 수 있어요."
        />
      </label>
      <label>
        결과·검토 근거 파일 (상대 경로, 한 줄에 하나)
        <textarea
          name="evidence"
          value={draft.evidence}
          onChange={(e) => update({ evidence: e.target.value })}
        />
      </label>
      <div className="workflow-composer-toolbar">
        <span>현재 단계 · {workflowStepLabel(run)}</span>
        <label>
          결과
          <select
            name="outcome"
            aria-label="결과"
            value={draft.outcome}
            onChange={(e) => update({ outcome: e.target.value })}
          >
            {review ? (
              <>
                <option value="pass">검토 통과</option>
                <option value="revise">수정 필요</option>
              </>
            ) : (
              <option value="done">작업 완료</option>
            )}
            <option value="blocked">근거 부족 · 보류</option>
            <option value="cancel">작업 취소</option>
          </select>
        </label>
        <button disabled={busy}>결과 제출</button>
      </div>
    </form>
  );
}
