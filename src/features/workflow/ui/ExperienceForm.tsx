import { useEffect, useState } from "react";
import type { InputFormRecord } from "../../../shared/input-forms";
import type { ExperienceAnswer } from "../../../shared/experience";
import { workflowCall } from "../../../shared/workflow-client";

function QuestionImage({
  formId,
  questionId,
  index,
  caption,
}: {
  formId: string;
  questionId: string;
  index: number;
  caption: string;
}) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void workflowCall("form-media", {
      formId,
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
  }, [formId, questionId, index]);
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
function ResultArtifact({ formId, file }: { formId: string; file: string }) {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  return (
    <details
      onToggle={(event) => {
        if (event.currentTarget.open && !text && !error)
          void workflowCall("form-artifact", { formId, path: file })
            .then((r) => setText(r.text))
            .catch((e) => setError(e.message));
      }}
    >
      <summary>결과 문서 읽기 · {file.split("/").at(-1)}</summary>
      {error ? <p role="alert">{error}</p> : <pre>{text || "불러오는 중"}</pre>}
    </details>
  );
}
export function ExperienceForm({
  record,
  onSaved,
  onDirtyChange,
}: {
  record: InputFormRecord;
  onSaved: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [answers, setAnswers] = useState<ExperienceAnswer[]>(record.answers);
  const [revision, setRevision] = useState(record.revision);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
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
  useEffect(() => {
    if (!dirty) {
      setAnswers(record.answers);
      setRevision(record.revision);
    }
  }, [record.revision]);
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
      const result: InputFormRecord = await workflowCall("form-save", {
        formId: record.formId,
        expectedRevision: revision,
        answers,
        submit,
      });
      setRevision(result.revision);
      setDirty(false);
      setMessage(
        submit
          ? "답변을 제출했어요. 작업자가 같은 답변을 이어받을 수 있어요."
          : "답변을 임시저장했어요.",
      );
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  if (record.status === "submitted" && !dirty)
    return (
      <section className="experience-form" aria-label="제출된 답변">
        <h4>{record.form.title}</h4>
        <p role="status">
          {record.applications.length
            ? "답변 반영 기록이 있어요"
            : "답변 제출 완료 · 반영 대기"}
        </p>
        {record.form.questions.map((q) => {
          const a = record.answers.find((a) => a.questionId === q.id);
          return (
            <details key={q.id}>
              <summary>
                {q.section} ·{" "}
                {a?.status === "answered"
                  ? "답변"
                  : a?.status === "unknown"
                    ? "기억나지 않음"
                    : a?.status === "omit"
                      ? "본문 제외"
                      : "미응답"}
              </summary>
              <p>{q.prompt}</p>
              <p style={{ whiteSpace: "pre-wrap" }}>{a?.text || "내용 없음"}</p>
            </details>
          );
        })}
        <h4>반영 결과</h4>
        {record.applications.map((a, i) => (
          <article key={i}>
            <p>{a.summary}</p>
            <small>{new Date(a.at).toLocaleString()}</small>
            <ul>
              {Object.keys(a.evidence).map((file) => (
                <li key={file}>
                  <ResultArtifact formId={record.formId} file={file} />
                </li>
              ))}
            </ul>
          </article>
        ))}
        {!record.applications.length && (
          <p>
            아직 반영 결과가 등록되지 않았어요. 답변 원문은 저장되어 있습니다.
          </p>
        )}
      </section>
    );
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
                  formId={record.formId}
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
