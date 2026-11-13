import { useState, type Dispatch, type SetStateAction } from "react";
import type {
  DashboardBridge,
  Decision,
  GroupDetail,
  Groups,
  Inspection,
  PlanEnvelope,
} from "../../shared/contracts";
import { decisionFileSchema } from "../../shared/decision";
import type { EditorProject } from "../../shared/editor";
import { localDate } from "../../shared/lib/format";
import type { Tab } from "../pages";
import { asRecord } from "../ui";
import { isRecoveryDigest, type Choice } from "./shared";

type ActivePlan = {
  kind: "export" | "move";
  path: string;
  envelope: PlanEnvelope;
};
/**
 * Photos 보관함·전송 화면의 상태. App에서 호출해 탭을 바꿔도 값이 유지된다
 * (화면 컴포넌트는 탭 전환 때 사라지므로 상태를 갖지 않는다).
 */
export function usePhotoExport() {
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
  return {
    date,
    setDate,
    level,
    setLevel,
    groups,
    setGroups,
    detail,
    setDetail,
    choices,
    setChoices,
    inspection,
    setInspection,
    images,
    setImages,
    evidencePage,
    setEvidencePage,
    reviewedPages,
    setReviewedPages,
    label,
    setLabel,
    confidence,
    setConfidence,
    unknowns,
    setUnknowns,
    references,
    setReferences,
    decisionPath,
    setDecisionPath,
    validated,
    setValidated,
    destination,
    setDestination,
    plan,
    setPlan,
    reviewed,
    setReviewed,
    moveConfirmed,
    setMoveConfirmed,
    receipt,
    setReceipt,
    recovery,
    setRecovery,
    recoveryDigest,
    setRecoveryDigest,
    recoveryConfirmed,
    setRecoveryConfirmed,
  };
}
export type PhotoExportState = ReturnType<typeof usePhotoExport>;
/**
 * 보관함·전송 작업 핸들러. App의 `run` 이후에 매 렌더 호출하며, 훅을 쓰지
 * 않으므로 App의 훅 순서는 그대로다.
 */
export function photoExportActions(
  {
    date,
    setDate,
    level,
    setLevel,
    groups,
    setGroups,
    detail,
    setDetail,
    choices,
    setChoices,
    inspection,
    setInspection,
    images,
    setImages,
    evidencePage,
    setEvidencePage,
    reviewedPages,
    setReviewedPages,
    label,
    setLabel,
    confidence,
    setConfidence,
    unknowns,
    setUnknowns,
    references,
    setReferences,
    decisionPath,
    setDecisionPath,
    validated,
    setValidated,
    destination,
    setDestination,
    plan,
    setPlan,
    reviewed,
    setReviewed,
    moveConfirmed,
    setMoveConfirmed,
    receipt,
    setReceipt,
    recovery,
    setRecovery,
    recoveryDigest,
    setRecoveryDigest,
    recoveryConfirmed,
    setRecoveryConfirmed,
  }: PhotoExportState,
  {
    bridge,
    run,
    setTab,
    setNotice,
    setEditorProject,
    refreshDashboard,
    editorRendering,
  }: {
    bridge: DashboardBridge;
    run: (name: string, fn: () => Promise<void>) => Promise<void>;
    setTab: (tab: Tab) => void;
    setNotice: Dispatch<SetStateAction<string>>;
    setEditorProject: Dispatch<SetStateAction<EditorProject | null>>;
    refreshDashboard: () => void;
    editorRendering: boolean;
  },
) {
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
      const parsed = decisionFileSchema.safeParse(d);
      if (!parsed.success)
        throw new Error("ModelDecision 형식의 분류 파일이 필요해요.");
      const decision = parsed.data;
      await bridge.request("decisions.validate", { file: doc.path });
      invalidate();
      setLabel(decision.label);
      setConfidence(String(decision.confidence));
      setUnknowns(decision.unknowns.join("\n"));
      setReferences(decision.evidenceReferences);
      const included = decision.includedAssetIDs,
        excluded = decision.excludedAssetIDs;
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
        !isRecoveryDigest(recoveryDigest)
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
  return {
    editPhotosVideo,
    invalidate,
    clearSelection,
    sync,
    changeLevel,
    selectGroup,
    inspect,
    buildDecision,
    saveDecision,
    validate,
    importDecision,
    createPlan,
    applyPlan,
    importRecovery,
    recover,
  };
}
export type PhotoExportActions = ReturnType<typeof photoExportActions>;
