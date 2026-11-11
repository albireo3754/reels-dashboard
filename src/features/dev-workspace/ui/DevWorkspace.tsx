import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  phaseLabels,
  workPrompt,
  type AgentProvider,
  type WorkPhase,
  type WorkbenchBridge,
  type WorkbenchState,
  type TerminalBackendId,
  type TerminalKind,
} from "../../../shared/workbench";
import { TerminalPane } from "./TerminalPane";
import { reconcileSelection, toggleDrawer, type DrawerMode } from "../model/drawer";
import { workbenchShortcutTarget } from "../model/shortcut-target";
import {
  dotState,
  menuKeyTarget,
  startChoices,
  tabKeyTarget,
} from "../model/session-tabs";
import {
  acceptsInput,
  appExitNote,
  backendLockReason,
  backendStatus,
  canReattach,
  closeTitle,
  herdrMissingNotice,
  metaAction,
  sessionStateLabel,
} from "../model/backend";
import {
  formatKey,
  goToTab,
  tabIndex,
  type KeyAction,
} from "../../../shared/keymap";
import {
  ShortcutHint,
  useKeymap,
  useShortcut,
} from "../../../shared/ui/shortcuts";
import "./workbench.css";

const DRAWER_ACTIONS = [
  "toggleDrawer",
  "newTerminal",
  "closeTab",
  ...Array.from({ length: 9 }, (_, index) => goToTab(index + 1)!),
] as const satisfies readonly KeyAction[];

export function DevWorkspace({
  api,
  mode,
  onModeChange,
  onNavigate,
  screens,
  openSite,
  feedbackDraft,
  onFeedbackApplied,
  requestedSessionId,
}: {
  api: WorkbenchBridge;
  mode: DrawerMode;
  onModeChange: (mode: DrawerMode) => void;
  onNavigate: (index: number) => void;
  /** How many screens ⌘1-9 can navigate while the drawer is not open. */
  screens: number;
  openSite?: () => Promise<void>;
  feedbackDraft?: { id: number; text: string; phase: "fix" };
  onFeedbackApplied?: (id: number) => void;
  requestedSessionId?: string;
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Arrow-key tab moves keep focus on the tab strip; every other selection hands focus to the terminal.
  const [terminalTakesFocus, setTerminalTakesFocus] = useState(true);
  const menuRoot = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = panel.current;
    const shell = element?.closest<HTMLElement>('.app-shell');
    if (!element || !shell) return;
    const measure = () => shell.style.setProperty('--terminal-height', `${element.getBoundingClientRect().height}px`);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => { observer.disconnect(); shell.style.removeProperty('--terminal-height'); };
  }, []);
  const menuToggle = useRef<HTMLButtonElement>(null);
  const appliedFeedback = useRef<number | null>(null);
  const appliedSession = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!requestedSessionId || appliedSession.current === requestedSessionId ||
        !state?.sessions.some(session => session.id === requestedSessionId)) return;
    appliedSession.current = requestedSessionId;
    setSelected(requestedSessionId);
    setTerminalTakesFocus(true);
  }, [requestedSessionId, state]);
  useEffect(() => {
    if (!feedbackDraft || appliedFeedback.current === feedbackDraft.id) return;
    setSettingsOpen(true);
    const combined = task.trim()
      ? `${task}\n\n${feedbackDraft.text}`
      : feedbackDraft.text;
    if (combined.length > 16000) {
      setNotice("검사 의견을 보관하고 있어요. 기존 요청을 줄이면 이어서 추가돼요.");
      return;
    }
    appliedFeedback.current = feedbackDraft.id;
    setTask(combined);
    setPhase(feedbackDraft.phase);
    setNotice("화면 검사 의견을 기존 요청에 추가했어요. 내용을 확인한 뒤 수정 세션을 시작하세요.");
    onFeedbackApplied?.(feedbackDraft.id);
  }, [feedbackDraft, task, onFeedbackApplied]);
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
      setMenuOpen(false);
      setTerminalTakesFocus(true);
      const session = await api.start({
        kind,
        ...(kind === "codex" || kind === "claude" ? { phase, task } : {}),
      });
      acceptState(await api.state());
      setSelected(session.id);
      onModeChange("open");
    });
  const setBackend = (id: TerminalBackendId) =>
    run(async () => {
      acceptState(await api.setTerminalBackend(id));
    });
  const reattach = (id: string) =>
    run(async () => {
      await api.reattach(id);
      acceptState(await api.state());
    });
  const closeSession = (id: string) =>
    run(async () => {
      await api.close(id);
      acceptState(await api.state());
    });
  const keymap = useKeymap();
  const hint = (action: KeyAction | undefined) =>
    action ? formatKey(keymap[action][0]) : "";
  const sessionIds = state?.sessions.map((s) => s.id) ?? [];
  // The one rule for ⌘1-9 and ⌘W; the handler below and every hint read it.
  const target = (action: KeyAction | undefined) =>
    workbenchShortcutTarget(
      { mode, sessions: sessionIds, selected, screens },
      action,
    );
  useShortcut(DRAWER_ACTIONS, (action) => {
    const to = target(action);
    if (tabIndex(action) !== undefined) {
      if (to?.kind === "screen") onNavigate(to.index);
      else if (to?.kind === "session") {
        setTerminalTakesFocus(true);
        setSelected(to.id);
      }
      return;
    }
    switch (action) {
      case "toggleDrawer":
        onModeChange(toggleDrawer(mode));
        break;
      case "newTerminal":
        onModeChange("open");
        if (state?.workspace) void start("shell");
        else setError("먼저 앱 소스 폴더를 연결해주세요.");
        break;
      case "closeTab":
        if (to?.kind === "hideWindow") void run(() => api.hideWindow());
        else if (to?.kind === "session") void closeSession(to.id);
        else if (to?.kind === "closeDrawer") onModeChange("closed");
        break;
    }
  });
  useEffect(() => {
    if (!menuOpen) return;
    const away = (event: PointerEvent) => {
      if (!menuRoot.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", away);
    menuRoot.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();
    return () => document.removeEventListener("pointerdown", away);
  }, [menuOpen]);
  useEffect(() => {
    if (mode !== "open") setMenuOpen(false);
  }, [mode]);
  useEffect(() => {
    if (mode !== "open" || !selected) return;
    document
      .getElementById(`dev-tab-${selected}`)
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [mode, selected, state?.sessions.length]);
  const onTabKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
      if ((event.target as HTMLElement).getAttribute("role") !== "tab") return;
      event.preventDefault();
      setTerminalTakesFocus(true);
      if (selected) focusTerminal(selected);
      return;
    }
    const ids = sessionIds;
    const current = ids.indexOf(selected);
    const to = tabKeyTarget(event.key, Math.max(current, 0), ids.length);
    if (to === undefined) return;
    event.preventDefault();
    setTerminalTakesFocus(false);
    setSelected(ids[to]);
    document.getElementById(`dev-tab-${ids[to]}`)?.focus();
  };
  const focusTerminal = (id: string) =>
    document
      .querySelector<HTMLElement>(
        `[data-session-id="${id}"] .xterm-helper-textarea`,
      )
      ?.focus();
  const onMenuKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setMenuOpen(false);
      menuToggle.current?.focus();
      return;
    }
    if (event.key === "Tab") {
      setMenuOpen(false);
      return;
    }
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ),
    ];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const to = menuKeyTarget(event.key, at, items.length);
    if (to === undefined) return;
    event.preventDefault();
    items[to]?.focus();
  };
  const session = state?.sessions.find((s) => s.id === selected);
  const choices = startChoices(state?.providers ?? [], task.trim() !== "");
  const canStart = !busy && !!state?.workspace;
  const closing = target("closeTab");
  const runningPreview = state?.sessions.some(
    (s) => s.kind === "preview" && s.state === "running",
  );
  return (
    <section
      ref={panel}
      className="dev-workspace"
      aria-label="터미널"
      data-drawer-state={mode}
      hidden={mode === "closed"}
    >
      <header className="dev-tabbar" data-testid="dev-tabbar">
        <div
          className="dev-session-tabs"
          hidden={mode !== "open" || !state?.sessions.length}
          role="tablist"
          aria-label="터미널 세션"
          onKeyDown={onTabKeyDown}
          onWheel={(event) => {
            // A vertical wheel scrolls the strip sideways, like a browser tab bar.
            if (event.deltaX === 0)
              event.currentTarget.scrollLeft += event.deltaY;
          }}
        >
          {state?.sessions.map((s, index) => (
            <div
              className="dev-session-tab"
              key={s.id}
              data-selected={s.id === selected ? "true" : undefined}
              data-state={dotState(s)}
              onAuxClick={(event) => {
                if (event.button === 1 && !busy) {
                  event.preventDefault();
                  void closeSession(s.id);
                }
              }}
            >
              <button
                role="tab"
                className="dev-tab-main"
                id={`dev-tab-${s.id}`}
                aria-controls={`dev-panel-${s.id}`}
                aria-selected={s.id === selected}
                tabIndex={s.id === selected ? 0 : -1}
                onClick={() => {
                  setTerminalTakesFocus(true);
                  setSelected(s.id);
                }}
                title={`${s.title} · ${sessionStateLabel(s)}${
                  index < 9 ? ` · ${hint(goToTab(index + 1))}` : ""
                }`}
              >
                <span
                  className="dev-tab-dot"
                  data-state={dotState(s)}
                  aria-hidden="true"
                />
                <span className="dev-tab-title">{s.title}</span>
                {s.backend === "herdr" && (
                  <span
                    className="dev-backend-badge"
                    data-testid="dev-backend-badge"
                    data-backend="herdr"
                    data-restored={s.restored ? "true" : undefined}
                    aria-label={
                      s.restored
                        ? "herdr 세션, 이전 실행에서 복원됨"
                        : "herdr 세션"
                    }
                    title={
                      s.restored
                        ? "이전 실행에서 복원한 herdr 세션이에요. 앱을 종료해도 유지돼요."
                        : "herdr가 소유한 세션이에요. 앱을 종료해도 유지돼요."
                    }
                  >
                    herdr
                  </span>
                )}
                <span className="dev-sr-only">{sessionStateLabel(s)}</span>
                <ShortcutHint
                  action={
                    target(goToTab(index + 1))?.kind === "session"
                      ? goToTab(index + 1)
                      : undefined
                  }
                />
              </button>
              {canReattach(s) && (
                <button
                  className="dev-tab-reattach"
                  data-testid="dev-tab-reattach"
                  tabIndex={s.id === selected ? 0 : -1}
                  disabled={busy}
                  aria-label={`${s.title} 다시 연결`}
                  title="이 창으로 세션을 다시 가져와요"
                  onClick={() => reattach(s.id)}
                >
                  다시 연결
                </button>
              )}
              <button
                className="dev-tab-close"
                disabled={busy}
                aria-label={`${s.title} 세션 닫기`}
                title={closeTitle(s)}
                onClick={() => closeSession(s.id)}
              >
                <span aria-hidden="true">×</span>
                <ShortcutHint
                  className="end"
                  action={
                    !busy && closing?.kind === "session" && closing.id === s.id
                      ? "closeTab"
                      : undefined
                  }
                />
              </button>
            </div>
          ))}
        </div>
        <div className="dev-new" ref={menuRoot} hidden={mode !== "open"}>
          <button
            className="dev-new-tab"
            data-testid="dev-new-tab"
            disabled={!canStart}
            onClick={() => start("shell")}
            title={`새 터미널 (${hint("newTerminal")})`}
            aria-label="새 터미널"
          >
            <span aria-hidden="true">+</span>
            {/* run() drops ⌘T while another operation is pending, so hide its hint too. */}
            <ShortcutHint
              action={mode !== "closed" && !busy ? "newTerminal" : undefined}
            />
          </button>
          <button
            ref={menuToggle}
            className="dev-new-menu"
            data-testid="dev-new-menu"
            disabled={!canStart}
            aria-label="새 세션 종류 선택"
            title="터미널, Codex, Claude, 미리보기, 검증"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls="dev-new-menu-list"
            onClick={() => setMenuOpen((open) => !open)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && !menuOpen) {
                event.preventDefault();
                setMenuOpen(true);
              }
            }}
          >
            <span aria-hidden="true">▾</span>
          </button>
          {menuOpen && (
            <div
              id="dev-new-menu-list"
              className="dev-new-list"
              role="menu"
              aria-label="새 세션"
              onKeyDown={onMenuKeyDown}
            >
              {choices.map((choice) => (
                <button
                  key={choice.id}
                  role="menuitem"
                  data-testid={`dev-start-${choice.id}`}
                  disabled={!canStart}
                  title={choice.detail}
                  onClick={() => start(choice.kind)}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <strong className="dev-tabbar-title" hidden={mode === "open"}>
          터미널
          <small>
            {state?.sessions.length
              ? ` · 세션 ${state.sessions.length}개`
              : ""}
          </small>
        </strong>
        <div className="dev-tabbar-actions">
          <button
            className="dev-icon-button"
            data-testid="dev-settings-toggle"
            hidden={mode !== "open"}
            aria-label="터미널 설정"
            aria-expanded={settingsOpen}
            aria-controls="dev-settings"
            title="소스 연결 · 개선 요청 · 코딩 도구 · 세션 유지"
            onClick={() => setSettingsOpen((open) => !open)}
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
            </svg>
          </button>
          <button
            aria-label={mode === "open" ? "터미널 접기" : "터미널 펼치기"}
            title={`${hint("toggleDrawer")} 열기·접기`}
            onClick={() => onModeChange(toggleDrawer(mode))}
          >
            {mode === "open" ? "접기" : "펼치기"}
            <ShortcutHint
              action={mode !== "closed" ? "toggleDrawer" : undefined}
            />
          </button>
          <button
            aria-label="터미널 닫기"
            title="패널만 숨기고 세션은 유지해요"
            onClick={() => onModeChange("closed")}
          >
            닫기
            <ShortcutHint
              action={closing?.kind === "closeDrawer" ? "closeTab" : undefined}
            />
          </button>
        </div>
      </header>
      <div className="dev-drawer-body" hidden={mode !== "open"}>
        <div
          id="dev-settings"
          className="dev-setup"
          data-testid="dev-settings"
          role="group"
          aria-label="소스 연결 · 개선 요청 · 코딩 도구 · 세션 유지"
          hidden={!settingsOpen}
        >
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
          {state && (
            <BackendSetting
              state={state}
              busy={busy}
              onChange={setBackend}
            />
          )}
          <div className="dev-loop" role="group" aria-label="개선 단계">
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
              aria-describedby="dev-task-keys"
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey || event.altKey ||
                    event.ctrlKey || event.metaKey || event.nativeEvent.isComposing ||
                    event.keyCode === 229) return;
                event.preventDefault();
                if (!event.repeat && !pending.current && state?.workspace && provider && task.trim()) {
                  void start(provider);
                }
              }}
              placeholder="개선할 동작과 완료 기준을 적으세요. 다음 단계에서는 이전 결과나 리뷰 지적을 함께 전달하세요."
              rows={3}
            />
            <p id="dev-task-keys" className="dev-hint">Enter로 선택한 도구의 새 세션 시작 · Shift+Enter로 줄바꿈</p>
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
                data-testid="dev-start-selected"
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
            </div>
            <p className="dev-hint">
              탭 바의 Codex 열기·Claude 열기는 이 요청문과 단계를 전달해요.
              요청문이 비어 있으면 요청 없이 대화형으로 열어요. 세션은 선택한
              폴더에서 실행되고, 같은 파일의 구현·수정은 한 세션에서 진행하며
              결과를 다음 단계에 전달하세요. 탭 전환은 세션을 유지해요.{" "}
              {appExitNote(state?.terminalBackend, state?.sessions ?? [])}
            </p>
            <details>
              <summary>실행할 단계 프롬프트</summary>
              <pre>{workPrompt(phase, task || "(입력한 요청)")}</pre>
            </details>
          </div>
          <p className="dev-hint">
            검증: 타입 → 구조 → 단위 테스트 → 빌드. Electron main·preload 변경은
            새 앱 빌드 후 별도 실행으로 확인하세요. AI 로그인과 권한 요청은
            터미널에서 처리해요. 탭의 ×와 {hint("closeTab")}는 선택한 세션을
            종료해요(herdr 세션도 실제로 종료돼요). 접기·패널 닫기는 세션을
            유지해요.
          </p>
        </div>
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
                  {session.backend === "herdr" && (
                    <span className="dev-session-backend">herdr</span>
                  )}
                  {canReattach(session) && (
                    <button
                      className="primary"
                      data-testid="dev-reattach"
                      disabled={busy}
                      onClick={() => reattach(session.id)}
                    >
                      다시 연결
                    </button>
                  )}
                  <button
                    disabled={busy || !acceptsInput(session)}
                    onClick={() => run(() => api.write(session.id, "\x03"))}
                  >
                    Ctrl+C
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        metaAction(session) === "stop"
                          ? api.stop(session.id)
                          : api.remove(session.id),
                      )
                    }
                  >
                    {metaAction(session) === "stop"
                      ? "세션 종료"
                      : "목록에서 지우기"}
                  </button>
                </div>
                {session.state === "detached" && (
                  <p
                    className="dev-session-note"
                    data-testid="dev-detached-note"
                    role="status"
                  >
                    연결이 끊긴 세션이에요. 다른 곳에서 이 세션을 가져갔거나 herdr
                    서버가 다시 시작됐을 수 있어요. 세션은 그대로 살아 있어요.
                    다시 연결하면 이 창으로 가져와요.
                  </p>
                )}
              </>
            ) : (
              <div className="dev-terminal-empty" data-testid="dev-empty">
                <strong>무엇을 열까요?</strong>
                <div className="dev-empty-actions">
                  {choices
                    .filter((choice) => choice.primary)
                    .map((choice) => (
                      <button
                        key={choice.id}
                        className={choice.kind === "shell" ? "" : "primary"}
                        data-testid={`dev-empty-${choice.id}`}
                        disabled={!canStart}
                        title={choice.detail}
                        onClick={() => start(choice.kind)}
                      >
                        {choice.kind === "shell" ? "터미널 열기" : choice.label}
                      </button>
                    ))}
                </div>
                {!state?.workspace && (
                  <p>먼저 설정에서 앱 소스 폴더를 연결해주세요.</p>
                )}
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
                  inputEnabled={acceptsInput(item)}
                  takeFocus={terminalTakesFocus}
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
        {runningPreview && (
          <div className="dev-actions dev-preview-actions">
            <button disabled={preview} onClick={() => setPreview(true)}>
              미리보기 나란히 보기
            </button>
            <button disabled={busy} onClick={() => run(() => api.openPreview())}>
              브라우저에서 열기
            </button>
            <span>
              서버의 준비 완료 로그를 확인한 뒤 열어주세요. 웹 변경은 자동
              반영돼요.
            </span>
          </div>
        )}
      </div>
    </section>
  );
}

function BackendSetting({
  state,
  busy,
  onChange,
}: {
  state: WorkbenchState;
  busy: boolean;
  onChange: (id: TerminalBackendId) => void;
}) {
  const backend = state.terminalBackend;
  const reason = backendLockReason(backend, state.sessions);
  const missing = herdrMissingNotice(backend);
  const options: { id: TerminalBackendId; label: string; detail: string }[] = [
    {
      id: "herdr",
      label: "herdr",
      detail: "앱을 종료해도 세션이 유지되고 다음 실행 때 탭으로 복원돼요.",
    },
    {
      id: "direct",
      label: "직접 실행",
      detail: "앱이 프로세스를 직접 실행해요. 앱을 종료하면 세션도 종료돼요.",
    },
  ];
  return (
    <fieldset
      className="dev-backend"
      data-testid="dev-backend-setting"
      aria-describedby="dev-backend-status"
      disabled={busy || !!reason}
    >
      <legend>세션 유지</legend>
      <div className="dev-backend-options">
        {options.map((option) => (
          <label key={option.id} className="dev-backend-option">
            <input
              type="radio"
              name="terminal-backend"
              value={option.id}
              data-testid={`dev-backend-${option.id}`}
              checked={backend.selected === option.id}
              onChange={() => onChange(option.id)}
            />
            <span>
              <strong>{option.label}</strong>
              <small>{option.detail}</small>
            </span>
          </label>
        ))}
      </div>
      <p id="dev-backend-status" className="dev-hint" data-testid="dev-backend-status">
        {backendStatus(backend)}
        {!backend.checking && backend.effective === "herdr" && (
          <>
            {" "}
            (세션 <code>{backend.session}</code>
            {backend.herdrVersion ? `, herdr ${backend.herdrVersion}` : ""})
          </>
        )}
        . 미리보기·검증 실행은 항상 직접 실행해요.
      </p>
      {reason && (
        <p className="dev-hint" data-testid="dev-backend-lock">
          {reason}
        </p>
      )}
      {backend.error && (
        <p className="dev-hint" data-testid="dev-herdr-error" role="status">
          {backend.error}
        </p>
      )}
      {missing && (
        <p className="dev-hint" data-testid="dev-herdr-missing" role="status">
          herdr 미설치 — 직접 실행 중이에요. 설치하려면 터미널에서{" "}
          <code>brew install herdr</code> 를 실행한 뒤 앱을 다시 열어주세요.
        </p>
      )}
    </fieldset>
  );
}
