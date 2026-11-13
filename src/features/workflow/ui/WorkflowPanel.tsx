import { DefinitionFlow } from "./DefinitionFlow";
import {
  builtinDefinitionLabels,
  builtinDefinitionNames,
} from "../../../shared/workflow-definition";
import { FormInbox } from "./FormInbox";
import { errorMessage } from "../../../shared/lib/errors";
import { ExperienceForm } from "./ExperienceForm";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  canReopenFollowups,
  currentFollowup,
  requiresSessionWork,
  runStatusLabels,
  stageLabels,
  workflowStepLabel,
  visibleStages,
  type WorkflowAction,
  type WorkflowRun,
} from "../../../shared/workflow";
import "./workflow.css";

import { workflowCall } from "../../../shared/workflow-client";
import { SdkProgress } from "../../../shared/ui/SdkProgress";
import { ConversationFeed } from "../../../shared/ui/ConversationFeed";
import { MarkdownView } from "../../../shared/ui/MarkdownView";
import { createRunInput } from "../model/create-input";
import { TaskResult, type ResultDraft } from "./TaskResult";
const request = (action = "", input?: unknown) =>
  workflowCall((action.replace(/^\//, "") || "list") as WorkflowAction, input);
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
  return <SharedWorkspace openRunRequest={openRunRequest} />;
}
type OpenRunRequest = { runId: string; sequence: number };
/** Desktop only: why the app cannot use its workflow server (outdated or failed to start). */
function useWorkflowHostNotice() {
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void window.reels?.workflow
      ?.hostStatus?.()
      .then((status) => {
        if (active && (status.state === "stale" || status.state === "error"))
          setMessage(status.message ?? "워크플로 서버에 연결하지 못했어요.");
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  return message;
}
function SharedWorkspace({
  openRunRequest,
}: {
  openRunRequest?: OpenRunRequest;
}) {
  const [runFormDirty, setRunFormDirty] = useState(false);
  const [inboxDirty, setInboxDirty] = useState(false);
  const [view, setView] = useState(
    new URLSearchParams(location.search).has("form") ? "forms" : "runs",
  );
  const [formsVisited, setFormsVisited] = useState(view === "forms");
  const [runRequest, setRunRequest] = useState<OpenRunRequest>();
  const [notice, setNotice] = useState("");
  const hostNotice = useWorkflowHostNotice();
  const handledRequest = useRef<number | undefined>(undefined);
  const formDirty = runFormDirty || inboxDirty;
  useEffect(() => {
    if (!openRunRequest || handledRequest.current === openRunRequest.sequence)
      return;
    handledRequest.current = openRunRequest.sequence;
    if (formDirty) {
      setNotice(
        "다른 작업의 알림이 도착했어요. 작성 중인 답변을 먼저 저장한 뒤 알림을 다시 열어주세요.",
      );
      return;
    }
    setNotice("");
    setRunRequest(openRunRequest);
    setView("runs");
  }, [openRunRequest, formDirty]);
  return (
    <>
      {hostNotice && (
        <p className="workflow-host-notice" role="alert">
          {hostNotice}
        </p>
      )}
      <nav className="workflow-surfaces" aria-label="작업 보기">
        <button
          aria-pressed={view === "runs"}
          disabled={formDirty}
          onClick={() => {
            setView("runs");
            setNotice("");
          }}
        >
          대시보드 실행
        </button>
        <button
          aria-pressed={view === "forms"}
          disabled={formDirty}
          onClick={() => {
            setFormsVisited(true);
            setView("forms");
            setNotice("");
          }}
        >
          입력폼·답변·결과
        </button>
      </nav>
      {notice && (
        <p className="workflow-open-notice" role="status">
          {notice}
        </p>
      )}
      {formsVisited && (
        <div hidden={view !== "forms"}>
          <FormInbox onDirtyChange={setInboxDirty} />
        </div>
      )}
      <div hidden={view !== "runs"}>
        <ConnectedWorkflowPanel
          openRunRequest={runRequest}
          onDirtyChange={setRunFormDirty}
          formDirty={formDirty}
        />
      </div>
    </>
  );
}
function ConnectedWorkflowPanel({
  openRunRequest,
  onDirtyChange,
  formDirty,
}: {
  openRunRequest?: OpenRunRequest;
  onDirtyChange: (dirty: boolean) => void;
  formDirty: boolean;
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
  const [definitionFile, setDefinitionFile] = useState("");
  const [builtinDefinition, setBuiltinDefinition] = useState("");
  const usesDefinition = !!(definitionFile || builtinDefinition);
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
    if (run?.runId !== openRunId && formDirty) {
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
  }, [openRunId, openRunRequest?.sequence, runs, run?.runId, formDirty]);
  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
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
        <button disabled={formDirty} onClick={() => setCreating(!creating)}>
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
              const created = await request(
                "/create",
                createRunInput(form, {
                  usesDefinition,
                  builtinDefinition,
                  definitionFile,
                }),
              );
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
            앱 내장 워크플로 (선택)
            <select
              name="builtinDefinition"
              value={builtinDefinition}
              onChange={(e) => setBuiltinDefinition(e.target.value)}
            >
              <option value="">사용 안 함</option>
              {builtinDefinitionNames.map((name) => (
                <option key={name} value={name}>
                  {builtinDefinitionLabels[name]}
                </option>
              ))}
            </select>
          </label>
          <label>
            워크플로 YAML (선택 · 작업 폴더 기준 상대 경로, 또는 상위 폴더
            workflows/ 아래 공통 정의의 절대 경로)
            <input
              name="definitionFile"
              value={definitionFile}
              disabled={!!builtinDefinition}
              onChange={(e) => setDefinitionFile(e.target.value)}
              placeholder="workflow.yaml"
            />
          </label>
          {usesDefinition && (
            <label>
              로컬 가이드 파일 (선택 · 단계별로 읽을 문서·추가 지시·스킬, 같은
              경로 규칙)
              <input name="guideFile" placeholder="workflow.guides.yaml" />
            </label>
          )}
          <label>
            연결할 프로젝트 ID (선택)
            <input name="projectId" placeholder="Dashboard 프로젝트 ID" />
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
          {usesDefinition && (
            <label className="experience-toggle">
              <input type="checkbox" name="skipCompleted" defaultChecked />
              이미 끝난 단계(산출물이 있고 유효함)는 넘어가기 · 검토 단계는 항상
              실행
            </label>
          )}
          <label className="experience-toggle">
            <input
              type="checkbox"
              name="experience"
              defaultChecked
              disabled={usesDefinition}
            />
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
              disabled={formDirty}
              aria-pressed={run?.runId === r.runId}
              onClick={() => {
                setSelected(r.runId);
                setError("");
              }}
            >
              <strong>{r.title}</strong>
              <small>
                {runStatusLabels[r.status]} · {workflowStepLabel(r)}
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
              {run.definition ? (
                <DefinitionFlow run={run} />
              ) : (
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
              )}
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
              {canReopenFollowups(run) && (
                <button
                  disabled={
                    busy || formDirty || run.execution?.status === "running"
                  }
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
                    title: workflowStepLabel(run, item.stepId, item.stage),
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
                  <h4>현재 요청 · {workflowStepLabel(run)}</h4>
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
                    <MarkdownView>{run.task.instruction}</MarkdownView>
                  )}
                  {run.stage !== "experience" && <code>{run.task.taskId}</code>}
                  {run.stage === "experience" && run.experience ? (
                    <ExperienceForm
                      key={run.task.taskId}
                      record={run.experience}
                      onDirtyChange={onDirtyChange}
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
                  {run.definition
                    ? "정의된 완료 지점에 도달했어요. 실제 결과는 단계별 근거에서 확인해주세요."
                    : "문안·화면 검토를 통과했어요. 이관·게시 완료를 뜻하지 않습니다."}
                </p>
              )}
              {run.status === "blocked" && (
                <p role="status">
                  {run.blockedReason && <span>{run.blockedReason} </span>}
                  미해결 항목을 확인해주세요. 재개해도 수정 횟수는 초기화되지
                  않습니다.
                </p>
              )}
              {run.status !== "cancelled" && (
                <button
                  disabled={
                    busy || formDirty || run.execution?.status === "running"
                  }
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
  skipped: "기존 산출물 채택 · 건너뜀",
};
