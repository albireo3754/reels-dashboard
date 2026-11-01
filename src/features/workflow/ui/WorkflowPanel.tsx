import { ExperienceForm } from "./ExperienceForm";
import { useCallback, useEffect, useState } from "react";
import {
  canReopenFollowups,
  currentFollowup,
  isReviewStage,
  requiresSessionWork,
  runStatusLabels,
  stageLabels,
  visibleStages,
  type WorkflowAction,
  type WorkflowRun,
} from "../../../shared/workflow";
import "./workflow.css";

import { workflowCall } from "../../../shared/workflow-client";
import { SdkProgress } from "../../../shared/ui/SdkProgress";
const request = (action = "", input?: unknown) =>
  workflowCall((action.replace(/^\//, "") || "list") as WorkflowAction, input);
export function WorkflowPanel() {
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
  return <ConnectedWorkflowPanel />;
}
function ConnectedWorkflowPanel() {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [selected, setSelected] = useState(
    new URLSearchParams(location.search).get("run") ?? "",
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
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
                {runStatusLabels[r.status]} · {stageLabels[r.stage]}
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
                <span>{runStatusLabels[run.status]}</span>
              </div>
              <ol className="workflow-stages" aria-label="제작 단계">
                {visibleStages(run).map((stage) => (
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
                <pre>{run.instructions}</pre>
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
              {canReopenFollowups(run) && (
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
              {run.task && (
                <article className="workflow-task">
                  <h4>현재 요청 · {stageLabels[run.task.stage]}</h4>
                  {["requests", "followup"].includes(run.stage) ? (
                    <>
                      <p>
                        {run.stage === "requests"
                          ? "경험과 추가 작업 요청을 구분하고 있어요. 필요한 일을 목록으로 정리한 뒤 초안에 반영합니다."
                          : currentFollowup(run)?.instruction}
                      </p>
                      <details>
                        <summary>작업 실행 계약</summary>
                        <pre>{run.task.instruction}</pre>
                      </details>
                    </>
                  ) : (
                    <p>{run.task.instruction}</p>
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
                          requiresSessionWork(run)
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
                        {requiresSessionWork(run)
                          ? "제작 세션에서 처리할 작업"
                          : "Codex로 현재 단계 실행"}
                      </button>
                      <TaskResult
                        key={run.task.taskId}
                        run={run}
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
              <h4>작업 이력</h4>
              {run.history.length ? (
                <ol className="workflow-history">
                  {run.history.map((item) => (
                    <li key={item.taskId}>
                      <strong>
                        {stageLabels[item.stage]} · {item.outcome}
                      </strong>
                      <p>{item.summary}</p>
                      <small>{new Date(item.at).toLocaleString()}</small>
                      <ul>
                        {Object.keys(item.evidence).map((f) => (
                          <li key={f}>{f}</li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>이 세션에서 첫 작업을 수행한 뒤 결과를 제출해주세요.</p>
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
function TaskResult({
  run,
  busy,
  onSubmit,
}: {
  run: WorkflowRun;
  busy: boolean;
  onSubmit: (input: unknown) => Promise<void>;
}) {
  const review = isReviewStage(run.stage);
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
        결과
        <select name="outcome" aria-label="결과">
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
      <label>
        판단·변경 내용
        <textarea name="summary" required />
      </label>
      <label>
        결과·검토 근거 파일 (상대 경로, 한 줄에 하나)
        <textarea name="evidence" />
      </label>
      <button disabled={busy}>결과 제출</button>
    </form>
  );
}
