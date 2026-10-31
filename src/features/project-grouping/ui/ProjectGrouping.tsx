import { useEffect, useState } from "react";
import type {
  Dashboard,
  DashboardBridge,
  Project,
} from "../../../shared/contracts";

export function ProjectGrouping({
  api,
  project,
  dashboard,
  disabled,
  onComplete,
}: {
  api: NonNullable<DashboardBridge["projects"]>;
  project: Project;
  dashboard: Dashboard;
  disabled: boolean;
  onComplete: (dashboard: Dashboard, message: string) => void;
}) {
  const [target, setTarget] = useState("");
  const [editKey, setEditKey] = useState("");
  const [edits, setEdits] = useState<Awaited<ReturnType<typeof api.listEdits>>>(
    [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api
      .listEdits()
      .then((value) => {
        if (active) setEdits(value);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [api]);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset disabled={disabled || busy}>
      <legend>프로젝트로 묶기</legend>
      <p className="muted compact">
        한 프로젝트에 자료·편집 구성·출력 버전을 모아요. 연결된 편집 구성은 다시
        내보내도 이 프로젝트에 쌓여요.
      </p>
      <p>
        편집 구성 {project.production?.edits.length ?? 0}개 · 출력 이력{" "}
        {project.production?.exports.length ?? 0}개
      </p>
      {(project.production?.edits ?? []).map((edit) => (
        <p className="compact" key={edit.kind + edit.id}>
          {edit.kind === "video" ? "영상" : "카드뉴스"} ·{" "}
          {edits.find((e) => e.kind === edit.kind && e.id === edit.id)?.title ??
            edit.id}
        </p>
      ))}
      {!!project.production?.exports.length && (
        <details>
          <summary>출력 버전 보기</summary>
          <ul>{project.production.exports.map(output => <li key={output.id}>
            {project.resources?.find(r => r.path === output.path && r.role === output.role)?.label ?? output.role}
            {" · "}{new Date(output.recordedAt).toLocaleString("ko-KR")}
          </li>)}</ul>
        </details>
      )}
      <label>
        저장된 편집 구성 연결
        <select aria-label="저장된 편집 구성 연결" value={editKey} onChange={(e) => setEditKey(e.target.value)}>
          <option value="">편집 구성 선택</option>
          {edits
            .filter((e) => !e.ownerId || e.ownerId === project.id)
            .filter(
              (e) =>
                !project.production?.edits.some(
                  (r) => r.id === e.id && r.kind === e.kind,
                ),
            )
            .map((e) => (
              <option key={e.kind + e.id} value={e.kind + ":" + e.id}>
                {e.kind === "video" ? "영상" : "카드뉴스"} · {e.title}
              </option>
            ))}
        </select>
      </label>
      <button
        disabled={!editKey || disabled || busy}
        onClick={() =>
          run(async () => {
            const edit = edits.find((e) => e.kind + ":" + e.id === editKey)!;
            const next = await api.linkEdit({
              projectId: project.id,
              edit: { kind: edit.kind, id: edit.id },
              expectedUpdatedAt: dashboard.updatedAt,
            });
            onComplete(next, "편집 구성을 프로젝트에 연결했어요.");
          })
        }
      >
        편집 구성 연결
      </button>
      <label>
        이 카드를 합칠 프로젝트
        <select aria-label="이 카드를 합칠 프로젝트" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">대표 프로젝트 선택</option>
          {dashboard.projects
            .filter((p) => p.id !== project.id)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
        </select>
      </label>
      {target && (
        <p className="compact">
          ‘{project.title}’의 자료와 편집 연결을 ‘
          {dashboard.projects.find((p) => p.id === target)?.title}’에 합쳐요.
          대표 프로젝트의 제목·진행 상태를 유지하고, 이 카드는 목록에서
          사라져요. 원본 파일과 합치기 전 기록은 보존해요.
        </p>
      )}
      {disabled && (
        <p className="muted compact">
          수정한 내용을 먼저 저장한 뒤 프로젝트를 묶어주세요.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        disabled={!target || disabled || busy}
        onClick={() =>
          run(async () => {
            const result = await api.merge({
              targetId: target,
              sourceIds: [project.id],
              expectedUpdatedAt: dashboard.updatedAt,
            });
            onComplete(
              result.dashboard,
              "프로젝트를 하나로 합쳤어요. 합치기 전 기록도 백업했어요.",
            );
          })
        }
      >
        선택한 프로젝트로 합치기
      </button>
    </fieldset>
  );
}
