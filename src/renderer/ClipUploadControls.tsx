import { useEffect, useState } from "react";
import type { DashboardBridge, Project } from "../shared/contracts";
import type { ClipUploadResult } from "../shared/clip-upload";

export function CoverPreferencesPanel({ bridge }: { bridge: DashboardBridge }) {
  const [signature, setSignature] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    bridge.coverPreferences
      ?.get()
      .then((value) => {
        if (live) {
          setSignature(value.signature);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (live) setMessage(String(e));
      });
    return () => {
      live = false;
    };
  }, [bridge]);
  if (!bridge.coverPreferences) return null;
  return (
    <section className="panel">
      <h2>표지 계정 서명</h2>
      <p>
        이 Mac의 표지 미리보기와 새 표지에 적용해요. 팔로우 마지막 장은
        편집기에서 입력한 서명을 사용해요.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMessage("");
          try {
            const saved = await bridge.coverPreferences!.set({ signature });
            setSignature(saved.signature);
            setMessage("서명을 저장했어요. 새 미리보기를 만들어 확인해주세요.");
          } catch (error) {
            setMessage(String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          계정 서명
          <input
            value={signature}
            maxLength={34}
            disabled={!loaded || busy}
            onChange={(e) => setSignature(e.target.value)}
            placeholder="@your_account 🌹"
          />
        </label>
        <p className="muted">
          영문·숫자·밑줄·마침표, 선택적으로 @와 끝의 🌹를 사용할 수 있어요.
        </p>
        <button disabled={!loaded || busy || !signature.trim()}>
          서명 저장
        </button>
      </form>
      <p role="status">{message}</p>
    </section>
  );
}

export function ClipUploadControls({
  bridge,
  project,
}: {
  bridge: DashboardBridge;
  project: Project;
}) {
  const [description, setDescription] = useState("");
  const [videoPath, setVideoPath] = useState("");
  const [coverPath, setCoverPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ClipUploadResult>();
  if (!bridge.clipUpload) return null;
  return (
    <details className="local-resources">
      <summary>클립 업로드 묶음</summary>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          setResult(undefined);
          try {
            const dashboard = await bridge.loadDashboard();
            const current = dashboard.projects.find((p) => p.id === project.id);
            if (JSON.stringify(current) !== JSON.stringify(project))
              throw new Error(
                "프로젝트가 바뀌었어요. 새 자료 목록을 확인한 뒤 다시 만들어주세요.",
              );
            setResult(
              await bridge.clipUpload!.create({
                projectId: project.id,
                expectedUpdatedAt: dashboard.updatedAt,
                description,
                ...(videoPath ? { videoPath } : {}),
                ...(coverPath ? { coverPath } : {}),
              }),
            );
          } catch (error) {
            setError(String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>
          현재 전달본을 우선 사용해요. 후보가 여러 개면 영상·표지를 직접
          선택해주세요.
        </p>
        {(["video", "cover"] as const).map((kind) => (
          <label key={kind}>
            {kind === "video" ? "영상" : "표지"}
            <select
              disabled={busy}
              value={kind === "video" ? videoPath : coverPath}
              onChange={(e) =>
                (kind === "video" ? setVideoPath : setCoverPath)(e.target.value)
              }
            >
              <option value="">현재 / 최신 출력 자동 선택</option>
              {(project.resources ?? [])
                .filter((r) =>
                  kind === "cover"
                    ? r.role === "cover"
                    : ["final", "draft"].includes(r.role),
                )
                .map((r) => (
                  <option key={r.path} value={r.path}>
                    {r.label} · {r.path.split("/").at(-1)}
                  </option>
                ))}
            </select>
          </label>
        ))}
        <label>
          클립 설명
          <textarea
            value={description}
            maxLength={20000}
            disabled={busy}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <button disabled={busy || !description.trim()}>
          {busy ? "묶음 만드는 중…" : "업로드 묶음 만들기"}
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      {result && (
        <div role="status">
          <p>묶음을 만들었어요. 업로드 후 임시 폴더를 지워주세요.</p>
          <p className="resource-path">{result.directory}</p>
          <button
            onClick={() =>
              void navigator.clipboard
                .writeText(result.directory)
                .catch((error) => setError(String(error)))
            }
          >
            폴더 경로 복사
          </button>
          <ul>
            {Object.entries(result.files).map(([kind, file]) => (
              <li key={kind}>
                <span>
                  {file.path.split("/").at(-1)} · {file.bytes.toLocaleString()}{" "}
                  bytes
                </span>
                <small className="resource-path">{file.path}</small>
              </li>
            ))}
          </ul>
        </div>
      )}
    </details>
  );
}
