import { useEffect, useId, useRef, useState } from "react";
import type { DashboardBridge, Project } from "../shared/contracts";
import type { ClipUploadResult } from "../shared/clip-upload";
import {
  Button,
  Dialog,
  Notice,
  Section,
  SectionHeader,
  StatusText,
} from "../shared/ui/primitives";

const signatureHelp =
  "영문·숫자·밑줄·마침표, 선택적으로 @와 끝의 🌹를 사용할 수 있어요.";

/** 설정 화면의 무테 섹션. 이 Mac에만 저장하는 표지 계정 서명. */
export function CoverPreferencesPanel({ bridge }: { bridge: DashboardBridge }) {
  const [signature, setSignature] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
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
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [bridge]);
  if (!bridge.coverPreferences) return null;
  return (
    <Section divided className="settings-section">
      <SectionHeader
        title="표지 계정 서명"
        description="이 Mac의 표지 미리보기와 새 표지에 적용해요. 팔로우 마지막 장은 편집기에서 입력한 서명을 사용해요."
      />
      <form
        className="settings-form cover-signature-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setMessage("");
          setError("");
          try {
            const saved = await bridge.coverPreferences!.set({ signature });
            setSignature(saved.signature);
            setMessage("서명을 저장했어요. 새 미리보기를 만들어 확인해주세요.");
          } catch (error) {
            setError(String(error));
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
            title={signatureHelp}
          />
        </label>
        <Button
          variant="secondary"
          size="large"
          type="submit"
          disabled={!loaded || busy || !signature.trim()}
        >
          서명 저장
        </Button>
      </form>
      {error ? (
        <Notice tone="danger">{error}</Notice>
      ) : (
        <StatusText live busy={busy}>
          {message}
        </StatusText>
      )}
    </Section>
  );
}

/**
 * 콘텐츠 카드의 hover 보조 동작(.project-actions)에서 여는 클립 업로드 묶음 다이얼로그.
 * 촬영 지도·메타데이터 분석과 같은 조용한 텍스트 버튼 + 공용 Dialog.
 */
export function ClipUploadControls({
  bridge,
  project,
}: {
  bridge: DashboardBridge;
  project: Project;
}) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [videoPath, setVideoPath] = useState("");
  const [coverPath, setCoverPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ClipUploadResult>();
  const opener = useRef<HTMLButtonElement>(null);
  const formId = useId();
  if (!bridge.clipUpload) return null;
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => opener.current?.focus());
  };
  return (
    <>
      <button
        ref={opener}
        className="clip-upload-open"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        클립 업로드 묶음
      </button>
      {open && (
        <Dialog
          open
          onClose={close}
          className="clip-upload-dialog"
          aria-label={`${project.title} 클립 업로드 묶음`}
          title={`${project.title} · 클립 업로드 묶음`}
          closeLabel="클립 업로드 묶음 닫기"
          footer={
            <Button
              variant="primary"
              type="submit"
              form={formId}
              disabled={busy || !description.trim()}
            >
              {busy ? "묶음 만드는 중…" : "업로드 묶음 만들기"}
            </Button>
          }
        >
          <form
            id={formId}
            className="clip-upload-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              setResult(undefined);
              try {
                const dashboard = await bridge.loadDashboard();
                const current = dashboard.projects.find(
                  (p) => p.id === project.id,
                );
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
            {(["video", "cover"] as const).map((kind) => (
              <label key={kind}>
                {kind === "video" ? "영상" : "표지"}
                <select
                  disabled={busy}
                  title="현재 전달본을 우선 사용해요. 후보가 여러 개면 직접 선택해주세요."
                  value={kind === "video" ? videoPath : coverPath}
                  onChange={(e) =>
                    (kind === "video" ? setVideoPath : setCoverPath)(
                      e.target.value,
                    )
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
                rows={5}
                disabled={busy}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
          </form>
          {error && <Notice tone="danger">{error}</Notice>}
          {result && (
            <div role="status" className="clip-upload-result">
              <p>묶음을 만들었어요. 업로드 후 임시 폴더를 지워주세요.</p>
              <p className="resource-path">{result.directory}</p>
              <Button
                size="small"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(result.directory)
                    .catch((error) => setError(String(error)))
                }
              >
                폴더 경로 복사
              </Button>
              <ul>
                {Object.entries(result.files).map(([kind, file]) => (
                  <li key={kind}>
                    <span>
                      {file.path.split("/").at(-1)} ·{" "}
                      {file.bytes.toLocaleString()} bytes
                    </span>
                    <small className="resource-path">{file.path}</small>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}
