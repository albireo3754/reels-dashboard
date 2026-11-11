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
  agentStartIntent,
  dotState,
  startChoices,
  tabKeyTarget,
  tabTooltip,
  type StartChoice,
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
import { Menu, type MenuEntry } from "../../../shared/ui/Popover";
import {
  ChevronDownIcon,
  CloseIcon,
  PlusIcon,
  Segmented,
} from "../../../shared/ui/primitives";
import "./workbench.css";

const DRAWER_ACTIONS = [
  "toggleDrawer",
  "newTerminal",
  "closeTab",
  ...Array.from({ length: 9 }, (_, index) => goToTab(index + 1)!),
] as const satisfies readonly KeyAction[];

/** Short segment labels; the full names stay in phaseLabels (tooltips, prompts). */
const PHASE_SHORT: Record<WorkPhase, string> = {
  design: "설계",
  implement: "구현",
  review: "리뷰",
  fix: "수정",
};
const PHASES = (Object.keys(phaseLabels) as WorkPhase[]).map((value) => ({
  value,
  label: PHASE_SHORT[value],
  title: phaseLabels[value],
}));

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
  const [showPrompt, setShowPrompt] = useState(false);
  const pending = useRef(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Arrow-key tab moves keep focus on the tab strip; every other selection hands focus to the terminal.
  const [terminalTakesFocus, setTerminalTakesFocus] = useState(true);
  const panel = useRef<HTMLElement>(null);
  // Layout contract: the shell reads --terminal-height (main padding, blog editor reserve).
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
      setTerminalTakesFocus(true);
      const session = await api.start({
        kind,
        ...(kind === "codex" || kind === "claude" ? { phase, task } : {}),
      });
      acceptState(await api.state());
      setSelected(session.id);
      onModeChange("open");
    });
  /** The + menu and the empty screen: a written request is shown in the composer before it is sent. */
  const openChoice = (choice: StartChoice) => {
    if (agentStartIntent(choice.kind, task.trim() !== "", settingsOpen) === "reveal") {
      setSettingsOpen(true);
      setProvider(choice.kind as AgentProvider);
      setError("");
      setNotice("작성한 요청문을 함께 보내요. 내용을 확인하고 시작을 누르세요.");
      requestAnimationFrame(() => document.getElementById("dev-task")?.focus());
      return;
    }
    void start(choice.kind);
  };
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
  const session = state?.sessions.find((s) => s.id === selected);
  const choices = startChoices(state?.providers ?? [], task.trim() !== "");
  const canStart = !busy && !!state?.workspace;
  const closing = target("closeTab");
  const runningPreview = state?.sessions.some(
    (s) => s.kind === "preview" && s.state === "running",
  );
  const open = mode === "open";
  const newItems: MenuEntry[] = choices.map((choice) => ({
    label: choice.label,
    onSelect: () => openChoice(choice),
    disabled: !canStart,
    title:
      choice.kind === "shell"
        ? `${choice.detail} (${hint("newTerminal")})`
        : choice.detail,
    testId: `dev-start-${choice.id}`,
  }));
  const moreItems: MenuEntry[] = [
    ...(session
      ? [
          {
            label: "Ctrl+C 보내기",
            title: "선택한 세션에 인터럽트를 보내요",
            disabled: busy || !acceptsInput(session),
            onSelect: () => void run(() => api.write(session.id, "\x03")),
          },
          metaAction(session) === "stop"
            ? {
                label: "세션 종료",
                title: "프로세스를 종료하고 탭은 남겨요",
                tone: "danger" as const,
                disabled: busy,
                onSelect: () => void run(() => api.stop(session.id)),
              }
            : {
                label: "목록에서 지우기",
                disabled: busy,
                onSelect: () => void run(() => api.remove(session.id)),
              },
        ]
      : []),
    ...(session && openSite ? [{ separator: true as const }] : []),
    ...(openSite
      ? [
          {
            label: "운영 브리핑 사이트",
            disabled: busy,
            onSelect: () => void run(openSite),
          },
        ]
      : []),
  ];
  const providerLabel = (id: AgentProvider | null) =>
    state?.providers.find((option) => option.id === id)?.label ?? "";
  return (
    <section
      ref={panel}
      className="dev-workspace"
      aria-label="터미널"
      data-drawer-state={mode}
      data-settings={open && settingsOpen ? "open" : undefined}
      hidden={mode === "closed"}
    >
      <header className="dev-tabbar" data-testid="dev-tabbar">
        <strong className="dev-tabbar-title" hidden={open}>
          터미널
          <small>
            {state?.sessions.length
              ? ` · 세션 ${state.sessions.length}개`
              : ""}
          </small>
        </strong>
        <div
          className="dev-session-tabs"
          hidden={!open || !state?.sessions.length}
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
                title={tabTooltip(
                  s,
                  sessionStateLabel(s),
                  index < 9 ? hint(goToTab(index + 1)) : "",
                )}
              >
                <span
                  className="dev-tab-dot"
                  data-state={dotState(s)}
                  data-backend={s.backend}
                  data-restored={s.restored ? "true" : undefined}
                  aria-hidden="true"
                />
                <span className="dev-tab-title">{s.title}</span>
                <span className="ui-sr-only">
                  {sessionStateLabel(s)}
                  {s.backend === "herdr" ? ", herdr 세션" : ""}
                </span>
                <ShortcutHint
                  action={
                    target(goToTab(index + 1))?.kind === "session"
                      ? goToTab(index + 1)
                      : undefined
                  }
                />
              </button>
              <button
                className="dev-tab-close icon-button small"
                disabled={busy}
                aria-label={`${s.title} 세션 닫기`}
                title={closeTitle(s)}
                onClick={() => closeSession(s.id)}
              >
                <CloseIcon />
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
        <div className="dev-new" hidden={!open}>
          <button
            className="dev-new-tab icon-button"
            data-testid="dev-new-tab"
            disabled={!canStart}
            onClick={() => start("shell")}
            title={`새 터미널 (${hint("newTerminal")})`}
            aria-label="새 터미널"
          >
            <PlusIcon />
            {/* run() drops ⌘T while another operation is pending, so hide its hint too. */}
            <ShortcutHint
              action={mode !== "closed" && !busy ? "newTerminal" : undefined}
            />
          </button>
          {open && <Menu
            label="새 세션 종류 선택"
            menuLabel="새 세션"
            trigger={<ChevronDownIcon />}
            triggerClassName="icon-button dev-new-menu"
            triggerProps={{
              "data-testid": "dev-new-menu",
              disabled: !canStart,
              title: "새 세션: 터미널, Codex, Claude, 미리보기, 검증",
            }}
            placement="bottom-start"
            items={newItems}
          />}
        </div>
        <div className="dev-tabbar-actions">
          {open && runningPreview && (
            <>
              <button
                className="icon-button small"
                aria-label="미리보기 나란히 보기"
                aria-pressed={preview}
                title="미리보기 나란히 보기 · 서버 준비 완료 로그를 확인한 뒤 열어주세요. 웹 변경은 자동 반영돼요."
                onClick={() => setPreview((value) => !value)}
              >
                <SplitIcon />
              </button>
              <button
                className="icon-button small"
                aria-label="브라우저에서 열기"
                title="미리보기를 브라우저에서 열기"
                disabled={busy}
                onClick={() => run(() => api.openPreview())}
              >
                <ExternalIcon />
              </button>
            </>
          )}
          <button
            className="icon-button small"
            data-testid="dev-settings-toggle"
            hidden={!open}
            aria-label="터미널 설정"
            aria-expanded={settingsOpen}
            aria-controls="dev-settings"
            title="요청 작성 · 코딩 도구 · 소스 폴더 · 세션 유지"
            onClick={() => setSettingsOpen((value) => !value)}
          >
            <GearIcon />
          </button>
          {open && moreItems.length > 0 && (
            <Menu
              label="터미널 더 보기"
              triggerClassName="small"
              triggerProps={{ "data-testid": "dev-more-menu" }}
              items={moreItems}
            />
          )}
          <button
            className="icon-button small dev-fold"
            data-folded={open ? undefined : "true"}
            aria-label={open ? "터미널 접기" : "터미널 펼치기"}
            title={`${open ? "접기" : "펼치기"} (${hint("toggleDrawer")})`}
            onClick={() => onModeChange(toggleDrawer(mode))}
          >
            <ChevronDownIcon />
            <ShortcutHint
              action={mode !== "closed" ? "toggleDrawer" : undefined}
            />
          </button>
          <button
            className="icon-button small"
            aria-label="터미널 닫기"
            title="패널만 숨기고 세션은 유지해요"
            onClick={() => onModeChange("closed")}
          >
            <CloseIcon />
            <ShortcutHint
              action={closing?.kind === "closeDrawer" ? "closeTab" : undefined}
            />
          </button>
        </div>
      </header>
      <div className="dev-drawer-body" hidden={!open}>
        <div
          id="dev-settings"
          className="dev-setup"
          data-testid="dev-settings"
          role="group"
          aria-label="터미널 설정"
          hidden={!settingsOpen}
        >
          <div className="dev-compose">
            <label htmlFor="dev-task" className="ui-sr-only">
              개선 요청
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
              placeholder="개선할 동작과 완료 기준을 적으세요. 다음 단계에는 이전 결과나 리뷰 지적을 붙여 주세요."
              rows={3}
            />
            <span id="dev-task-keys" className="ui-sr-only">
              Enter로 선택한 도구의 새 세션 시작 · Shift+Enter로 줄바꿈
            </span>
            <div className="dev-compose-row">
              <Segmented
                label="개선 단계"
                items={PHASES}
                value={phase}
                onChange={setPhase}
                size="small"
              />
              <span className="dev-compose-spacer" />
              <select
                aria-label="코딩 도구"
                className="ui-inline"
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
              <button
                className="primary"
                data-testid="dev-start-selected"
                disabled={busy || !state?.workspace || !provider}
                title={`${providerLabel(provider)}로 ${phaseLabels[phase]} 세션을 새 탭에서 시작해요 (Enter)`}
                onClick={() => provider && start(provider)}
              >
                {PHASE_SHORT[phase]} 세션 시작
              </button>
              <Menu
                label="요청 더 보기"
                triggerClassName="small"
                items={[
                  {
                    label: "현재 세션용 프롬프트 복사",
                    title: "진행 중인 세션에 붙여넣어 이어갈 수 있어요",
                    disabled: busy || !task.trim(),
                    onSelect: () =>
                      void run(async () => {
                        await navigator.clipboard.writeText(
                          workPrompt(phase, task),
                        );
                        setNotice(
                          "프롬프트를 복사했어요. 진행 중인 세션에 붙여넣어 이어갈 수 있어요.",
                        );
                      }),
                  },
                  {
                    label: "실행할 단계 프롬프트 보기",
                    checked: showPrompt,
                    onSelect: () => setShowPrompt((value) => !value),
                  },
                ]}
              />
            </div>
            {showPrompt && (
              <pre className="dev-prompt" aria-label="실행할 단계 프롬프트">
                {workPrompt(phase, task || "(입력한 요청)")}
              </pre>
            )}
          </div>
          <div className="dev-setup-meta">
            <div className="dev-connect">
              <span className="dev-setup-label">소스</span>
              <code title={state?.workspace ?? undefined}>
                {state?.workspace ?? "앱 소스 폴더를 연결해주세요"}
              </code>
              <button
                className="small"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    acceptState(await api.chooseWorkspace());
                  })
                }
              >
                소스 폴더 연결
              </button>
            </div>
            {state && (
              <BackendSetting
                state={state}
                busy={busy}
                onChange={setBackend}
              />
            )}
          </div>
        </div>
        {error && (
          <p className="dev-error ui-notice" data-tone="danger" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="dev-notice ui-status" role="status">
            {notice}
          </p>
        )}
        {session?.state === "detached" && (
          <div
            className="dev-banner"
            data-testid="dev-detached-note"
            role="status"
            title="다른 곳에서 세션을 가져갔거나 herdr 서버가 다시 시작됐을 수 있어요. 다시 연결하면 이 창으로 가져와요."
          >
            <span className="ui-truncate">
              연결이 끊긴 세션이에요. 세션은 그대로 살아 있어요.
            </span>
            {canReattach(session) && (
              <button
                className="small secondary"
                data-testid="dev-reattach"
                disabled={busy}
                onClick={() => reattach(session.id)}
              >
                다시 연결
              </button>
            )}
          </div>
        )}
        <div className={`dev-panels ${preview ? "with-preview" : ""}`}>
          <div className="dev-console" data-empty={session ? undefined : "true"}>
            {!session && (
              <div className="dev-terminal-empty" data-testid="dev-empty">
                <p className="dev-empty-title">무엇을 열까요?</p>
                <ul className="ui-list dev-empty-list">
                  {choices
                    .filter((choice) => choice.primary)
                    .map((choice) => (
                      <li key={choice.id}>
                        <button
                          className="ui-row"
                          data-testid={`dev-empty-${choice.id}`}
                          disabled={!canStart}
                          title={choice.detail}
                          onClick={() => openChoice(choice)}
                        >
                          {choice.kind === "shell" ? <PromptIcon /> : <AgentIcon />}
                          <span className="ui-row-title">
                            {choice.kind === "shell" ? "터미널 열기" : choice.label}
                          </span>
                          {choice.kind === "shell" && (
                            <span className="ui-row-meta" aria-hidden="true">
                              {hint("newTerminal")}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                </ul>
                {!state?.workspace && (
                  <p className="dev-empty-note">
                    먼저 설정에서 앱 소스 폴더를 연결해주세요.
                  </p>
                )}
              </div>
            )}
            {state?.sessions.map((item) => (
              <div
                key={item.id}
                className="dev-tabpanel"
                role="tabpanel"
                id={`dev-panel-${item.id}`}
                aria-labelledby={`dev-tab-${item.id}`}
                data-session-id={item.id}
                hidden={selected !== item.id}
              >
                <TerminalPane
                  api={api}
                  id={item.id}
                  active={open && selected === item.id}
                  inputEnabled={acceptsInput(item)}
                  takeFocus={terminalTakesFocus}
                />
              </div>
            ))}
          </div>
          {preview && (
            <div className="dev-preview">
              <div className="dev-preview-bar">
                <span className="ui-meta ui-truncate">로컬 웹 · 예시 데이터</span>
                <button
                  className="icon-button small"
                  aria-label="미리보기 새로고침"
                  title="새로고침"
                  onClick={() => setVersion((v) => v + 1)}
                >
                  <ReloadIcon />
                </button>
                <button
                  className="icon-button small"
                  aria-label="미리보기 닫기"
                  title="미리보기 닫기"
                  onClick={() => setPreview(false)}
                >
                  <CloseIcon />
                </button>
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
      <legend className="dev-setup-label">세션 유지</legend>
      {options.map((option) => (
        <label key={option.id} className="ui-check" title={option.detail}>
          <input
            type="radio"
            name="terminal-backend"
            value={option.id}
            data-testid={`dev-backend-${option.id}`}
            checked={backend.selected === option.id}
            onChange={() => onChange(option.id)}
          />
          {option.label}
        </label>
      ))}
      <span
        id="dev-backend-status"
        className="dev-backend-line"
        data-testid="dev-backend-status"
        title={`미리보기·검증 실행은 항상 직접 실행해요. ${appExitNote(backend, state.sessions)}`}
      >
        {backendStatus(backend)}
        {!backend.checking && backend.effective === "herdr" && (
          <>
            {" "}
            (세션 <code>{backend.session}</code>
            {backend.herdrVersion ? `, herdr ${backend.herdrVersion}` : ""})
          </>
        )}
      </span>
      {reason && (
        <span className="dev-backend-line" data-testid="dev-backend-lock">
          {reason}
        </span>
      )}
      {backend.error && (
        <span className="dev-backend-line" data-testid="dev-herdr-error" role="status">
          {backend.error}
        </span>
      )}
      {missing && (
        <span className="dev-backend-line" data-testid="dev-herdr-missing" role="status">
          herdr 미설치 — 직접 실행 중이에요. <code>brew install herdr</code> 후 앱을 다시 열어주세요.
        </span>
      )}
    </fieldset>
  );
}

/* Panel-only icons (16px, currentColor), same stroke style as the shared icons. */
const iconProps = {
  viewBox: "0 0 16 16",
  width: 16,
  height: 16,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function GearIcon() {
  return (
    <svg {...iconProps}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.75v1.5M8 12.75v1.5M3.6 3.6l1.05 1.05M11.35 11.35l1.05 1.05M1.75 8h1.5M12.75 8h1.5M3.6 12.4l1.05-1.05M11.35 4.65l1.05-1.05" />
    </svg>
  );
}

function SplitIcon() {
  return (
    <svg {...iconProps}>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M8 3v10" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg {...iconProps}>
      <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" />
    </svg>
  );
}

function ReloadIcon() {
  return (
    <svg {...iconProps}>
      <path d="M13 8a5 5 0 1 1-1.5-3.55M13 2.5v3h-3" />
    </svg>
  );
}

function PromptIcon() {
  return (
    <svg {...iconProps} className="ui-row-icon">
      <path d="M3 4.5 6.5 8 3 11.5M8 12h5" />
    </svg>
  );
}

function AgentIcon() {
  return (
    <svg {...iconProps} className="ui-row-icon">
      <path d="M8 2v2.5M8 11.5V14M2 8h2.5M11.5 8H14M4.2 4.2l1.6 1.6M10.2 10.2l1.6 1.6M4.2 11.8l1.6-1.6M10.2 5.8l1.6-1.6" />
    </svg>
  );
}
