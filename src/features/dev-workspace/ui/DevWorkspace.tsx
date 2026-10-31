import { useEffect, useRef, useState } from "react";
import {
  phaseLabels,
  workPrompt,
  type AgentProvider,
  type WorkPhase,
  type WorkbenchBridge,
  type WorkbenchState,
  type TerminalKind,
} from "../../../shared/workbench";
import { TerminalPane } from "./TerminalPane";
import {
  reconcileSelection,
  shortcutHint,
  toggleDrawer,
  type DrawerMode,
} from "../model/shortcuts";
import { useWorkbenchShortcuts } from "../model/useWorkbenchShortcuts";
import "./workbench.css";

export function DevWorkspace({
  api,
  mode,
  onModeChange,
  onNavigate,
  openSite,
}: {
  api: WorkbenchBridge;
  mode: DrawerMode;
  onModeChange: (mode: DrawerMode) => void;
  onNavigate: (index: number) => void;
  openSite?: () => Promise<void>;
}) {
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [selected, setSelected] = useState("");
  const [provider, setProvider] = useState<AgentProvider | null>(null);
  const [phase, setPhase] = useState<WorkPhase>("implement");
  const [task, setTask] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  const [version, setVersion] = useState(0);
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const previousSessions = useRef<string[]>([]);
  const acceptState = (next: WorkbenchState) => {
    const previous = previousSessions.current;
    const ids = next.sessions.map((session) => session.id);
    previousSessions.current = ids;
    setState(next);
    setProvider((id) =>
      next.providers.some((option) => option.id === id)
        ? id
        : next.defaultProvider,
    );
    setSelected((id) => reconcileSelection(previous, ids, id));
  };
  useEffect(() => {
    let live = true;
    const refresh = () =>
      api
        .state()
        .then((s) => {
          if (!live) return;
          acceptState(s);
        })
        .catch((e) => {
          if (live) setError(String(e));
        });
    const off = api.onEvent((event) => {
      if (event.type === "changed") void refresh();
    });
    void refresh();
    return () => {
      live = false;
      off();
    };
  }, [api]);
  const run = async (fn: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  const start = (kind: TerminalKind) =>
    run(async () => {
      const session = await api.start({
        kind,
        ...(kind === "codex" || kind === "claude" ? { phase, task } : {}),
      });
      acceptState(await api.state());
      setSelected(session.id);
      onModeChange("open");
    });
  const closeSession = (id: string) =>
    run(async () => {
      await api.close(id);
      acceptState(await api.state());
    });
  useWorkbenchShortcuts(api, (action) => {
    switch (action.type) {
      case "toggle":
        onModeChange(toggleDrawer(mode));
        break;
      case "newTerminal":
        onModeChange("open");
        if (state?.workspace) void start("shell");
        else setError("먼저 앱 소스 폴더를 연결해주세요.");
        break;
      case "close":
        if (mode !== "open") void run(() => api.hideWindow());
        else if (selected) void closeSession(selected);
        else onModeChange("closed");
        break;
      case "selectIndex":
        if (mode !== "open") onNavigate(action.index);
        else if (state?.sessions[action.index])
          setSelected(state.sessions[action.index].id);
        break;
    }
  });
  const session = state?.sessions.find((s) => s.id === selected);
  const runningPreview = state?.sessions.some(
    (s) => s.kind === "preview" && s.state === "running",
  );
  return (
    <section
      className="dev-workspace"
      aria-label="터미널"
      data-drawer-state={mode}
      hidden={mode === "closed"}
    >
      <header className="dev-drawer-header">
        <strong>터미널</strong>
        <span className="dev-drawer-hint">
          {shortcutHint("toggle")} 열기·접기 · {shortcutHint("close")}{" "}
          {mode === "open" ? "세션 닫기" : "창 숨기기"}
        </span>
        <button
          className="primary"
          disabled={busy || !state?.workspace || !provider}
          onClick={() => provider && start(provider)}
          title={`${phaseLabels[phase]} 단계로 세션을 시작해요`}
        >
          {state?.providers.find((option) => option.id === provider)?.label ??
            "코딩 도구"}{" "}
          시작
        </button>
        <button
          disabled={busy || !state?.workspace}
          onClick={() => start("shell")}
          title={shortcutHint("newTerminal")}
          aria-label="새 터미널"
        >
          새 터미널 <kbd>{shortcutHint("newTerminal")}</kbd>
        </button>
        <button
          aria-label={
            mode === "open" ? "터미널 접기" : "터미널 펼치기"
          }
          onClick={() => onModeChange(toggleDrawer(mode))}
        >
          {mode === "open" ? "접기" : "펼치기"}
        </button>
        <button
          aria-label="터미널 닫기"
          title="패널만 숨기고 세션은 유지해요"
          onClick={() => onModeChange("closed")}
        >
          닫기
        </button>
      </header>
      <div
        className="dev-session-tabs"
        hidden={mode !== "open"}
        role="tablist"
        aria-label="터미널 세션"
      >
        {state?.sessions.map((s, index) => (
          <div className="dev-session-tab" key={s.id}>
            <button
              role="tab"
              id={`dev-tab-${s.id}`}
              aria-controls={`dev-panel-${s.id}`}
              aria-selected={s.id === selected}
              onClick={() => setSelected(s.id)}
              title={shortcutHint("selectIndex", index)}
            >
              {s.title} ·{" "}
              {s.state === "running" ? "실행 중" : `종료 ${s.exitCode ?? ""}`}
              {index < 9 && <kbd>{shortcutHint("selectIndex", index)}</kbd>}
            </button>
            <button
              disabled={busy}
              aria-label={`${s.title} 세션 닫기`}
              title="프로세스를 종료하고 탭을 닫아요"
              onClick={() => closeSession(s.id)}
            >
              ×
            </button>
          </div>
        ))}
        {!state?.sessions.length && (
          <span>세션을 시작하면 이곳에 터미널이 열려요.</span>
        )}
      </div>
      <div className="dev-drawer-body" hidden={mode !== "open"}>
        <details className="dev-setup">
          <summary>소스 연결 · 개선 요청 · 코딩 도구</summary>
          <div className="dev-connect">
            <div>
              <strong>Reels Dashboard 소스</strong>
              <code>{state?.workspace ?? "앱 소스 폴더를 연결해주세요"}</code>
            </div>
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  acceptState(await api.chooseWorkspace());
                })
              }
            >
              소스 폴더 연결
            </button>
            {openSite && (
              <button disabled={busy} onClick={() => run(openSite)}>
                운영 브리핑 사이트
              </button>
            )}
          </div>
          <div className="dev-loop" aria-label="개선 단계">
            {(Object.keys(phaseLabels) as WorkPhase[]).map((p, i) => (
              <button
                key={p}
                aria-pressed={phase === p}
                onClick={() => setPhase(p)}
              >
                <small>0{i + 1}</small>
                {phaseLabels[p]}
              </button>
            ))}
          </div>
          <div className="dev-compose">
            <label htmlFor="dev-task">
              개선 요청 · 이전 단계 결과와 리뷰 지적
            </label>
            <textarea
              id="dev-task"
              value={task}
              maxLength={16000}
              onChange={(e) => setTask(e.target.value)}
              placeholder="개선할 동작과 완료 기준을 적으세요. 다음 단계에서는 이전 결과나 리뷰 지적을 함께 전달하세요."
              rows={3}
            />
            <div className="dev-actions">
              <label>
                코딩 도구{" "}
                <select
                  aria-label="코딩 도구"
                  value={provider ?? ""}
                  disabled={busy || !state}
                  onChange={(e) => setProvider(e.target.value as AgentProvider)}
                >
                  {state?.providers.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="primary"
                disabled={busy || !state?.workspace || !provider}
                onClick={() => provider && start(provider)}
              >
                {phaseLabels[phase]} 세션 시작
              </button>
              <button
                disabled={busy || !task.trim()}
                onClick={() =>
                  run(async () => {
                    await navigator.clipboard.writeText(
                      workPrompt(phase, task),
                    );
                    setNotice(
                      "프롬프트를 복사했어요. 진행 중인 세션에 붙여넣어 이어갈 수 있어요.",
                    );
                  })
                }
              >
                현재 세션용 프롬프트 복사
              </button>
              <button
                disabled={busy || !state?.workspace}
                onClick={() => start("shell")}
              >
                일반 터미널
              </button>
              <button
                disabled={busy || !state?.workspace}
                onClick={() => start("checks")}
              >
                검증 실행
              </button>
            </div>
            <p className="dev-hint">
              세션은 선택한 폴더에서 실행돼요. 같은 파일의 구현·수정은 한
              세션에서 진행하고, 결과를 다음 단계에 전달하세요. 탭 전환은 세션을
              유지하고 앱 종료는 세션을 종료해요.
            </p>
            <details>
              <summary>실행할 단계 프롬프트</summary>
              <pre>{workPrompt(phase, task || "(입력한 요청)")}</pre>
            </details>
          </div>
        </details>
        {error && (
          <p className="dev-error" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <div className={`dev-panels ${preview ? "with-preview" : ""}`}>
          <div className="dev-console">
            {session ? (
              <>
                <div className="dev-session-meta">
                  <code>{session.cwd}</code>
                  <button
                    disabled={busy || session.state !== "running"}
                    onClick={() => run(() => api.write(session.id, "\x03"))}
                  >
                    Ctrl+C
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        session.state === "running"
                          ? api.stop(session.id)
                          : api.remove(session.id),
                      )
                    }
                  >
                    {session.state === "running"
                      ? "세션 종료"
                      : "목록에서 지우기"}
                  </button>
                </div>
              </>
            ) : (
              <div className="dev-terminal-empty">
                <strong>코드에서 미리보기까지</strong>
                <p>
                  코딩 도구로 소스를 수정하고,
                  <br />
                  검증 결과와 사이트 화면을 확인하세요.
                </p>
              </div>
            )}
            {state?.sessions.map((item) => (
              <div
                key={item.id}
                role="tabpanel"
                id={`dev-panel-${item.id}`}
                aria-labelledby={`dev-tab-${item.id}`}
                data-session-id={item.id}
                hidden={selected !== item.id}
              >
                <TerminalPane
                  api={api}
                  id={item.id}
                  active={mode === "open" && selected === item.id}
                />
              </div>
            ))}
          </div>
          {preview && (
            <div className="dev-preview">
              <div className="dev-preview-bar">
                <strong>로컬 웹 · 예시 데이터</strong>
                <button onClick={() => setVersion((v) => v + 1)}>
                  새로고침
                </button>
                <button onClick={() => setPreview(false)}>닫기</button>
              </div>
              <iframe
                key={version}
                title="로컬 대시보드 미리보기"
                src={state?.previewURL}
                sandbox="allow-scripts allow-same-origin"
              />
            </div>
          )}
        </div>
        <div className="dev-actions dev-preview-actions">
          <button
            disabled={busy || !state?.workspace || runningPreview}
            onClick={() => start("preview")}
          >
            미리보기 서버 시작
          </button>
          <button disabled={!runningPreview} onClick={() => setPreview(true)}>
            미리보기 나란히 보기
          </button>
          <button
            disabled={busy || !runningPreview}
            onClick={() => run(() => api.openPreview())}
          >
            브라우저에서 열기
          </button>
          <span>
            서버의 준비 완료 로그를 확인한 뒤 열어주세요. 웹 변경은 자동
            반영돼요.
          </span>
        </div>
        <p className="dev-hint">
          검증: 타입 → 구조 → 단위 테스트 → 빌드. Electron main·preload 변경은
          새 앱 빌드 후 별도 실행으로 확인하세요. AI 로그인과 권한 요청은
          터미널에서 처리해요.
        </p>
        <p className="dev-hint">
          탭의 ×와 {shortcutHint("close")}는 선택한 프로세스를 종료해요.
          접기·패널 닫기는 세션을 유지하며, 앱 종료 시 모든 세션을 종료해요.
        </p>
      </div>
    </section>
  );
}
