import { WorkspaceToolbar, useWorkspaceNavigation } from "../features/workspace-shell";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type {
  Asset,
  Dashboard,
  DashboardBridge,
  Decision,
  GroupDetail,
  Groups,
  Inspection,
  PlanEnvelope,
  Project,
  Stage,
  Status,
} from "../shared/contracts";
import { emptyDashboard } from "../shared/contracts";
import type { EditorProject } from "../shared/editor";
import { Editor } from "./Editor";
import type { DrawerMode } from "../features/dev-workspace";
const DevWorkspace = lazy(() => import("../features/dev-workspace").then(m => ({ default: m.DevWorkspace })));

type Tab = "dashboard" | "library" | "editor" | "transfers" | "settings";
type Choice = "undecided" | "included" | "excluded";
type ActivePlan = {
  kind: "export" | "move";
  path: string;
  envelope: PlanEnvelope;
};
const stages: Record<Stage, string> = {
  idea: "아이디어",
  selected: "촬영본 선택",
  editing: "편집 중",
  review: "검토 대기",
  published: "게시 완료",
};
const permissions: Record<string, string> = {
  "not-determined": "아직 요청하지 않음",
  authorized: "허용됨",
  limited: "일부 사진만 허용",
  denied: "접근 거부됨",
  restricted: "시스템에서 제한됨",
  unknown: "상태 확인 필요",
};
const localDate = () => new Date().toLocaleDateString("en-CA");
const readableTime = (v?: string) =>
  v
    ? new Date(v).toLocaleString("ko-KR", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "시각 미상";
const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    dashboard: "M3 3h7v7H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 14h7v7H3z",
    library: "M4 5h16v15H4z M8 2h8 M4 15l5-5 4 4 3-2 4 4",
    transfers: "M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4",
    editor: "M4 4h16v16H4z M10 8l6 4-6 4z M4 8H2 M4 16H2 M20 8h2 M20 16h2",
    settings: "M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6",
    arrow: "M5 12h14 M13 6l6 6-6 6",
    plus: "M12 5v14 M5 12h14",
    check: "M5 12l4 4L19 6",
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] || paths.dashboard} />
    </svg>
  );
}
function JSONDetails({
  data,
  label = "자세한 결과",
}: {
  data: unknown;
  label?: string;
}) {
  return (
    <details className="json-details">
      <summary>{label}</summary>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </details>
  );
}
function Empty({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-orbit">
        <Icon name="library" />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export function App({ bridge }: { bridge: DashboardBridge }) {
  const navigation = useWorkspaceNavigation<Tab>("dashboard");
  const { current: tab, navigate: setTab } = navigation;
  const [drawerMode, setDrawerMode] = useState<DrawerMode>("closed");
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
  const [status, setStatus] = useState<Status | null>(null);
  const [date, setDate] = useState(localDate);
  const [level, setLevel] = useState<"coarse" | "fine">("fine");
  const [groups, setGroups] = useState<Groups | null>(null);
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [images, setImages] = useState<Record<string, string>>({});
  const [evidencePage, setEvidencePage] = useState(1);
  const [reviewedPages, setReviewedPages] = useState<number[]>([]);
  const [label, setLabel] = useState("");
  const [confidence, setConfidence] = useState("0.9");
  const [unknowns, setUnknowns] = useState("");
  const [references, setReferences] = useState<string[]>([]);
  const [decisionPath, setDecisionPath] = useState("");
  const [validated, setValidated] = useState(false);
  const [destination, setDestination] = useState("");
  const [plan, setPlan] = useState<ActivePlan | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [moveConfirmed, setMoveConfirmed] = useState(false);
  const [receipt, setReceipt] = useState<unknown>(null);
  const [recovery, setRecovery] = useState<{
    path: string;
    data: Record<string, unknown>;
  } | null>(null);
  const [recoveryDigest, setRecoveryDigest] = useState("");
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  useEffect(() => {
    if (tab !== "settings") setToken("");
  }, [tab]);
  const readOnly = bridge.mode === "web";
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
        setError(e instanceof Error ? e.message : String(e));
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
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    if (!readOnly)
      void bridge
        .request<Status>("status")
        .then((s) => {
          if (active) setStatus(s);
        })
        .catch((e) => {
          if (active) setError(e instanceof Error ? e.message : String(e));
        });
    return () => {
      active = false;
    };
  }, [bridge, readOnly]);
  const refreshDashboard = useCallback(() => {
    void bridge
      .loadDashboard()
      .then(setDashboard)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [bridge]);
  const editPhotosVideo = (assetID: string) =>
    run("Photos 원본과 재생 영상 준비", async () => {
      if (!detail || editorRendering) return;
      const project = await bridge.editor.fromPhotos({
        groupID: detail.group.id,
        indexRunID: detail.indexRunID,
        assetID,
      });
      setEditorProject(project);
      setTab("editor");
      refreshDashboard();
    });
  const invalidate = () => {
    setValidated(false);
    setDecisionPath("");
    setPlan(null);
    setReviewed(false);
    setMoveConfirmed(false);
    setReceipt(null);
  };
  const clearSelection = () => {
    setDetail(null);
    setChoices({});
    setInspection(null);
    setImages({});
    setReviewedPages([]);
    setReferences([]);
    setLabel("");
    invalidate();
  };
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
  const sync = () =>
    run("촬영본 색인", async () => {
      clearSelection();
      setGroups(null);
      await bridge.request("sync", { date });
      const result = await bridge.request<Groups>("groups.list", {
        date,
        level,
      });
      setGroups(result);
      setNotice(
        `${date} 촬영본을 확인했어요. ${result.groups.length}개 그룹이 있어요.`,
      );
    });
  const changeLevel = (value: "coarse" | "fine") => {
    setLevel(value);
    if (groups)
      void run("그룹 조회", async () => {
        clearSelection();
        setGroups(
          await bridge.request<Groups>("groups.list", { date, level: value }),
        );
      });
  };
  const selectGroup = (id: string) =>
    run("그룹 열기", async () => {
      if (!groups) return;
      clearSelection();
      const d = await bridge.request<GroupDetail>("groups.show", {
        id,
        "index-run": groups.indexRunID,
      });
      setDetail(d);
      setChoices(Object.fromEntries(d.assets.map((a) => [a.id, "undecided"])));
    });
  const inspect = (page = 1) =>
    run("미리보기 생성", async () => {
      if (!detail) return;
      const result = await bridge.request<Inspection>("groups.inspect", {
        id: detail.group.id,
        "index-run": detail.indexRunID,
        page: String(page),
        "page-size": "12",
        samples: "12",
      });
      const urls: Record<string, string> = {};
      await Promise.all(
        result.packet.samples.map(async (sample) => {
          const path =
            result.sampleFiles.find((p) => p.endsWith(sample.relativePath)) ||
            `${result.outputDirectory}/${sample.relativePath}`;
          urls[sample.assetID] = await bridge.imageURL(path);
        }),
      );
      setInspection(result);
      setImages(urls);
      setEvidencePage(page);
      setReviewedPages((p) => Array.from(new Set([...p, page])));
      setReferences((p) =>
        Array.from(new Set([...p, ...result.packet.samples.map((s) => s.id)])),
      );
      invalidate();
    });
  const buildDecision = (): Decision => {
    if (!detail) throw new Error("먼저 촬영 그룹을 선택해주세요.");
    if (!label.trim()) throw new Error("콘텐츠 이름을 입력해주세요.");
    return {
      schemaVersion: 1,
      indexRunID: detail.indexRunID,
      groupID: detail.group.id,
      label: label.trim(),
      confidence: Number(confidence),
      includedAssetIDs: detail.assets
        .filter((a) => choices[a.id] === "included")
        .map((a) => a.id),
      excludedAssetIDs: detail.assets
        .filter((a) => choices[a.id] === "excluded")
        .map((a) => a.id),
      evidenceReferences: references,
      unknowns: unknowns
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    };
  };
  const saveDecision = () =>
    run("분류 저장", async () => {
      const path = await bridge.saveDocument("decision", buildDecision());
      setDecisionPath(path);
      setNotice(`분류를 저장했어요: ${path}`);
    });
  const validate = () =>
    run("선택 검증", async () => {
      const d = buildDecision();
      const path = await bridge.saveDocument("decision", d);
      setDecisionPath(path);
      await bridge.request("decisions.validate", { file: path });
      setValidated(true);
      setNotice("선택 검증을 통과했어요. 내보내기 계획을 만들 수 있어요.");
    });
  const importDecision = () =>
    run("분류 불러오기", async () => {
      const doc = await bridge.openDocument();
      if (!doc) return;
      const d = asRecord(doc.data);
      if (
        !detail ||
        d.indexRunID !== detail.indexRunID ||
        d.groupID !== detail.group.id
      )
        throw new Error(
          "현재 그룹·색인과 같은 분류 파일을 선택해주세요. 날짜를 다시 색인했다면 기존 분류도 다시 확인해야 해요.",
        );
      if (
        d.schemaVersion !== 1 ||
        !Array.isArray(d.includedAssetIDs) ||
        !Array.isArray(d.excludedAssetIDs) ||
        !Array.isArray(d.evidenceReferences) ||
        !Array.isArray(d.unknowns) ||
        [
          ...d.includedAssetIDs,
          ...d.excludedAssetIDs,
          ...d.evidenceReferences,
          ...d.unknowns,
        ].some((v) => typeof v !== "string") ||
        typeof d.label !== "string" ||
        typeof d.confidence !== "number"
      )
        throw new Error("ModelDecision 형식의 분류 파일이 필요해요.");
      await bridge.request("decisions.validate", { file: doc.path });
      invalidate();
      setLabel(d.label);
      setConfidence(String(d.confidence));
      setUnknowns(asStrings(d.unknowns).join("\n"));
      setReferences(asStrings(d.evidenceReferences));
      const included = asStrings(d.includedAssetIDs),
        excluded = asStrings(d.excludedAssetIDs);
      setChoices(
        Object.fromEntries(
          detail.assets.map((a) => [
            a.id,
            included.includes(a.id)
              ? "included"
              : excluded.includes(a.id)
                ? "excluded"
                : "undecided",
          ]),
        ),
      );
      setDecisionPath(doc.path);
      setNotice("분류를 불러왔어요. 선택 검증을 다시 실행해주세요.");
    });
  const createPlan = (kind: "export" | "move") =>
    run("내보내기 계획", async () => {
      if (!validated || !decisionPath)
        throw new Error("선택 검증을 먼저 완료해주세요.");
      if (!destination) throw new Error("목적지 폴더를 선택해주세요.");
      const envelope = await bridge.request<PlanEnvelope>(`${kind}.plan`, {
        decision: decisionPath,
        to: destination,
        layout: "dated-group",
      });
      const path = await bridge.saveDocument(`${kind}-plan`, envelope.plan);
      setPlan({ kind, path, envelope });
      setReviewed(false);
      setMoveConfirmed(false);
      setReceipt(null);
      setTab("transfers");
      setNotice("계획이 준비됐어요. 대상과 목적지를 확인한 뒤 실행해주세요.");
    });
  const applyPlan = () =>
    run(plan?.kind === "move" ? "원본 이동" : "원본 복사", async () => {
      if (!plan || !reviewed || (plan.kind === "move" && !moveConfirmed))
        throw new Error("계획과 실행 내용을 먼저 확인해주세요.");
      const r = await bridge.request(`${plan.kind}.apply`, {
        plan: plan.path,
        digest: plan.envelope.digest,
      });
      setReceipt(r);
      setReviewed(false);
      setMoveConfirmed(false);
      setNotice(
        plan.kind === "move"
          ? "검증된 이동이 완료됐어요."
          : "복사가 완료됐어요. Photos 원본은 유지돼요.",
      );
    });
  const importRecovery = () =>
    run("기존 계획 불러오기", async () => {
      const doc = await bridge.openDocument();
      if (!doc) return;
      let data = asRecord(doc.data),
        path = doc.path;
      let importedDigest = "";
      if (data.plan && typeof data.digest === "string") {
        importedDigest = data.digest;
        data = asRecord(data.plan);
        path = await bridge.saveDocument("move-recovery-plan", data);
      }
      if (
        data.operation !== "delete-source-after-verified-upload" ||
        !data.exportPlan
      )
        throw new Error(
          "이동 복구에는 move.plan으로 발급된 이동 계획이 필요해요.",
        );
      setRecovery({ path, data });
      setRecoveryDigest(importedDigest);
      setRecoveryConfirmed(false);
      setReceipt(null);
    });
  const recover = () =>
    run("같은 이동 재시도", async () => {
      if (
        !recovery ||
        !recoveryConfirmed ||
        !/^[0-9a-f]{64}$/i.test(recoveryDigest)
      )
        throw new Error(
          "기존 이동 계획의 64자리 digest와 실행 내용을 확인해주세요.",
        );
      setReceipt(
        await bridge.request("move.apply", {
          plan: recovery.path,
          digest: recoveryDigest,
        }),
      );
      setRecoveryConfirmed(false);
      setNotice("같은 이동 작업의 복구 결과를 확인했어요.");
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
      const value = { ...editingProject, title: editingProject.title.trim() };
      const next = {
        ...dashboard,
        updatedAt: new Date().toISOString(),
        projects: dashboard.projects.some((p) => p.id === value.id)
          ? dashboard.projects.map((p) => (p.id === value.id ? value : p))
          : [value, ...dashboard.projects],
      };
      await bridge.saveDashboard(next);
      setDashboard(next);
      setEditingProject(null);
      setNotice("콘텐츠 진행 상태를 저장했어요.");
    });
  const newProject = () =>
    setEditingProject({
      id: crypto.randomUUID(),
      title: "",
      date: localDate(),
      stage: "idea",
      nextAction: "",
      publicURL: "",
      shared: false,
    });
  useEffect(() => {
    if (!editingProject) return;
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        setEditingProject(null);
        return;
      }
      if (event.key !== "Tab") return;
      const elements = Array.from(
        document.querySelectorAll<HTMLElement>(
          "[role=dialog] button:not(:disabled), [role=dialog] input:not(:disabled), [role=dialog] select:not(:disabled), [role=dialog] textarea:not(:disabled)",
        ),
      );
      const first = elements[0],
        last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [editingProject, busy]);
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
  const counts = detail
    ? {
        included: detail.assets.filter((a) => choices[a.id] === "included")
          .length,
        excluded: detail.assets.filter((a) => choices[a.id] === "excluded")
          .length,
        undecided: detail.assets.filter(
          (a) => !choices[a.id] || choices[a.id] === "undecided",
        ).length,
      }
    : null;
  const planData = plan
    ? asRecord(
        plan.kind === "move"
          ? plan.envelope.plan.exportPlan
          : plan.envelope.plan,
      )
    : {};
  const receiptRecord = asRecord(receipt),
    exportReceipt = asRecord(receiptRecord.exportReceipt || receipt),
    receiptEntries = Array.isArray(exportReceipt.entries)
      ? exportReceipt.entries.map(asRecord)
      : [];
  const nativeNotice = (
    <div className="desktop-notice">
      <Icon name="library" />
      <div>
        <strong>촬영본 작업은 데스크톱에서 이어가요.</strong>
        <p>
          여기서는 공유된 제작 현황만 확인할 수 있어요. Photos 접근과 원본
          복사·이동은 데스크톱 앱에서 실행해주세요.
        </p>
      </div>
    </div>
  );
  const connection = (
    <div className="connection-strip">
      <span
        className={`status-dot ${status && ["authorized", "limited"].includes(status.permission) ? "good" : ""}`}
      />
      <div>
        <strong>
          {status
            ? `Photos ${permissions[status.permission] || status.permission}`
            : "네이티브 연결 확인 필요"}
        </strong>
        <span>
          {status
            ? `도우미 ${status.appVersion} · 프로토콜 ${status.protocolVersion}`
            : "앱과 함께 포함된 Photos 도우미에 연결해요."}
        </span>
      </div>
      <button className="quiet" onClick={refreshStatus} disabled={!!busy}>
        상태 새로고침
      </button>
      {status && !["authorized", "limited"].includes(status.permission) && (
        <button onClick={authorize} disabled={!!busy || !protocolOK}>
          Photos 접근 요청
        </button>
      )}
    </div>
  );
  const titles: Record<Tab, string> = {
    dashboard: "작업의 흐름을 한눈에",
    library: "다음 이야기를 골라요",
    editor: "선택한 장면을 완성해요",
    transfers: "확인하고, 안전하게 옮겨요",
    settings: "내 작업 환경",
  };
  const descriptions: Record<Tab, string> = {
    dashboard: "촬영부터 게시까지, 지금 필요한 다음 작업을 확인해요.",
    library:
      "Apple Photos에서 날짜별 촬영본을 찾고 콘텐츠에 사용할 장면을 골라요.",
    transfers: "원본을 유지하는 복사와 검증 후 이동을 구분해서 실행해요.",
    editor:
      "장소 안내 묶음과 본문 자막을 더하고, 선택한 시점으로 표지를 만들어요.",
    settings: "로컬 연결과 모바일에서 볼 현황의 공유 범위를 관리해요.",
  };
  const navigationItems: [Tab, string][] = [
    ["dashboard", "대시보드"],
    ["library", "촬영 보관함"],
    ["editor", "영상 편집"],
    ["transfers", "내보내기"],
  ];
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
        navigation={navigation}
        items={[...navigationItems, ["settings", "설정"]]}
        projects={dashboard.projects}
        onNavigate={key => navigateTo(key as Tab)}
        onJump={navigation.jump}
        settingsActive={tab === "settings"}
        terminal={drawerMode}
        onTerminal={bridge.workbench ? () => setDrawerMode(mode => mode === "open" ? "folded" : "open") : undefined}
        onProject={!readOnly ? project => { setEditingProject({ ...project }); } : undefined}
      />
      <aside className="sidebar">
        <div className="workspace-label">나의 작업공간</div>
        <nav aria-label="주요 메뉴">
          {navigationItems.map(([key, text]) => (
            <button
              key={key}
              aria-label={text}
              className={`nav-item ${tab === key ? "active" : ""}`}
              aria-current={tab === key ? "page" : undefined}

              onClick={() => navigateTo(key)}
            >
              <Icon name={key} />
              <span>{text}</span>
              {key === "dashboard" && (
                <small aria-hidden="true">{totals.all}</small>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-badge">
            <span className="status-dot good" />
            {readOnly
              ? "공유된 현황"
              : bridge.mode === "demo"
                ? "예시 작업공간"
                : "로컬 작업공간"}
          </div>
          <p>
            {readOnly
              ? "마지막 동기화된 내용을 보여드려요."
              : "촬영 원본은 내 Mac에 그대로 있어요."}
          </p>
          <span className="version">REELS WORKSPACE · 0.1</span>
        </div>
      </aside>
      <main className="main">
        {bridge.mode === "demo" && (
          <div className="demo-banner" role="note">
            예시 데이터로 둘러보는 화면이에요. 실제 Photos와 서버 데이터는
            변경하지 않아요.
          </div>
        )}
        <div className="page-heading">
          <div className="shell-page-description">
            <span className="eyebrow">
              {tab === "dashboard"
                ? "YOUR CREATIVE FLOW"
                : tab === "library"
                  ? "FROM YOUR CAMERA"
                  : tab === "editor"
                    ? "MAKE YOUR REEL"
                    : tab === "transfers"
                      ? "REVIEW & TRANSFER"
                      : "WORKSPACE SETTINGS"}
            </span>
            <h1>{titles[tab]}</h1>
            <p>{descriptions[tab]}</p>
          </div>
          {tab === "dashboard" && !readOnly && (
            <button className="primary" onClick={newProject} disabled={!!busy}>
              <Icon name="plus" />새 콘텐츠
            </button>
          )}
          {tab === "dashboard" && readOnly && (
            <button
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
        </div>
        {!protocolOK && (
          <div className="alert error" role="alert">
            도우미 프로토콜 {status?.protocolVersion}은 지원하지 않아요. 앱과
            도우미 버전을 확인해주세요.
          </div>
        )}
        {error && !editingProject && (
          <div className="alert error" role="alert">
            <strong>작업을 완료하지 못했어요.</strong>
            <span>{error}</span>
            <button
              className="quiet"
              aria-label="오류 닫기"
              onClick={() => setError("")}
            >
              ×
            </button>
          </div>
        )}
        {notice && (
          <div className="alert success" role="status">
            {notice}
          </div>
        )}
        {busy && (
          <div className="working" role="status">
            <span className="spinner" />
            {busy} 중이에요. 완료 결과를 기다려주세요.
          </div>
        )}
        {tab === "dashboard" && (
          <>
            <div className="stats-grid">
              {[
                ["전체 콘텐츠", totals.all, "한곳에 모인 이야기"],
                ["진행 중", totals.active, "다음 장면을 준비해요"],
                ["검토 대기", totals.review, "한 번 더 확인해요"],
                ["게시 완료", totals.published, "세상에 나간 이야기"],
              ].map(([name, value, desc], i) => (
                <div className={`stat-card stat-${i}`} key={name}>
                  <span>{name}</span>
                  <strong>
                    {value}
                    <small>개</small>
                  </strong>
                  <p>{desc}</p>
                </div>
              ))}
            </div>
            <section className="content-section">
              <div className="section-heading">
                <h2>
                  콘텐츠 보드 <span>{totals.all}</span>
                </h2>
                <p>
                  {readOnly ? "마지막 동기화" : "마지막 저장"} ·{" "}
                  {readableTime(dashboard.updatedAt)}
                </p>
              </div>
              {!dashboard.projects.length ? (
                <Empty title="첫 번째 이야기를 준비해볼까요?">
                  {readOnly
                    ? "아직 공유된 콘텐츠가 없어요. 데스크톱에서 공유할 항목을 선택하고 현황을 동기화해주세요."
                    : "촬영본을 고르거나 새 콘텐츠를 추가해서 제작 흐름을 시작해보세요."}
                </Empty>
              ) : (
                <div className="project-grid">
                  {dashboard.projects.map((project, i) => (
                    <article className="project-card" key={project.id}>
                      <div className={`project-art art-${i % 4}`}>
                        <span className="art-lines" />
                        <span className="project-number">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <span className={`stage-tag stage-${project.stage}`}>
                          {stages[project.stage]}
                        </span>
                      </div>
                      <div className="project-body">
                        <span className="project-date">
                          {project.date || "날짜 미정"}
                          {project.shared && (
                            <span className="share-indicator">모바일 공유</span>
                          )}
                        </span>
                        <h3>{project.title}</h3>
                        <p>
                          {project.nextAction || "다음 할 일을 정해보세요."}
                        </p>
                        <div className="project-footer">
                          {project.publicURL ? (
                            <a
                              href={project.publicURL}
                              target="_blank"
                              rel="noreferrer"
                            >
                              게시물 보기 ↗
                            </a>
                          ) : (
                            <span>
                              {project.stage === "published"
                                ? "게시 링크를 추가해주세요."
                                : "작업을 이어가요"}
                            </span>
                          )}
                          {!readOnly && (
                            <button
                              className="icon-button"
                              aria-label={`${project.title} 수정`}
                              onClick={() => setEditingProject({ ...project })}
                            >
                              <Icon name="arrow" />
                            </button>
                          )}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>
            {!readOnly && (
              <button
                className="library-callout"
                onClick={() => setTab("library")}
              >
                <div className="callout-icon">
                  <Icon name="library" />
                </div>
                <div>
                  <strong>아직 고르지 않은 장면이 있나요?</strong>
                  <span>촬영 보관함에서 날짜별로 찾아보세요.</span>
                </div>
                <Icon name="arrow" />
              </button>
            )}
          </>
        )}
        {tab === "library" &&
          (readOnly ? (
            nativeNotice
          ) : (
            <>
              {connection}
              {status?.permission === "limited" && (
                <p className="inline-warning">
                  일부 사진만 허용되어 있어요. 목록에 없는 촬영본은 Photos 접근
                  범위를 확인해주세요.
                </p>
              )}
              {status &&
                ["denied", "restricted"].includes(status.permission) && (
                  <p className="inline-warning">
                    시스템 설정 → 개인정보 보호 및 보안 → 사진에서 접근 권한을
                    확인해주세요.
                  </p>
                )}
              <section className="panel library-controls">
                <label>
                  촬영 날짜
                  <input
                    aria-label="촬영 날짜"
                    type="date"
                    value={date}
                    onChange={(e) => {
                      setDate(e.target.value);
                      setGroups(null);
                      clearSelection();
                    }}
                    disabled={!!busy}
                  />
                </label>
                <label>
                  그룹 크기
                  <select
                    aria-label="그룹 크기"
                    value={level}
                    onChange={(e) =>
                      changeLevel(e.target.value as "fine" | "coarse")
                    }
                    disabled={!!busy}
                  >
                    <option value="fine">장면별로 자세히</option>
                    <option value="coarse">방문 단위로 넓게</option>
                  </select>
                </label>
                <button
                  className="primary"
                  onClick={sync}
                  disabled={!!busy || !canIndex || !date}
                >
                  날짜 색인
                </button>
              </section>
              {!groups ? (
                <Empty title="촬영한 날짜부터 골라주세요.">
                  날짜를 색인하면 시간과 위치 정보를 바탕으로 모인 촬영 그룹을
                  볼 수 있어요.
                </Empty>
              ) : !groups.groups.length ? (
                <Empty title="이 날짜에는 촬영본이 없어요.">
                  다른 날짜를 선택하거나 Photos 접근 범위를 확인해주세요.
                </Empty>
              ) : (
                <div className="library-layout">
                  <section className="group-list" aria-label="촬영 그룹">
                    <div className="section-heading">
                      <h2>촬영 그룹</h2>
                      <span>{groups.groups.length}개</span>
                    </div>
                    {groups.groups.map((g) => (
                      <button
                        key={g.id}
                        className={`group-item ${detail?.group.id === g.id ? "selected" : ""}`}
                        aria-label={`그룹 ${g.localDate} · ${g.assetIDs.length}개`}
                        onClick={() => selectGroup(g.id)}
                        disabled={!!busy}
                      >
                        <span className="group-icon">
                          <Icon name="library" />
                        </span>
                        <span>
                          <strong>{g.localDate}</strong>
                          <small>
                            {g.assetIDs.length}개 장면 ·{" "}
                            {g.level === "fine" ? "장면별" : "방문별"}
                          </small>
                          <small>{readableTime(g.start)}</small>
                          {g.warnings.length > 0 && (
                            <small className="warning-text">
                              {g.warnings.join(" · ")}
                            </small>
                          )}
                        </span>
                        <Icon name="arrow" />
                      </button>
                    ))}
                  </section>
                  <div className="group-content">
                    {!detail ? (
                      <Empty title="어떤 그룹을 살펴볼까요?">
                        왼쪽 그룹을 선택하면 자산 정보와 분류 작업을 이어갈 수
                        있어요.
                      </Empty>
                    ) : (
                      <>
                        <section className="panel">
                          <div className="section-heading">
                            <div>
                              <span className="eyebrow">CAPTURE GROUP</span>
                              <h2>{detail.group.localDate}의 장면들</h2>
                              <p>
                                {detail.assets.length}개 ·{" "}
                                {readableTime(detail.group.start)}부터
                              </p>
                            </div>
                            <button
                              onClick={() => inspect(1)}
                              disabled={!!busy}
                            >
                              미리보기 만들기
                            </button>
                          </div>
                          <p className="muted compact">
                            미리보기는 페이지당 최대 12개예요. 동영상은 포스터
                            이미지를 보여줘요.
                          </p>
                          {detail.group.warnings.map((w) => (
                            <p className="inline-warning" key={w}>
                              {w}
                            </p>
                          ))}
                          {inspection && (
                            <>
                              <div className="evidence-summary">
                                <span>
                                  미리보기 {evidencePage} /{" "}
                                  {Math.max(
                                    1,
                                    Math.ceil(detail.assets.length / 12),
                                  )}
                                  페이지
                                </span>
                                <span>
                                  열어본 페이지 {reviewedPages.length}개
                                </span>
                              </div>
                              {inspection.packet.warnings.map((w) => (
                                <p className="inline-warning" key={w}>
                                  {w}
                                </p>
                              ))}
                              <div className="evidence-grid">
                                {inspection.packet.samples.map((sample) => (
                                  <figure key={sample.id}>
                                    <img
                                      src={images[sample.assetID]}
                                      alt={`${detail.assets.find((a) => a.id === sample.assetID)?.publicFilename || sample.assetID} 미리보기`}
                                    />
                                    <figcaption>
                                      <strong>
                                        {detail.assets.find(
                                          (a) => a.id === sample.assetID,
                                        )?.publicFilename || sample.assetID}
                                      </strong>
                                      {sample.kind === "videoFrame" && (
                                        <small>동영상 포스터</small>
                                      )}
                                      {sample.ocr.map((o, i) => (
                                        <p className="ocr" key={i}>
                                          {o.text}
                                        </p>
                                      ))}
                                      {sample.privacyFlags.map((f) => (
                                        <span className="privacy-tag" key={f}>
                                          {f}
                                        </span>
                                      ))}
                                    </figcaption>
                                  </figure>
                                ))}
                              </div>
                              <div className="pagination">
                                <button
                                  onClick={() => inspect(evidencePage - 1)}
                                  disabled={!!busy || evidencePage <= 1}
                                >
                                  이전 페이지
                                </button>
                                <span>
                                  {evidencePage} /{" "}
                                  {Math.max(
                                    1,
                                    Math.ceil(detail.assets.length / 12),
                                  )}
                                </span>
                                <button
                                  onClick={() => inspect(evidencePage + 1)}
                                  disabled={
                                    !!busy ||
                                    evidencePage >=
                                      Math.ceil(detail.assets.length / 12)
                                  }
                                >
                                  다음 페이지
                                </button>
                              </div>
                            </>
                          )}
                        </section>
                        <section className="panel">
                          <div className="section-heading">
                            <h2>사용할 촬영본 고르기</h2>
                            <button
                              className="quiet"
                              onClick={() => {
                                setChoices(
                                  Object.fromEntries(
                                    detail.assets.map((a) => [
                                      a.id,
                                      "included",
                                    ]),
                                  ),
                                );
                                invalidate();
                              }}
                              disabled={!!busy}
                            >
                              모두 포함
                            </button>
                          </div>
                          <div className="selection-counts">
                            <span>
                              포함 <strong>{counts?.included}</strong>
                            </span>
                            <span>
                              제외 <strong>{counts?.excluded}</strong>
                            </span>
                            <span>
                              미정 <strong>{counts?.undecided}</strong>
                            </span>
                          </div>
                          <div className="asset-list">
                            {detail.assets.map((asset) => (
                              <AssetRow
                                key={asset.id}
                                asset={asset}
                                choice={choices[asset.id] || "undecided"}
                                disabled={!!busy}
                                editingDisabled={!!busy || editorRendering}
                                onEdit={() => editPhotosVideo(asset.id)}
                                onChange={(value) => {
                                  setChoices((p) => ({
                                    ...p,
                                    [asset.id]: value,
                                  }));
                                  invalidate();
                                }}
                              />
                            ))}
                          </div>
                        </section>
                        <section className="panel">
                          <div className="section-heading">
                            <h2>콘텐츠 분류</h2>
                            <button
                              className="quiet"
                              onClick={importDecision}
                              disabled={!!busy}
                            >
                              분류 파일 불러오기
                            </button>
                          </div>
                          <div className="form-grid">
                            <label>
                              콘텐츠 이름
                              <input
                                value={label}
                                onChange={(e) => {
                                  setLabel(e.target.value);
                                  invalidate();
                                }}
                                placeholder="예: 도쿄의 오후 산책"
                                disabled={!!busy}
                              />
                            </label>
                            <label>
                              판단 신뢰도
                              <input
                                aria-label="판단 신뢰도"
                                type="number"
                                min="0"
                                max="1"
                                step="0.05"
                                value={confidence}
                                onChange={(e) => {
                                  setConfidence(e.target.value);
                                  invalidate();
                                }}
                                disabled={!!busy}
                              />
                            </label>
                            <label className="full">
                              미해결 사항
                              <textarea
                                value={unknowns}
                                onChange={(e) => {
                                  setUnknowns(e.target.value);
                                  invalidate();
                                }}
                                placeholder="확인이 필요한 내용이 있다면 한 줄에 하나씩 적어주세요."
                                disabled={!!busy}
                              />
                            </label>
                          </div>
                          <p className="muted compact">
                            모든 촬영본을 포함·제외로 나누고, 신뢰도 0.8
                            이상·미해결 사항 없음일 때 내보낼 수 있어요.
                          </p>
                          <div className="button-row">
                            <button onClick={saveDecision} disabled={!!busy}>
                              분류 파일 저장
                            </button>
                            <button
                              className="primary"
                              onClick={validate}
                              disabled={!!busy}
                            >
                              선택 검증
                            </button>
                            {validated && (
                              <span className="verified">
                                <Icon name="check" />
                                검증 통과
                              </span>
                            )}
                          </div>
                        </section>
                        <section className="panel">
                          <h2>내보내기 준비</h2>
                          <label>
                            목적지 폴더
                            <div className="input-action">
                              <input
                                aria-label="목적지 폴더"
                                value={destination}
                                readOnly
                                placeholder="iCloud Drive의 허용된 내보내기 폴더"
                              />
                              <button
                                onClick={() =>
                                  run("목적지 선택", async () => {
                                    const path =
                                      await bridge.chooseDestination();
                                    if (path) {
                                      setDestination(path);
                                      setPlan(null);
                                      setReviewed(false);
                                      setMoveConfirmed(false);
                                    }
                                  })
                                }
                                disabled={!!busy}
                              >
                                목적지 선택
                              </button>
                            </div>
                          </label>
                          <p className="muted compact">
                            네이티브 도우미가 허용한 폴더만 사용할 수 있어요.
                            계획을 만드는 단계에서는 원본을 복사하거나 삭제하지
                            않아요.
                          </p>
                          <div className="button-row">
                            <button
                              className="primary"
                              onClick={() => createPlan("export")}
                              disabled={!!busy || !validated || !destination}
                            >
                              복사 계획 만들기
                            </button>
                            <button
                              onClick={() => createPlan("move")}
                              disabled={!!busy || !validated || !destination}
                            >
                              이동 계획 만들기
                            </button>
                          </div>
                        </section>
                      </>
                    )}
                  </div>
                </div>
              )}
            </>
          ))}
        {bridge.workbench && (
          <Suspense fallback={null}>
            <DevWorkspace
              api={bridge.workbench}
              mode={drawerMode}
              onModeChange={setDrawerMode}
              onNavigate={(index) => {
                const item = navigationItems[index];
                if (item) navigateTo(item[0]);
              }}
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
        {tab === "transfers" &&
          (readOnly ? (
            nativeNotice
          ) : (
            <>
              <div className="transfer-types">
                <div>
                  <span className="type-icon">↗</span>
                  <h3>복사 내보내기</h3>
                  <p>
                    선택한 원본을 목적지에 복사해요.
                    <br />
                    Photos 원본은 그대로 유지돼요.
                  </p>
                </div>
                <div>
                  <span className="type-icon amber">⇢</span>
                  <h3>검증 후 이동</h3>
                  <p>
                    업로드와 파일 검증을 마친 뒤<br />
                    Photos 원본을 최근 삭제 항목으로 옮겨요.
                  </p>
                </div>
              </div>
              {plan ? (
                <section className="panel plan-panel">
                  <div className="section-heading">
                    <h2>{plan.kind === "move" ? "이동" : "복사"} 계획 검토</h2>
                    <span
                      className={`stage-tag ${plan.kind === "move" ? "stage-review" : "stage-selected"}`}
                    >
                      {plan.kind === "move" ? "원본 삭제 포함" : "원본 유지"}
                    </span>
                  </div>
                  <PlanSummary data={planData} />
                  <label>
                    계획 digest
                    <code className="digest">{plan.envelope.digest}</code>
                  </label>
                  <p className="file-path">계획 파일: {plan.path}</p>
                  <JSONDetails
                    data={plan.envelope.plan}
                    label="계획 상세 보기"
                  />
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={reviewed}
                      onChange={(e) => setReviewed(e.target.checked)}
                      disabled={!!busy}
                    />
                    계획을 검토했어요
                  </label>
                  {plan.kind === "move" && (
                    <label className="checkbox-row destructive-check">
                      <input
                        type="checkbox"
                        checked={moveConfirmed}
                        onChange={(e) => setMoveConfirmed(e.target.checked)}
                        disabled={!!busy}
                      />
                      Photos 원본이 최근 삭제 항목으로 이동함을 확인했어요
                    </label>
                  )}
                  <button
                    className={plan.kind === "move" ? "danger" : "primary"}
                    onClick={applyPlan}
                    disabled={
                      !!busy ||
                      !reviewed ||
                      (plan.kind === "move" && !moveConfirmed)
                    }
                  >
                    {plan.kind === "move" ? "원본 이동 실행" : "복사 실행"}
                  </button>
                </section>
              ) : (
                <section className="panel">
                  <Empty title="검토할 내보내기 계획이 없어요.">
                    촬영 보관함에서 자산을 분류하고 선택을 검증한 뒤 계획을
                    만들어주세요.
                  </Empty>
                  <button className="primary" onClick={() => setTab("library")}>
                    촬영 보관함 열기
                  </button>
                </section>
              )}
              <section className="panel">
                <div className="section-heading">
                  <div>
                    <h2>기존 이동 복구</h2>
                    <p>
                      중단된 작업은 같은 이동 계획과 digest로 다시 시도해요.
                    </p>
                  </div>
                  <button onClick={importRecovery} disabled={!!busy}>
                    기존 계획 불러오기
                  </button>
                </div>
                {recovery && (
                  <>
                    <PlanSummary data={asRecord(recovery.data.exportPlan)} />
                    <p className="file-path">{recovery.path}</p>
                    <label>
                      복구 digest
                      <input
                        aria-label="복구 digest"
                        value={recoveryDigest}
                        onChange={(e) => {
                          setRecoveryDigest(e.target.value.trim());
                          setRecoveryConfirmed(false);
                        }}
                        placeholder="기존 이동 계획의 64자리 SHA-256"
                        disabled={!!busy}
                      />
                    </label>
                    <label className="checkbox-row destructive-check">
                      <input
                        type="checkbox"
                        checked={recoveryConfirmed}
                        onChange={(e) => setRecoveryConfirmed(e.target.checked)}
                        disabled={!!busy}
                      />
                      같은 이동의 원본 삭제와 복구 내용을 확인했어요
                    </label>
                    <button
                      className="danger"
                      onClick={recover}
                      disabled={
                        !!busy ||
                        !recoveryConfirmed ||
                        !/^[0-9a-f]{64}$/i.test(recoveryDigest)
                      }
                    >
                      같은 이동 재시도
                    </button>
                  </>
                )}
                <p className="muted compact">
                  업로드 대기나 삭제 후 결과 기록 실패가 있었다면 새 계획으로
                  바꾸지 마세요. 원본 이동 여부와 복구 가능 여부는 네이티브
                  도우미가 확인해요.
                </p>
              </section>
              {receipt !== null && (
                <section className="panel receipt-panel">
                  <div className="section-heading">
                    <div>
                      <span className="eyebrow">COMPLETED</span>
                      <h2>작업 결과</h2>
                    </div>
                    <span className="verified">
                      <Icon name="check" />
                      결과 기록 확인
                    </span>
                  </div>
                  <div className="receipt-stats">
                    <span>
                      <strong>{receiptEntries.length}</strong>파일
                    </span>
                    <span>
                      <strong>
                        {receiptEntries
                          .reduce((n, e) => n + Number(e.bytes || 0), 0)
                          .toLocaleString()}
                      </strong>
                      bytes
                    </span>
                    <span>
                      <strong>
                        {receiptEntries.filter((e) => e.reused).length}
                      </strong>
                      재사용
                    </span>
                    {Array.isArray(receiptRecord.deletedAssetIDs) && (
                      <span>
                        <strong>{receiptRecord.deletedAssetIDs.length}</strong>
                        원본 이동
                      </span>
                    )}
                  </div>
                  <p className="file-path">
                    {String(exportReceipt.destinationRoot || "")}
                  </p>
                  {asStrings(exportReceipt.warnings).map((w) => (
                    <p className="inline-warning" key={w}>
                      {w}
                    </p>
                  ))}
                  <JSONDetails data={receipt} label="파일별 검증 결과 보기" />
                </section>
              )}
            </>
          ))}
        {tab === "settings" && (
          <>
            {!readOnly ? (
              <section className="panel">
                <h2>Photos 연결</h2>
                {connection}
                <p className="muted">
                  사진 접근 권한은 앱에 포함된 네이티브 도우미가 관리해요.
                  제한되거나 거부된 경우 macOS의 사진 접근 설정을 확인해주세요.
                </p>
              </section>
            ) : (
              nativeNotice
            )}
            <section className="panel">
              <div className="section-heading">
                <div>
                  <span className="eyebrow">DESKTOP TO MOBILE</span>
                  <h2>모바일에서 진행 현황 보기</h2>
                </div>
                <span className="share-count">
                  공유 항목 {dashboard.projects.filter((p) => p.shared).length}
                  개
                </span>
              </div>
              <p>
                콘텐츠에서 ‘모바일에 공유’를 켠 항목만 전달해요. 제목·진행
                단계·다음 할 일·날짜·게시 링크를 공유하고, 촬영 원본과 로컬
                경로는 보내지 않아요.
              </p>
              <p className="muted">
                마지막 현황 시각 · {readableTime(dashboard.updatedAt)}
              </p>
              {!readOnly && (
                <>
                  <div className="button-row">
                    <button
                      onClick={() =>
                        run("현황 내보내기", async () => {
                          const path = await bridge.exportSnapshot();
                          if (path)
                            setNotice(`공유 현황을 내보냈어요: ${path}`);
                        })
                      }
                      disabled={!!busy}
                    >
                      공유 현황 내보내기
                    </button>
                  </div>
                  <div className="settings-divider" />
                  <h3>Sites 동기화 연결</h3>
                  <p className="muted compact">
                    내 Sites의 현황 수신 API를 연결해요. 인증 토큰은 이
                    화면에서만 사용하고 저장하지 않아요.
                  </p>
                  <label>
                    동기화 주소
                    <input
                      type="url"
                      value={endpoint}
                      onChange={(e) => setEndpoint(e.target.value)}
                      placeholder="https://your-site.example/api/snapshot"
                      disabled={!!busy}
                    />
                  </label>
                  <label>
                    인증 토큰
                    <input
                      type="password"
                      autoComplete="off"
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      placeholder="필요한 경우 입력"
                      disabled={!!busy}
                    />
                  </label>
                  <button
                    className="primary"
                    onClick={() =>
                      run("현황 동기화", async () => {
                        const result = await bridge.syncSnapshot(
                          endpoint,
                          token,
                        );
                        setToken("");
                        setNotice(
                          `${result.count}개 콘텐츠를 ${readableTime(result.generatedAt)} 기준으로 동기화했어요.`,
                        );
                      })
                    }
                    disabled={!!busy || !endpoint}
                  >
                    선택한 현황 동기화
                  </button>
                </>
              )}
            </section>
          </>
        )}
        <footer className="page-footer">
          <span>작은 장면을, 오래 남을 이야기로.</span>
          <span>Reels Dashboard</span>
        </footer>
      </main>
      {editingProject && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setEditingProject(null);
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-title"
          >
            <div className="section-heading">
              <h2 id="project-title">콘텐츠 기록</h2>
              <button
                className="icon-button"
                aria-label="콘텐츠 기록 닫기"
                onClick={() => setEditingProject(null)}
                disabled={!!busy}
              >
                ×
              </button>
            </div>
            <label>
              콘텐츠 제목
              <input
                autoFocus
                value={editingProject.title}
                onChange={(e) =>
                  setEditingProject({
                    ...editingProject,
                    title: e.target.value,
                  })
                }
                disabled={!!busy}
              />
            </label>
            {error && (
              <div className="alert error" role="alert">
                {error}
              </div>
            )}
            <div className="form-grid">
              <label>
                콘텐츠 날짜
                <input
                  type="date"
                  value={editingProject.date}
                  onChange={(e) =>
                    setEditingProject({
                      ...editingProject,
                      date: e.target.value,
                    })
                  }
                  disabled={!!busy}
                />
              </label>
              <label>
                진행 단계
                <select
                  value={editingProject.stage}
                  onChange={(e) =>
                    setEditingProject({
                      ...editingProject,
                      stage: e.target.value as Stage,
                    })
                  }
                  disabled={!!busy}
                >
                  {Object.entries(stages).map(([key, name]) => (
                    <option value={key} key={key}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              다음 할 일
              <textarea
                value={editingProject.nextAction}
                onChange={(e) =>
                  setEditingProject({
                    ...editingProject,
                    nextAction: e.target.value,
                  })
                }
                disabled={!!busy}
              />
            </label>
            <label>
              게시 링크
              <input
                type="url"
                value={editingProject.publicURL}
                onChange={(e) =>
                  setEditingProject({
                    ...editingProject,
                    publicURL: e.target.value,
                  })
                }
                placeholder="https://"
                disabled={!!busy}
              />
            </label>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={editingProject.shared}
                onChange={(e) =>
                  setEditingProject({
                    ...editingProject,
                    shared: e.target.checked,
                  })
                }
                disabled={!!busy}
              />
              모바일에 공유
            </label>
            <p className="muted compact">
              공유를 켠 콘텐츠의 요약만 내보내기와 Sites 동기화에 포함돼요.
            </p>
            <div className="button-row end">
              <button onClick={() => setEditingProject(null)} disabled={!!busy}>
                취소
              </button>
              <button
                className="primary"
                onClick={saveProject}
                disabled={!!busy}
              >
                저장
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
function AssetRow({
  asset,
  choice,
  onChange,
  disabled,
  editingDisabled,
  onEdit,
}: {
  asset: Asset;
  choice: Choice;
  onChange: (v: Choice) => void;
  disabled: boolean;
  editingDisabled: boolean;
  onEdit: () => void;
}) {
  return (
    <div className={`asset-row ${choice}`}>
      <span className="asset-kind">
        {asset.mediaKind === "video" ? "▶" : "▧"}
      </span>
      <div className="asset-info">
        <strong>{asset.publicFilename || "파일명 미상"}</strong>
        <span>
          {asset.mediaKind === "video"
            ? `동영상 ${asset.durationSeconds.toFixed(1)}초`
            : "사진"}{" "}
          · {asset.pixelWidth}×{asset.pixelHeight} ·{" "}
          {asset.hasLocation ? "위치 있음" : "위치 없음"}
        </span>
        <small>{readableTime(asset.capturedAt)}</small>
      </div>
      {asset.mediaKind === "video" && (
        <button
          className="asset-edit-button"
          aria-label={`이 영상 편집 ${asset.publicFilename || asset.id}`}
          onClick={onEdit}
          disabled={editingDisabled}
        >
          이 영상 편집
        </button>
      )}
      <select
        aria-label={`자산 분류 ${asset.publicFilename || asset.id}`}
        value={choice}
        onChange={(e) => onChange(e.target.value as Choice)}
        disabled={disabled}
      >
        <option value="undecided">미정</option>
        <option value="included">포함</option>
        <option value="excluded">제외</option>
      </select>
    </div>
  );
}
function PlanSummary({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="plan-summary">
      <div>
        <span>콘텐츠</span>
        <strong>{String(data.label || "이름 없음")}</strong>
      </div>
      <div>
        <span>포함 / 제외</span>
        <strong>
          {asStrings(data.includedAssetIDs).length} /{" "}
          {asStrings(data.excludedAssetIDs).length}개
        </strong>
      </div>
      <div className="full">
        <span>목적지</span>
        <strong className="file-path">
          {String(data.destinationRoot || "미확인")}
        </strong>
      </div>
      {asStrings(data.warnings).map((w) => (
        <p className="inline-warning full" key={w}>
          {w}
        </p>
      ))}
    </div>
  );
}
