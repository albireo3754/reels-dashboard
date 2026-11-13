import { PublicationCalendar } from "../features/publication-calendar";
import { ShortcutHint, useShortcut } from "../shared/ui/shortcuts";
import { goToTab } from "../shared/keymap";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  Dashboard,
  DashboardBridge,
  Project,
  Status,
} from "../shared/contracts";
import { emptyDashboard } from "../shared/contracts";
import type { EditorProject } from "../shared/editor";
import { errorMessage } from "../shared/lib/errors";
import { localDate } from "../shared/lib/format";
import { ExecutionLogsPanel } from "../shared/ui/ExecutionLogs";
import { Dot } from "../shared/ui/primitives";
import { BlogWorkspace } from "../features/blog-workspace";
import { CardNews } from "../features/card-news";
import {
  BoardToolbar,
  defaultBoardQuery,
  parseBoardQuery,
  selectBoardProjects,
  projectTidyTask,
  type BoardQuery,
} from "../features/content-board";
import { savedAgentPermission } from "../shared/workbench";
import { ProjectTerminalDialog } from "./ProjectTerminalDialog";
import {
  DevWorkspace,
  workbenchShortcutTarget,
  type DrawerMode,
} from "../features/dev-workspace";
import { ProjectGrouping } from "../features/project-grouping";
import { WorkflowPanel, useWorkflowNotifications } from "../features/workflow";
import {
  WorkspaceToolbar,
  useWorkspaceNavigation,
} from "../features/workspace-shell";
import { Editor } from "./Editor";
import { MobileBriefing } from "./MobileBriefing";
import { pages, permissionLabels, type Tab } from "./pages";
import { ProjectCard } from "./ProjectCard";
import { publicationsSchema } from "../shared/publications";
import { ProjectDialog } from "./ProjectDialog";
import { Empty, Icon } from "./ui";
import { SettingsScreen } from "./SettingsScreen";
import { readableTime } from "./photo-export/shared";
import { LibraryScreen } from "./photo-export/LibraryScreen";
import { TransfersScreen } from "./photo-export/TransfersScreen";
import { photoExportActions, usePhotoExport } from "./photo-export/usePhotoExport";
const UiInspector = lazy(() => import("../features/ui-inspector").then((m) => ({ default: m.UiInspector })));

export function App({ bridge }: { bridge: DashboardBridge }) {
  const navigation = useWorkspaceNavigation<Tab>(new URLSearchParams(location.search).has("workflow") ? "workflow" : "dashboard");
  const { current: tab, navigate: setTab } = navigation;
  const notificationRun = useWorkflowNotifications(setTab);
  const [workflowVisited, setWorkflowVisited] = useState(tab === "workflow");
  useEffect(() => { if (tab === "workflow") setWorkflowVisited(true); }, [tab]);
  const [drawerMode, setDrawerMode] = useState<DrawerMode>("closed");
  const [requestedTerminal, setRequestedTerminal] = useState("");
  const [terminalProject, setTerminalProject] = useState<Project | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [feedbackDrafts, setFeedbackDrafts] = useState<{ id: number; text: string; phase: "fix" }[]>([]);
  const feedbackSequence = useRef(0);
  const acknowledgeFeedback = useCallback((id: number) => setFeedbackDrafts((drafts) => drafts.filter((draft) => draft.id !== id)), []);
  const closeInspector = useCallback(() => setInspecting(false), []);
  // Arrives only from the dev desktop host (or the ?enabled=1 web fixture).
  useShortcut("inspectUi", () => setInspecting((active) => !active));
  const [editorProject, setEditorProject] = useState<EditorProject | null>(
    null,
  );
  const [editorRendering, setEditorRendering] = useState(false);
  useEffect(
    () =>
      bridge.agent?.onProjectOpened((project) => {
        setEditorProject(project);
        setTab("editor");
      }),
    [bridge],
  );
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard>(emptyDashboard);
  const [boardQuery, setBoardQuery] = useState<BoardQuery>(() => {
    try {
      const saved = parseBoardQuery(
        JSON.parse(
          localStorage.getItem(`reels-board-view-v1:${bridge.mode}`) ?? "null",
        ),
      );
      return { ...defaultBoardQuery, sort: saved.sort, view: saved.view };
    } catch {
      return { ...defaultBoardQuery };
    }
  });
  const [boardLimit, setBoardLimit] = useState(12);
  const changeBoardQuery = (value: BoardQuery) => {
    setBoardQuery(value);
    setBoardLimit(12);
  };
  useEffect(() => {
    try {
      localStorage.setItem(
        `reels-board-view-v1:${bridge.mode}`,
        JSON.stringify(boardQuery),
      );
    } catch {
      /* View controls remain usable when local storage is unavailable. */
    }
  }, [boardQuery, bridge.mode]);
  const boardProjects = useMemo(
    () => selectBoardProjects(dashboard.projects, boardQuery),
    [dashboard.projects, boardQuery],
  );
  const [status, setStatus] = useState<Status | null>(null);
  const photo = usePhotoExport();
  const [editingRevision, setEditingRevision] = useState("");
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  useEffect(() => {
    if (tab !== "settings") setToken("");
  }, [tab]);
  const readOnly = bridge.mode === "web";
  const workflowHost = readOnly && new URLSearchParams(location.search).has("workflow");
  const protocolOK = !status || status.protocolVersion === 1;
  const canIndex =
    !readOnly &&
    protocolOK &&
    !!status &&
    ["authorized", "limited"].includes(status.permission);
  const run = useCallback(
    async (name: string, fn: () => Promise<void>) => {
      if (busy) return;
      setBusy(name);
      setError("");
      setNotice("");
      try {
        await fn();
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setBusy("");
      }
    },
    [busy],
  );
  useEffect(() => {
    let active = true;
    void bridge
      .loadDashboard()
      .then((d) => {
        if (active) setDashboard(d);
      })
      .catch((e) => {
        if (active) setError(errorMessage(e));
      });
    if (!readOnly)
      void bridge
        .request<Status>("status")
        .then((s) => {
          if (active) setStatus(s);
        })
        .catch((e) => {
          if (active) setError(errorMessage(e));
        });
    return () => {
      active = false;
    };
  }, [bridge, readOnly]);
  useEffect(() => bridge.onDashboardChanged?.(setDashboard), [bridge]);
  const refreshDashboard = useCallback(() => {
    void bridge
      .loadDashboard()
      .then(setDashboard)
      .catch((e) => setError(errorMessage(e)));
  }, [bridge]);
  const photoActions = photoExportActions(photo, {
    bridge,
    run,
    setTab,
    setNotice,
    setEditorProject,
    refreshDashboard,
    editorRendering,
  });
  const refreshStatus = () =>
    run("연결 확인", async () => {
      const s = await bridge.request<Status>("status");
      setStatus(s);
      setNotice("연결 상태를 확인했어요.");
    });
  const authorize = () =>
    run("Photos 권한 요청", async () => {
      const s = await bridge.request<{ permission: string }>("authorize");
      setStatus((prev) => ({
        ...prev,
        appVersion: prev?.appVersion || "",
        protocolVersion: prev?.protocolVersion || 1,
        permission: s.permission,
      }));
    });
  const saveProject = () =>
    run("콘텐츠 저장", async () => {
      if (!editingProject?.title.trim())
        throw new Error("콘텐츠 제목을 입력해주세요.");
      if (
        editingProject.publicURL &&
        !/^https?:\/\//.test(editingProject.publicURL)
      )
        throw new Error("게시 링크는 HTTP 또는 HTTPS 주소를 입력해주세요.");
      const publications = publicationsSchema.safeParse(
        editingProject.publications ?? [],
      );
      if (!publications.success)
        throw new Error(
          publications.error.issues[0]?.message ??
            "채널별 게시 정보를 확인해주세요.",
        );
      const value = { ...editingProject, title: editingProject.title.trim() };
      const next = {
        ...dashboard,
        updatedAt: new Date().toISOString(),
        projects: dashboard.projects.some((p) => p.id === value.id)
          ? dashboard.projects.map((p) => (p.id === value.id ? value : p))
          : [value, ...dashboard.projects],
      };
      await bridge.saveDashboard(next, editingRevision);
      setDashboard(await bridge.loadDashboard());
      setEditingProject(null);
      setNotice("콘텐츠 진행 상태를 저장했어요.");
    });
  const newProject = () => {
    setEditingRevision(dashboard.updatedAt);
    setEditingProject({
      id: crypto.randomUUID(),
      title: "",
      date: localDate(),
      stage: "idea",
      nextAction: "",
      publicURL: "",
      shared: false,
    });
  };
  const totals = useMemo(
    () => ({
      all: dashboard.projects.length,
      active: dashboard.projects.filter((p) => p.stage !== "published").length,
      review: dashboard.projects.filter((p) => p.stage === "review").length,
      published: dashboard.projects.filter((p) => p.stage === "published")
        .length,
    }),
    [dashboard],
  );
  const nativeNotice = (
    <div className="desktop-notice">
      <Icon name="library" />
      <div>
        <strong>촬영본 작업은 데스크톱에서 이어가요.</strong>
        <p>Photos 접근과 원본 복사·이동은 데스크톱 앱에서 실행해주세요.</p>
      </div>
    </div>
  );
  const photosAllowed =
    !!status && ["authorized", "limited"].includes(status.permission);
  const connection = (
    <div className="connection-strip">
      <Dot tone={photosAllowed ? "primary" : "warning"} />
      <strong>
        {status
          ? `Photos ${permissionLabels[status.permission] || status.permission}`
          : "네이티브 연결 확인 필요"}
      </strong>
      <span className="ui-meta ui-truncate">
        {status
          ? `도우미 ${status.appVersion} · 프로토콜 ${status.protocolVersion}`
          : "앱과 함께 포함된 Photos 도우미에 연결해요."}
      </span>
      <span className="ui-spacer" aria-hidden="true" />
      <button className="small" onClick={refreshStatus} disabled={!!busy}>
        상태 새로고침
      </button>
      {status && !photosAllowed && (
        <button
          className="small secondary"
          onClick={authorize}
          disabled={!!busy || !protocolOK}
        >
          Photos 접근 요청
        </button>
      )}
    </div>
  );
  const navigationTabs: Tab[] = [
    "dashboard",
    ...(!readOnly ? (["calendar"] as const) : []),
    "library",
    "editor",
    "cards",
    "blog",
    "workflow",
    "transfers",
    ...(bridge.executionLogs ? (["logs"] as const) : []),
  ];
  const navigationItems = navigationTabs.map(
    (key): [Tab, string] => [key, pages[key].label],
  );
  // ⌘1-9 reach these screens through DevWorkspace (dev host only); the hint
  // asks the same rule DevWorkspace's handler does, from the lifted drawer mode.
  const screenHint = (index: number) => {
    const action = goToTab(index + 1);
    return bridge.workbench &&
      workbenchShortcutTarget(
        { mode: drawerMode, screens: navigationItems.length },
        action,
      )?.kind === "screen"
      ? action
      : undefined;
  };
  const navigateTo = (key: Tab) => {
    setTab(key);
    if (key === "dashboard") refreshDashboard();
    setError("");
    setNotice("");
  };
  return (
    <div className="app-shell compact-shell" data-terminal={drawerMode}>
      <WorkspaceToolbar
        desktop={typeof window.reels !== "undefined"}
        devBuild={window.reels?.devBuild === true}
        navigation={navigation}
        items={[...navigationItems, ["settings", pages.settings.label]]}
        projects={dashboard.projects}
        onNavigate={key => navigateTo(key as Tab)}
        onJump={navigation.jump}
        settingsActive={tab === "settings"}
        inspecting={inspecting}
        onInspect={bridge.workbench ? () => setInspecting((active) => !active) : undefined}
        terminal={drawerMode}
        onTerminal={bridge.workbench ? () => setDrawerMode(mode => mode === "open" ? "folded" : "open") : undefined}
        onProject={!readOnly ? project => { setEditingRevision(dashboard.updatedAt); setEditingProject({ ...project }); } : undefined}
      />
      {bridge.workbench && inspecting && <Suspense fallback={null}><UiInspector onClose={closeInspector} onFeedback={(text) => {
        const id = ++feedbackSequence.current;
        setFeedbackDrafts((previous) => [...previous, { id, text, phase: "fix" }]);
        setInspecting(false);
        setDrawerMode("open");
      }} /></Suspense>}
      <aside className="sidebar">
        <nav aria-label="주요 메뉴">
          {navigationItems.map(([key, text], index) => (
            <button
              key={key}
              aria-label={text}
              className={`nav-item ${tab === key ? "active" : ""}`}
              aria-current={tab === key ? "page" : undefined}

              onClick={() => navigateTo(key)}
            >
              <Icon name={key} />
              <span>{text}</span>
              {key === "dashboard" && totals.all > 0 && (
                <small aria-hidden="true">{totals.all}</small>
              )}
              <ShortcutHint action={screenHint(index)} />
            </button>
          ))}
        </nav>
        {readOnly && (
          <p
            className="sidebar-mode"
            title={
              workflowHost
                ? "작업 상태는 이 컴퓨터에 저장해요."
                : "마지막 동기화된 내용을 보여드려요."
            }
          >
            {workflowHost ? "로컬 워크플로" : "공유된 현황 · 읽기 전용"}
          </p>
        )}
      </aside>
      <main className={`main ${tab === "dashboard" ? "dashboard-home" : ""}`}>
        {bridge.mode === "demo" && (
          <p className="demo-banner" role="note">
            예시 데이터로 둘러보는 화면이에요 · 실제 Photos와 서버 데이터는
            바꾸지 않아요.
          </p>
        )}
        <div className="page-heading">
          <div className="shell-page-description">
            <h1>{pages[tab].title}</h1>
            <p>{pages[tab].description}</p>
          </div>
          {tab === "dashboard" && (
            <>
              <div
                className="stats-grid ui-segmented"
                role="group"
                aria-label="진행 단계 요약"
              >
                {(
                  [
                    ["진행 중", totals.active, "active"],
                    ["검토 대기", totals.review, "review"],
                    ["게시 완료", totals.published, "published"],
                  ] as const
                ).map(([name, value, stage]) => (
                  <button
                    key={stage}
                    aria-label={`${name} 보기`}
                    aria-pressed={boardQuery.stage === stage}
                    onClick={() =>
                      changeBoardQuery({
                        ...boardQuery,
                        search: "",
                        basis: "all",
                        stage,
                      })
                    }
                  >
                    {name}
                    <span className="stat-count">{value}</span>
                  </button>
                ))}
              </div>
              <span className="ui-spacer" aria-hidden="true" />
              <span className="ui-meta page-heading-meta">
                {readOnly ? "마지막 동기화" : "마지막 저장"} ·{" "}
                {readableTime(dashboard.updatedAt)}
              </span>
              {!readOnly ? (
                <button
                  className="primary"
                  onClick={newProject}
                  disabled={!!busy}
                >
                  <Icon name="plus" />새 콘텐츠
                </button>
              ) : (
                <button
                  className="secondary"
                  onClick={() =>
                    run("공유 현황 확인", async () => {
                      setDashboard(await bridge.loadDashboard());
                      setNotice("최신 공유 현황을 확인했어요.");
                    })
                  }
                  disabled={!!busy}
                >
                  현황 새로고침
                </button>
              )}
            </>
          )}
        </div>
        {!protocolOK && (
          <div className="alert error" role="alert">
            도우미 프로토콜 {status?.protocolVersion}은 지원하지 않아요. 앱과
            도우미 버전을 확인해주세요.
          </div>
        )}
        {error && !editingProject && (
          <div className="alert error" role="alert">
            <span>
              <strong>작업을 완료하지 못했어요.</strong> {error}
            </span>
            <button
              className="icon-button small"
              aria-label="오류 닫기"
              title="닫기"
              onClick={() => setError("")}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        {notice && (
          <div className="alert success" role="status">
            <Icon name="check" />
            <span>{notice}</span>
            <button
              className="icon-button small"
              aria-label="알림 닫기"
              title="닫기"
              onClick={() => setNotice("")}
            >
              <Icon name="close" />
            </button>
          </div>
        )}
        {busy && (
          <div className="working" role="status">
            <span className="spinner" aria-hidden="true" />
            {busy} 중…
          </div>
        )}
        {!readOnly &&
          bridge.mobileBriefing &&
          (tab === "dashboard" || tab === "settings") && (
            <MobileBriefing bridge={bridge} compact={tab === "dashboard"} />
          )}
        {tab === "dashboard" && (
          <section className="content-section" aria-labelledby="board-heading">
            <h2 id="board-heading" className="ui-sr-only">
              {boardQuery.stage === "active" ? "진행 중인 작업" : "콘텐츠 보드"}
            </h2>
            {dashboard.projects.length > 0 && (
              <BoardToolbar
                query={boardQuery}
                onChange={changeBoardQuery}
                count={boardProjects.length}
                total={totals.all}
                onTidy={!readOnly && bridge.workbench ? async () => {
                  const workbench = bridge.workbench!;
                  const { defaultProvider } = await workbench.state();
                  const session = await workbench.start({ kind: defaultProvider, phase: "implement", task: projectTidyTask, permission: savedAgentPermission() });
                  setRequestedTerminal(session.id);
                  setDrawerMode("open");
                } : undefined}
              />
            )}
            {!dashboard.projects.length ? (
              <Empty
                title="첫 번째 이야기를 준비해볼까요?"
                actions={
                  !readOnly && (
                    <button
                      className="library-callout"
                      onClick={() => setTab("library")}
                    >
                      <Icon name="library" />
                      촬영 보관함에서 장면 고르기
                    </button>
                  )
                }
              >
                {readOnly
                  ? "아직 공유된 콘텐츠가 없어요. 데스크톱에서 공유할 항목을 선택하고 현황을 동기화해주세요."
                  : "촬영본을 고르거나 새 콘텐츠를 추가해서 시작해보세요."}
              </Empty>
            ) : !boardProjects.length ? (
              <div className="board-no-results">
                <h3>조건에 맞는 콘텐츠가 없어요.</h3>
                <p>검색어를 줄이거나 진행 단계와 날짜 종류를 바꿔보세요.</p>
                <button
                  className="secondary"
                  onClick={() =>
                    changeBoardQuery({
                      ...defaultBoardQuery,
                      stage: "all",
                      sort: boardQuery.sort,
                      view: boardQuery.view,
                    })
                  }
                >
                  전체 콘텐츠 다시 보기
                </button>
              </div>
            ) : (
              <div
                className={`project-grid ${boardQuery.view === "list" ? "board-list" : ""}`}
              >
                {boardProjects.slice(0, boardLimit).map((project) => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    bridge={bridge}
                    readOnly={readOnly}
                    busy={!!busy}
                    onTerminal={!readOnly && bridge.mode === "desktop" ? () => setTerminalProject(project) : undefined}
                    onEdit={() => {
                      setEditingRevision(dashboard.updatedAt);
                      setEditingProject({ ...project });
                    }}
                    onReveal={
                      bridge.revealResource
                        ? (path) =>
                            run("자료 위치 열기", () =>
                              bridge.revealResource!(project.id, path),
                            )
                        : undefined
                    }
                  />
                ))}
              </div>
            )}
            {boardProjects.length > boardLimit && (
              <div className="board-load-more">
                <small>
                  {boardProjects.length}개 중{" "}
                  {Math.min(boardLimit, boardProjects.length)}개 표시
                </small>
                <button
                  className="secondary"
                  onClick={() => setBoardLimit((limit) => limit + 12)}
                >
                  콘텐츠 더 보기 (
                  {Math.min(12, boardProjects.length - boardLimit)}개)
                </button>
              </div>
            )}
          </section>
        )}
        {tab === "library" &&
          (readOnly ? (
            nativeNotice
          ) : (
            <LibraryScreen
              photo={photo}
              actions={photoActions}
              connection={connection}
              status={status}
              busy={busy}
              canIndex={canIndex}
              editorRendering={editorRendering}
              run={run}
              bridge={bridge}
            />
          ))}
        {bridge.workbench && (
            <Suspense fallback={null}>
              <DevWorkspace
                api={bridge.workbench}
                requestedSessionId={requestedTerminal}
                feedbackDraft={feedbackDrafts[0]}
                onFeedbackApplied={acknowledgeFeedback}
                mode={drawerMode}
                onModeChange={setDrawerMode}
                onNavigate={(index) => {
                  const item = navigationItems[index];
                  if (item) navigateTo(item[0]);
                }}
                screens={navigationItems.length}
                openSite={bridge.mobileBriefing?.open}
              />
            </Suspense>
        )}
        <div hidden={tab !== "editor"}>
          <Editor
            bridge={bridge.editor}
            agent={bridge.agent}
            mode={bridge.mode}
            incoming={editorProject}
            active={tab === "editor"}
            onRenderingChange={setEditorRendering}
            onDashboardChange={refreshDashboard}
          />
        </div>
        <div hidden={tab !== "cards"}>
          <CardNews api={bridge.cardNews} active={tab === "cards"} />
        </div>
        <div hidden={tab !== "blog"}><BlogWorkspace api={bridge.blog} media={bridge.contentMedia} projects={dashboard.projects} active={tab === "blog"}
          onOpenTerminal={bridge.workbench ? () => setDrawerMode("open") : undefined}
          onStartTerminal={bridge.workbench ? async (task, permission) => {
            const session = await bridge.workbench!.start({kind: "codex", phase: "implement", task, permission});
            setRequestedTerminal(session.id);
            setDrawerMode("open");
          } : undefined}
        /></div>
        {tab === "calendar" && <PublicationCalendar api={bridge.planning} projects={dashboard.projects} />}
        {tab === "logs" && bridge.executionLogs && <ExecutionLogsPanel bridge={bridge.executionLogs} />}
        {(workflowVisited || tab === "workflow") && <div hidden={tab !== "workflow"}><WorkflowPanel openRunRequest={notificationRun} /></div>}
        {tab === "transfers" &&
          (readOnly ? (
            nativeNotice
          ) : (
            <TransfersScreen
              photo={photo}
              actions={photoActions}
              busy={busy}
              setTab={setTab}
            />
          ))}
        {tab === "settings" && (
          <SettingsScreen
            readOnly={readOnly}
            connection={connection}
            nativeNotice={nativeNotice}
            bridge={bridge}
            dashboard={dashboard}
            busy={busy}
            run={run}
            setNotice={setNotice}
            endpoint={endpoint}
            setEndpoint={setEndpoint}
            token={token}
            setToken={setToken}
          />
        )}
      </main>
      {terminalProject && (
        <ProjectTerminalDialog
          key={terminalProject.id}
          project={terminalProject}
          api={bridge.workbench}
          onClose={() => setTerminalProject(null)}
          onSettings={() => { setTerminalProject(null); setTab("settings"); }}
          onStarted={id => {
            setTerminalProject(null);
            setRequestedTerminal(id);
            setDrawerMode("open");
          }}
        />
      )}
      {editingProject && (
        <ProjectDialog
          project={editingProject}
          onChange={setEditingProject}
          onCancel={() => setEditingProject(null)}
          onSave={saveProject}
          busy={!!busy}
          error={error}
        >
          {bridge.projects &&
            dashboard.projects.some((p) => p.id === editingProject.id) && (
              <ProjectGrouping
                key={editingProject.id}
                api={bridge.projects}
                project={editingProject}
                dashboard={dashboard}
                disabled={
                  !!busy ||
                  JSON.stringify(editingProject) !==
                    JSON.stringify(
                      dashboard.projects.find((p) => p.id === editingProject.id),
                    )
                }
                onComplete={(next, message) => {
                  setDashboard(next);
                  setEditingProject(null);
                  setNotice(message);
                }}
              />
            )}
        </ProjectDialog>
      )}
    </div>
  );
}
