import { useEffect, useState, useCallback } from "react";
import type { InputFormRecord } from "../../../shared/input-forms";
import { workflowCall } from "../../../shared/workflow-client";
import { ExperienceForm } from "./ExperienceForm";
export function FormInbox({
  onDirtyChange,
}: {
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [dirty, setDirty] = useState(false);
  const changeDirty = useCallback(
    (v: boolean) => {
      setDirty(v);
      onDirtyChange(v);
    },
    [onDirtyChange],
  );
  const [forms, setForms] = useState<InputFormRecord[]>([]);
  const [selected, setSelected] = useState(
    new URLSearchParams(location.search).get("form") ?? "",
  );
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    const data = await workflowCall("forms-list", {});
    setForms(data.forms);
  }, []);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const data = await workflowCall("forms-list", {});
        if (active) setForms(data.forms);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const record = forms.find((f) => f.formId === selected) ?? forms[0];
  return (
    <section className="workflow-panel">
      <header>
        <h2>입력폼·답변·결과</h2>
        <p>대시보드와 Codex 세션이 같은 질문과 답변을 사용합니다.</p>
      </header>
      {error && <p role="alert">{error}</p>}
      <div className="workflow-columns">
        <aside aria-label="입력폼 목록">
          {forms.map((f) => (
            <button
              key={f.formId}
              disabled={dirty}
              aria-pressed={record?.formId === f.formId}
              onClick={() => setSelected(f.formId)}
            >
              <strong>{f.form.title}</strong>
              <small>
                {f.applications.length
                  ? "결과 있음"
                  : f.status === "submitted"
                    ? "제출됨"
                    : "답변 대기"}{" "}
                · {f.workflowRunId ? "대시보드 연결" : "세션에서 진행"}
              </small>
            </button>
          ))}
        </aside>
        <div className="workflow-detail">
          {record ? (
            <>
              <p>{record.projectId || "프로젝트 미지정"}</p>
              <ExperienceForm
                key={record.formId}
                record={record}
                onDirtyChange={changeDirty}
                onSaved={refresh}
              />
            </>
          ) : (
            <p>
              아직 요청받은 입력폼이 없어요. 대시보드에서 준비하거나 Codex
              세션에서 폼을 보내면 여기에 나타납니다.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
