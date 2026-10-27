import { createDemoEditor } from "./editor-demo";
import type {
  Arguments,
  Asset,
  CommandMethod,
  Dashboard,
  DashboardBridge,
  Decision,
  Group,
  Inspection,
  PlanEnvelope,
  Snapshot,
} from "./contracts";
import { emptyDashboard } from "./contracts";
import { validateDashboard, toSnapshot } from "./data";

export function createDemoBridge(
  search = typeof window === "undefined" ? "" : window.location.search,
  storage:
    | Pick<Storage, "getItem" | "setItem">
    | undefined = typeof localStorage === "undefined"
    ? undefined
    : localStorage,
): DashboardBridge {
  const params = new URLSearchParams(search);
  let permission = params.get("demoPermission") || "authorized";
  let failure = params.get("demoError");
  let currentDate = "2026-10-27";
  let run = "demo-run-1";
  let runCounter = 1;
  const assetCount = Math.min(
    120,
    Math.max(1, Number(params.get("demoAssets")) || 15),
  );
  const documents = new Map<string, unknown>();
  let savedPlan: { path: string; data: unknown } | null = null;
  let savedDecision: { path: string; data: unknown } | null = null;
  const key = "reels-dashboard-demo-v1";
  const assets = (): Asset[] =>
    Array.from({ length: assetCount }, (_, i) => ({
      id: `demo-asset-${i + 1}`,
      mediaKind: i % 3 === 0 ? "video" : "photo",
      capturedAt: `${currentDate}T${String(10 + Math.floor(i / 6)).padStart(2, "0")}:${String((i * 7) % 60).padStart(2, "0")}:00Z`,
      durationSeconds: i % 3 === 0 ? 8 + i : 0,
      pixelWidth: 1920,
      pixelHeight: 1080,
      hasLocation: i % 2 === 0,
      publicFilename: `DEMO_${String(i + 1).padStart(3, "0")}.${i % 3 === 0 ? "MOV" : "HEIC"}`,
    }));
  const group = (level = "fine"): Group => ({
    id: "demo-group-1",
    level: level === "coarse" ? "coarse" : "fine",
    localDate: currentDate,
    start: `${currentDate}T10:00:00Z`,
    end: `${currentDate}T12:38:00Z`,
    assetIDs: assets().map((a) => a.id),
    warnings: [],
  });
  function decisionAt(path: string) {
    const value = documents.get(path) as Decision | undefined;
    if (!value)
      throw new Error("선택 파일을 찾을 수 없어요. 먼저 분류를 저장해주세요.");
    if (value.indexRunID !== run)
      throw new Error(
        "stale-index-run: 날짜를 다시 조회하고 분류를 확인해주세요.",
      );
    const expected = assets().map((a) => a.id);
    const all = [...value.includedAssetIDs, ...value.excludedAssetIDs];
    if (value.confidence < 0.8 || value.confidence > 1 || value.unknowns.length)
      throw new Error("판단 신뢰도는 0.8 이상이고 미해결 사항이 없어야 해요.");
    if (
      !value.includedAssetIDs.length ||
      all.length !== expected.length ||
      new Set(all).size !== all.length ||
      all.some((id) => !expected.includes(id))
    )
      throw new Error("모든 자산을 중복 없이 포함 또는 제외로 나눠주세요.");
    return value;
  }
  const digest = (kind: string) =>
    kind === "move" ? "b".repeat(64) : "a".repeat(64);
  function makePlan(
    kind: string,
    decision: Decision,
    destination: string,
  ): PlanEnvelope {
    const exportPlan = {
      schemaVersion: 1,
      indexRunID: run,
      groupID: "demo-group-1",
      generatedAt: new Date().toISOString(),
      destinationRoot: destination,
      stagingRoot: "/demo/private/staging",
      groupAssetIDs: assets().map((a) => a.id),
      includedAssetIDs: decision.includedAssetIDs,
      excludedAssetIDs: decision.excludedAssetIDs,
      label: decision.label,
      confidence: decision.confidence,
      warnings: [],
    };
    return {
      plan:
        kind === "move"
          ? {
              schemaVersion: 1,
              exportPlan,
              operation: "delete-source-after-verified-upload",
            }
          : exportPlan,
      digest: digest(kind),
    };
  }
  async function request(method: CommandMethod, args: Arguments = {}) {
    if (
      failure &&
      (failure === method ||
        (method === "groups.inspect" && failure === "evidence-timeout") ||
        (method === "move.apply" &&
          ["icloud-upload-timeout", "source-delete-failed"].includes(failure)))
    ) {
      const error = failure;
      failure = null;
      throw new Error(
        `${error}: 예시 오류예요. 같은 작업을 다시 시도할 수 있어요.`,
      );
    }
    if (method === "status")
      return {
        appVersion: "0.1.0-demo",
        protocolVersion: Number(params.get("demoProtocol") || 1),
        permission,
      };
    if (method === "authorize") {
      permission = "authorized";
      return { permission };
    }
    if (method === "sync") {
      if (!["authorized", "limited"].includes(permission))
        throw new Error(
          "photos-permission-required: Photos 접근 권한을 확인해주세요.",
        );
      currentDate = args.date;
      run = `demo-run-${++runCounter}`;
      return {
        indexRunID: run,
        localDate: currentDate,
        assetCount: currentDate === "1900-01-01" ? 0 : assetCount,
        coarseSessionCount: currentDate === "1900-01-01" ? 0 : 1,
        fineGroupCount: currentDate === "1900-01-01" ? 0 : 1,
      };
    }
    if (method === "groups.list")
      return {
        schemaVersion: 1,
        indexRunID: run,
        level: args.level || "fine",
        groups: currentDate === "1900-01-01" ? [] : [group(args.level)],
      };
    if (method === "groups.show")
      return {
        schemaVersion: 1,
        indexRunID: run,
        group: group(),
        assets: assets(),
      };
    if (method === "groups.inspect") {
      const pageNumber = Number(args.page || 1),
        pageSize = 12,
        all = assets(),
        slice = all.slice((pageNumber - 1) * pageSize, pageNumber * pageSize);
      const partial = params.get("demoPartial") === "1";
      const samples = (partial ? slice.slice(0, -1) : slice).map(
        (asset, i) => ({
          id: `sample-${asset.id}`,
          assetID: asset.id,
          kind: asset.mediaKind === "video" ? "videoFrame" : "photoThumbnail",
          relativePath: `${asset.id}.jpg`,
          ocr:
            i === 0
              ? [{ text: "도쿄 산책 · [이메일 가림]", confidence: 0.98 }]
              : [],
          privacyFlags: i === 0 ? ["face-detected"] : [],
        }),
      );
      return {
        indexRunID: run,
        groupID: group().id,
        outputDirectory: "/demo/evidence",
        sampleFiles: samples.map((s) => `/demo/evidence/${s.relativePath}`),
        evidenceJSON: "/demo/evidence/evidence.json",
        summaryMarkdown: "/demo/evidence/summary.md",
        packet: {
          schemaVersion: 1,
          indexRunID: run,
          group: group(),
          assets: slice,
          samples,
          warnings: partial
            ? [
                "partial-evidence: 일부 미리보기를 만들지 못했어요. 누락된 촬영본을 다시 확인해주세요.",
              ]
            : [],
        },
        page: {
          pageNumber,
          pageSize,
          totalAssets: assetCount,
          totalPages: Math.ceil(assetCount / pageSize),
          assetIDs: slice.map((a) => a.id),
          remainingAssetIDs: all.slice(pageNumber * pageSize).map((a) => a.id),
        },
      };
    }
    if (method === "decisions.validate") {
      const d = decisionAt(args.file);
      return {
        valid: true,
        indexRunID: run,
        groupID: d.groupID,
        includedAssetCount: d.includedAssetIDs.length,
        excludedAssetCount: d.excludedAssetIDs.length,
      };
    }
    if (method === "export.plan" || method === "move.plan")
      return makePlan(method.split(".")[0], decisionAt(args.decision), args.to);
    if (method === "export.apply" || method === "move.apply") {
      const kind = method.split(".")[0],
        plan = documents.get(args.plan) as Record<string, unknown> | undefined;
      if (!plan) throw new Error("계획 파일을 찾을 수 없어요.");
      if (args.digest !== digest(kind))
        throw new Error(
          "digest-mismatch: 발급된 계획의 digest를 확인해주세요.",
        );
      if (
        kind === "move" &&
        plan.operation !== "delete-source-after-verified-upload"
      )
        throw new Error("이동 계획이 아니에요.");
      const data = (kind === "move" ? plan.exportPlan : plan) as {
        includedAssetIDs: string[];
        destinationRoot: string;
      };
      const receipt = {
        schemaVersion: 1,
        destinationRoot: data.destinationRoot,
        completedAt: new Date().toISOString(),
        entries: data.includedAssetIDs.map((id) => ({
          assetID: id,
          safeFilename: `${id}.jpg`,
          bytes: 2048,
          sha256: "c".repeat(64),
          relativePath: `originals/${id}.jpg`,
          reused: false,
        })),
        warnings: [],
      };
      return kind === "move"
        ? {
            schemaVersion: 1,
            exportReceipt: receipt,
            deletedAssetIDs: data.includedAssetIDs,
            completedAt: new Date().toISOString(),
            warnings: [],
          }
        : receipt;
    }
    throw new Error("지원하지 않는 명령이에요.");
  }
  function loadDashboard(): Dashboard {
    try {
      const stored = storage?.getItem(key);
      if (stored) return validateDashboard(JSON.parse(stored));
    } catch {
      /* demo storage may be disabled */
    }
    return {
      ...emptyDashboard(),
      projects: [
        {
          id: "demo-project-1",
          title: "도쿄의 오후 산책",
          date: "2026-10-27",
          stage: "editing",
          nextAction: "첫 장면과 장소 안내를 확인해요.",
          publicURL: "",
          shared: true,
        },
        {
          id: "demo-project-2",
          title: "골목에서 찾은 커피",
          date: "2026-10-26",
          stage: "selected",
          nextAction: "촬영본을 골라 대본을 정리해요.",
          publicURL: "",
          shared: false,
        },
      ],
    };
  }
  function snapshot(): Snapshot {
    return toSnapshot(loadDashboard());
  }
  return {
    mode: "demo",
    editor: createDemoEditor(storage, search, (project, stage) => {
      const dashboard = loadDashboard();
      const previous = dashboard.projects.find(
        (item) => item.id === project.id,
      );
      const item = {
        id: project.id,
        title: previous?.title ?? project.source.name,
        date: previous?.date ?? new Date().toLocaleDateString("en-CA"),
        stage,
        nextAction:
          stage === "review"
            ? "내보낸 영상과 표지를 확인해요."
            : "자막과 장소 안내를 편집해요.",
        publicURL: previous?.publicURL ?? "",
        shared: previous?.shared ?? false,
      };
      dashboard.projects = previous
        ? dashboard.projects.map((p) => (p.id === item.id ? item : p))
        : [...dashboard.projects, item];
      dashboard.updatedAt = new Date().toISOString();
      storage?.setItem(key, JSON.stringify(validateDashboard(dashboard)));
    }),
    request: request as DashboardBridge["request"],
    async saveDocument(name, data) {
      const path = `/demo/documents/${Date.now()}-${name}.json`;
      documents.set(path, data);
      if (name.includes("plan")) savedPlan = { path, data };
      if (name === "decision") savedDecision = { path, data };
      return path;
    },
    async openDocument() {
      if (params.get("demoDocument") === "decision" && savedDecision) {
        if (params.get("demoDocumentInvalid") === "duplicate") {
          const data = structuredClone(savedDecision.data) as Decision;
          data.includedAssetIDs.push(data.includedAssetIDs[0]);
          const path = "/demo/documents/invalid-decision.json";
          documents.set(path, data);
          return { path, data };
        }
        return savedDecision;
      }
      if (savedPlan) return savedPlan;
      const d: Decision = {
        schemaVersion: 1,
        indexRunID: run,
        groupID: "demo-group-1",
        label: "복구 예시",
        confidence: 1,
        includedAssetIDs: assets().map((a) => a.id),
        excludedAssetIDs: [],
        evidenceReferences: [],
        unknowns: [],
      };
      const p = makePlan("move", d, "/demo/iCloud/Exports").plan;
      const path = "/demo/documents/recovery-plan.json";
      documents.set(path, p);
      return { path, data: p };
    },
    async chooseDestination() {
      return "/demo/iCloud/Exports";
    },
    async imageURL(path) {
      const match = path.match(/asset-(\d+)/);
      const n = Number(match?.[1] || 1);
      const hue = (n * 27 + 180) % 360;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="hsl(${hue},25%,35%)"/><circle cx="470" cy="110" r="60" fill="hsl(${hue},50%,75%)"/><path d="M0 350L180 170L380 400L500 270L640 410V480H0Z" fill="hsl(${hue},25%,22%)"/><text x="32" y="440" fill="white" font-family="sans-serif" font-size="24">DEMO · ${String(n).padStart(2, "0")}</text></svg>`;
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    },
    async loadDashboard() {
      return loadDashboard();
    },
    async saveDashboard(value) {
      storage?.setItem(key, JSON.stringify(validateDashboard(value)));
    },
    async exportSnapshot() {
      const blob = new Blob([JSON.stringify(snapshot(), null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "snapshot.json";
      a.click();
      URL.revokeObjectURL(url);
      return "snapshot.json";
    },
    async syncSnapshot(endpoint) {
      if (!endpoint.startsWith("https://"))
        throw new Error("HTTPS 주소를 입력해주세요.");
      return {
        generatedAt: snapshot().generatedAt,
        count: snapshot().projects.length,
      };
    },
  };
}
