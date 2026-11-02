import { ExperienceForm } from "./ExperienceForm";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  stageLabels,
  workflowStages,
  type WorkflowRun,
} from "../../../shared/workflow";
import "./workflow.css";

import { workflowCall } from "../../../shared/workflow-client";
import { SdkProgress } from "../../../shared/ui/SdkProgress";
import { ConversationFeed } from "../../../shared/ui/ConversationFeed";
import { MarkdownView } from "../../../shared/ui/MarkdownView";
import type { WorkflowAction } from "../../../shared/workflow";
const request = (action = "", input?: unknown) =>
  workflowCall((action.replace(/^\//, "") || "list") as WorkflowAction, input);
const statuses = {
  waiting: "작업 대기",
  ready: "검토 완료",
  blocked: "보류",
  cancelled: "취소",
};
export function WorkflowPanel({
  openRunRequest,
}: { openRunRequest?: { runId: string; sequence: number } } = {}) {
  if (location.protocol === "file:" && !window.reels?.workflow)
    return (
      <section className="workflow-panel">
        <h2>제작 워크플로</h2>
        <p>로컬 워크플로 서버의 웹 화면에서 진행 상태를 관리할 수 있어요.</p>
        <a
          href="http://127.0.0.1:4318/?workflow=1"
          target="_blank"
          rel="noreferrer"
        >
          워크플로 웹 화면 열기
        </a>
      </section>
    );
  return <ConnectedWorkflowPanel openRunRequest={openRunRequest} />;
}
function ConnectedWorkflowPanel({
  openRunRequest,
}: {
  openRunRequest?: { runId: string; sequence: number };
}) {
  const openRunId = openRunRequest?.runId;
  const resultDrafts = useRef(new Map<string, ResultDraft>());
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selected, setSelected] = useState(
    new URLSearchParams(location.search).get("run") ?? "",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [openNotice, setOpenNotice] = useState("");
  const handledOpenRun = useRef<number | undefined>(undefined);
  const refresh = useCallback(async () => {
    const data = await request();
    setRuns(data.runs);
  }, []);
  useEffect(() => {
    let active = true;
    const load = () => {
      void request()
        .then((data) => {
          if (active) setRuns(data.runs);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    };
    load();
    const timer = setInterval(load, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const run = runs.find((r) => r.runId === selected) ?? runs[0];
  useEffect(() => {
    if (
      !openRunId ||
      handledOpenRun.current === openRunRequest?.sequence ||
      !runs.length
    )
      return;
    handledOpenRun.current = openRunRequest?.sequence;
    if (run?.runId !== openRunId && run?.stage === "experience") {
      setOpenNotice(
        "다른 작업의 알림이 도착했어요. 작성 중인 경험 답변을 저장한 뒤 작업 목록에서 열어주세요.",
      );
      return;
    }
    if (!runs.some((item) => item.runId === openRunId)) {
      setOpenNotice("알림의 작업을 목록에서 찾을 수 없어요.");
      return;
    }
    setSelected(openRunId);
    setOpenNotice("");
  }, [openRunId, openRunRequest?.sequence, runs, run?.runId, run?.stage]);
  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="workflow-panel">
      <header className="workflow-heading">
        <div>
          <h2>제작 워크플로</h2>
          <p>
            이 세션에서 결과를 제출하거나, Codex로 현재 단계를 실행할 수 있어요.
          </p>
        </div>
        <button onClick={() => setCreating(!creating)}>
          {creating ? "닫기" : "새 워크플로"}
        </button>
      </header>
      {openNotice && <p role="status">{openNotice}</p>}
      {error && (
        <p className="workflow-error" role="alert">
          {error}
        </p>
      )}
      {creating && (
        <form
          className="workflow-create"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void perform(async () => {
              const created = await request("/create", {
                title: form.get("title"),
                workspace: form.get("workspace"),
                instructions: form.get("instructions"),
                trackedFiles: String(form.get("files"))
                  .split("\n")
                  .map((s) => s.trim())
                  .filter(Boolean),
                maxRevisions: Number(form.get("maxRevisions")),
                collectExperience: form.get("experience") === "on",
              });
              setSelected(created.runId);
              setCreating(false);
            });
          }}
        >
          <label>
            제목
            <input name="title" required placeholder="이번 글의 제작 작업" />
          </label>
          <label>
            작업 폴더
            <input
              name="workspace"
              required
              placeholder="/absolute/path/to/content"
            />
          </label>
          <label>
            작성·검토 기준
            <textarea
              name="instructions"
              required
              placeholder="목표와 준수할 문서의 위치를 적어주세요."
            />
          </label>
          <label>
            기존 근거 파일 (폴더 기준 상대 경로, 한 줄에 하나)
            <textarea name="files" required placeholder="source-notes.md" />
          </label>
          <label>
            전체 수정 루프 한도
            <input
              name="maxRevisions"
              type="number"
              min="1"
              max="5"
              defaultValue="2"
            />
          </label>
          <label className="experience-toggle">
            <input type="checkbox" name="experience" defaultChecked />
            자료 준비 후 내 경험을 한 폼으로 받기
          </label>
          <button disabled={busy}>워크플로 시작</button>
        </form>
      )}
      <div className="workflow-columns">
        <aside aria-label="워크플로 목록">
          {runs.map((r) => (
            <button
              key={r.runId}
              aria-pressed={run?.runId === r.runId}
              onClick={() => {
                setSelected(r.runId);
                setError("");
              }}
            >
              <strong>{r.title}</strong>
              <small>
                {statuses[r.status]} · {stageLabels[r.stage]}
              </small>
            </button>
          ))}
          {!runs.length && <p>아직 실행한 작업이 없어요.</p>}
        </aside>
        <div className="workflow-detail">
          {run ? (
            <>
              <div className="workflow-heading">
                <h3>{run.title}</h3>
                <span>{statuses[run.status]}</span>
              </div>
              <ol className="workflow-stages" aria-label="제작 단계">
                {workflowStages
                  .filter(
                    (s) =>
                      s !== "revise" &&
                      (!["experience", "requests", "followup"].includes(s) ||
                        run.collectExperience),
                  )
                  .map((stage) => (
                    <li
                      key={stage}
                      aria-current={
                        run.stage === stage ||
                        (stage === "draft" && run.stage === "revise")
                          ? "step"
                          : undefined
                      }
                    >
                      {stageLabels[stage]}
                    </li>
                  ))}
              </ol>
              <p>
                수정 {run.revisions}회 / 한도 {run.maxRevisions}회 · 최종 발행은
                수동입니다.
              </p>
              <details>
                <summary>작업 맥락과 파일</summary>
                <p>{run.workspace}</p>
                <MarkdownView>{run.instructions}</MarkdownView>
                <ul>
                  {run.trackedFiles.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
                <small>실행 ID: {run.runId}</small>
              </details>
              {run.followups && (
                <section
                  aria-label="추가 요청 작업 목록"
                  className="workflow-followups"
                >
                  <h4>답변에서 분리한 추가 작업</h4>
                  {run.followups.tasks.length ? (
                    <ol>
                      {run.followups.tasks.map((item) => (
                        <li key={item.id}>
                          <strong>
                            {item.title} ·{" "}
                            {item.status === "done"
                              ? "처리 완료"
                              : item.status === "blocked"
                                ? "보류"
                                : "대기"}
                          </strong>
                          <blockquote>{item.sourceQuote}</blockquote>
                          {item.summary && <p>{item.summary}</p>}
                          <small>
                            {Object.keys(item.evidence).join(" · ")}
                          </small>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p>
                      분류 결과를 기다리거나, 추가 요청이 없는 것으로 확인된
                      상태예요.
                    </p>
                  )}
                </section>
              )}
              {run.experience?.status === "submitted" &&
                run.status === "waiting" &&
                [
                  "draft",
                  "review",
                  "revise",
                  "layout",
                  "visual_review",
                ].includes(run.stage) && (
                  <button
                    disabled={busy || run.execution?.status === "running"}
                    onClick={() =>
                      void perform(() =>
                        request("followups-open", {
                          runId: run.runId,
                          expectedTaskId: run.task!.taskId,
                        }),
                      )
                    }
                  >
                    답변의 추가 요청 다시 확인
                  </button>
                )}
              <h4>작업 이력</h4>
              {run.history.length ? (
                <ConversationFeed
                  label="작업 이력"
                  messages={run.history.map((item) => ({
                    id: item.taskId,
                    sender: "result",
                    senderLabel: "작업 결과",
                    avatar: "작업",
                    at: item.at,
                    title: stageLabels[item.stage],
                    body: item.summary,
                    status: outcomeLabels[item.outcome],
                    tone:
                      item.outcome === "blocked" || item.outcome === "revise"
                        ? "warning"
                        : item.outcome === "cancel"
                          ? "neutral"
                          : "success",
                    evidence: Object.keys(item.evidence),
                  }))}
                />
              ) : (
                <p>이 세션에서 첫 작업을 수행한 뒤 결과를 제출해주세요.</p>
              )}
              {run.task && (
                <article className="workflow-task">
                  <h4>현재 요청 · {stageLabels[run.task.stage]}</h4>
                  {["requests", "followup"].includes(run.stage) ? (
                    <>
                      <p>
                        {run.stage === "requests"
                          ? "경험과 추가 작업 요청을 구분하고 있어요. 필요한 일을 목록으로 정리한 뒤 초안에 반영합니다."
                          : run.followups?.tasks.find(
                              (t) => t.id === run.task?.followupId,
                            )?.instruction}
                      </p>
                      <details>
                        <summary>작업 실행 계약</summary>
                        <pre>{run.task.instruction}</pre>
                      </details>
                    </>
                  ) : (
                    <MarkdownView>{run.task.instruction}</MarkdownView>
                  )}
                  {run.stage !== "experience" && <code>{run.task.taskId}</code>}
                  {run.stage === "experience" && run.experience ? (
                    <ExperienceForm
                      key={run.task.taskId}
                      run={run}
                      onSaved={refresh}
                    />
                  ) : (
                    <>
                      <button
                        disabled={
                          busy ||
                          run.execution?.status === "running" ||
                          (run.stage === "followup" &&
                            run.followups?.tasks.find(
                              (t) => t.id === run.task?.followupId,
                            )?.executor === "session")
                        }
                        onClick={() =>
                          void perform(() =>
                            request("/execute", {
                              runId: run.runId,
                              taskId: run.task!.taskId,
                            }),
                          )
                        }
                      >
                        {run.stage === "followup" &&
                        run.followups?.tasks.find(
                          (t) => t.id === run.task?.followupId,
                        )?.executor === "session"
                          ? "제작 세션에서 처리할 작업"
                          : "Codex로 현재 단계 실행"}
                      </button>
                      <TaskResult
                        key={run.task.taskId}
                        run={run}
                        drafts={resultDrafts.current}
                        busy={busy || run.execution?.status === "running"}
                        onSubmit={(input) =>
                          perform(() => request("/submit", input))
                        }
                      />
                    </>
                  )}
                </article>
              )}
              <SdkProgress
                job={run.execution}
                onStop={(jobId) =>
                  void perform(() => request("/stop", { jobId }))
                }
              />
              {run.status === "ready" && (
                <p role="status">
                  문안·화면 검토를 통과했어요. 이관·게시 완료를 뜻하지 않습니다.
                </p>
              )}
              {run.status === "blocked" && (
                <p role="status">
                  미해결 항목을 확인해주세요. 재개해도 수정 횟수는 초기화되지
                  않습니다.
                </p>
              )}
              {run.status !== "cancelled" && (
                <button
                  disabled={busy || run.execution?.status === "running"}
                  onClick={() =>
                    void perform(() =>
                      request("/restart", { runId: run.runId }),
                    )
                  }
                >
                  {run.status === "waiting"
                    ? "입력 변경 반영 · 현재 요청 갱신"
                    : "다시 검토"}
                </button>
              )}
            </>
          ) : (
            <p>
              워크플로를 시작하면 현재 요청과 검토 이력이 여기에 표시됩니다.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
const outcomeLabels = {
  done: "작업 완료",
  pass: "검토 통과",
  revise: "수정 필요",
  blocked: "근거 부족 · 보류",
  cancel: "작업 취소",
};
interface ResultDraft {
  summary: string;
  evidence: string;
  outcome: string;
}
function TaskResult({
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
  const review = run.stage === "review" || run.stage === "visual_review";
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
        <span>현재 단계 · {stageLabels[run.stage]}</span>
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
