import { useEffect, useState } from "react";
import type { WorkflowRun } from "../../../shared/workflow";
import type { ExperienceAnswer } from "../../../shared/experience";
import { workflowCall } from "../../../shared/workflow-client";

function QuestionImage({
  runId,
  questionId,
  index,
  caption,
}: {
  runId: string;
  questionId: string;
  index: number;
  caption: string;
}) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void workflowCall("experience-media", {
      runId,
      questionId,
      imageIndex: index,
    })
      .then((data) => {
        if (active) setSrc(data.dataUrl);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [runId, questionId, index]);
  return (
    <figure>
      {src ? (
        <img src={src} alt={caption} />
      ) : (
        <p>{error || "사진을 불러오고 있어요."}</p>
      )}
      <figcaption>{caption}</figcaption>
    </figure>
  );
}
export function ExperienceForm({
  run,
  onSaved,
}: {
  run: WorkflowRun;
  onSaved: () => Promise<void>;
}) {
  const record = run.experience!;
  const [answers, setAnswers] = useState<ExperienceAnswer[]>(record.answers);
  const [revision, setRevision] = useState(record.revision);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  const update = (questionId: string, patch: Partial<ExperienceAnswer>) => {
    setDirty(true);
    setMessage("");
    setError("");
    setAnswers((current) => {
      const prior = current.find((a) => a.questionId === questionId) ?? {
        questionId,
        status: "answered" as const,
        text: "",
      };
      return [
        ...current.filter((a) => a.questionId !== questionId),
        { ...prior, ...patch },
      ];
    });
  };
  const save = async (submit: boolean) => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result: WorkflowRun = await workflowCall("experience-save", {
        runId: run.runId,
        taskId: run.task!.taskId,
        expectedRevision: revision,
        answers,
        submit,
      });
      setRevision(result.experience!.revision);
      setDirty(false);
      setMessage(
        submit
          ? "답변을 제출했어요. 추가 요청 확인 단계에 연결됐습니다."
          : "답변을 임시저장했어요.",
      );
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="experience-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save(true);
      }}
    >
      <h4>{record.form.title}</h4>
      <p>{record.form.introduction}</p>
      <p className="experience-note">
        메모하듯 적어도 괜찮아요. 기억나지 않는 내용이나 글에 넣고 싶지 않은
        내용은 그대로 표시해주세요. 답변을 제출하기 전에는 초안을 쓰지 않아요.
      </p>
      <details>
        <summary>미리 확인한 자료</summary>
        <ul>
          {record.form.facts.map((fact, i) => (
            <li key={i}>
              <span>
                {fact.status === "confirmed"
                  ? "확인"
                  : fact.status === "observed"
                    ? "사진 관찰"
                    : "미확인"}
              </span>{" "}
              {fact.text}
              <small>근거: {fact.source}</small>
            </li>
          ))}
        </ul>
      </details>
      {record.form.questions.map((q, i) => {
        const answer = answers.find((a) => a.questionId === q.id);
        return (
          <fieldset key={q.id}>
            <legend>
              {i + 1}. {q.section}
            </legend>
            <div className="experience-images">
              {q.images.map((img, index) => (
                <QuestionImage
                  key={img.path}
                  runId={run.runId}
                  questionId={q.id}
                  index={index}
                  caption={img.caption}
                />
              ))}
            </div>
            <label htmlFor={`answer-${q.id}`}>
              {q.prompt}
              {!q.required && " (선택)"}
            </label>
            {q.help && <p id={`help-${q.id}`}>{q.help}</p>}
            <select
              aria-label={`${q.section} 답변 상태`}
              value={answer?.status ?? ""}
              onChange={(e) =>
                update(q.id, {
                  status: e.target.value as ExperienceAnswer["status"],
                })
              }
              disabled={busy}
            >
              <option value="" disabled>
                답변 상태 선택
              </option>
              <option value="answered">직접 적기</option>
              <option value="unknown">기억나지 않음</option>
              <option value="omit">본문에서 제외</option>
            </select>
            <textarea
              id={`answer-${q.id}`}
              aria-describedby={`help-${q.id}`}
              value={answer?.text ?? ""}
              onChange={(e) =>
                update(q.id, {
                  text: e.target.value,
                  status: answer?.status ?? "answered",
                })
              }
              placeholder={
                answer?.status === "unknown" || answer?.status === "omit"
                  ? "남길 메모가 있으면 적어주세요 (선택)"
                  : "그때 기억나는 대로 적어주세요"
              }
              disabled={busy}
            />
          </fieldset>
        );
      })}
      {error && (
        <p role="alert" className="workflow-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {dirty && <p role="status">아직 저장하지 않은 답변이 있어요.</p>}
      <div className="experience-actions">
        <button type="button" disabled={busy} onClick={() => void save(false)}>
          답변 임시저장
        </button>
        <button disabled={busy}>한 번에 제출 · 요청 확인</button>
      </div>
    </form>
  );
}
