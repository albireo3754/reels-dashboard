import { useEffect, useRef, useState } from "react";
import type { DashboardBridge } from "../shared/contracts";
import type {
  CaptionCue,
  EditSettings,
  EditorBridge,
  EditorProject,
  EditorSummary,
  RenderJob,
} from "../shared/editor";
import "./editor.css";
import { validateEditSettings } from "../shared/editor-model";

type EditorProps = {
  bridge: EditorBridge;
  mode: DashboardBridge["mode"];
  incoming: EditorProject | null;
  active: boolean;
  onRenderingChange: (running: boolean) => void;
  onDashboardChange: () => void;
};
type Preview = {
  url: string;
  time: number;
  kind: "video" | "cover";
  signature: string;
};
const formatSeconds = (value: number) =>
  `${Math.floor(value / 60)}:${(value % 60).toFixed(2).padStart(5, "0")}`;
const signature = (project: EditorProject) =>
  JSON.stringify({ id: project.id, settings: project.settings });
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const clampedTime = (time: number, duration: number) =>
  Math.min(Math.max(0, time), Math.max(0, duration - 0.01));
function validate(project: EditorProject, kind: "video" | "cover" | "export") {
  validateEditSettings(project.settings, project.source.duration, kind);
}

export function Editor({
  bridge,
  mode,
  incoming,
  active,
  onRenderingChange,
  onDashboardChange,
}: EditorProps) {
  const [project, setProject] = useState<EditorProject | null>(null);
  const [recent, setRecent] = useState<EditorSummary[]>([]);
  const [runtime, setRuntime] = useState<{
    available: boolean;
    message: string;
  } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dirty, setDirty] = useState(false);
  const [time, setTime] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [job, setJob] = useState<RenderJob | null>(null);
  const [mediaError, setMediaError] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const projectRef = useRef(project);
  const dirtyRef = useRef(dirty);
  const incomingRef = useRef("");
  const busyRef = useRef(false);
  projectRef.current = project;
  dirtyRef.current = dirty;
  const readonly = mode === "web";
  const rendering = job?.state === "running";
  const unavailable = !runtime?.available;
  const refreshRecent = async () => setRecent(await bridge.list());
  async function run(name: string, operation: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(name);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (e) {
      setError(message(e));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }
  async function adopt(next: EditorProject) {
    if (projectRef.current && dirtyRef.current)
      await bridge.save(projectRef.current);
    videoRef.current?.pause();
    setProject(next);
    setDirty(false);
    setPreview(null);
    setTime(0);
    setMediaError("");
    setError("");
    await refreshRecent();
    onDashboardChange();
  }
  useEffect(() => {
    if (!active || readonly) return;
    let live = true;
    void bridge
      .runtime()
      .then((value) => {
        if (live) setRuntime(value);
      })
      .catch((e) => {
        if (live) setError(message(e));
      });
    void bridge
      .list()
      .then((value) => {
        if (live) setRecent(value);
      })
      .catch((e) => {
        if (live) setError(message(e));
      });
    return () => {
      live = false;
    };
  }, [active, bridge, readonly]);
  useEffect(() => {
    if (!incoming || incomingRef.current === incoming.id || busy || rendering)
      return;
    incomingRef.current = incoming.id;
    void run("Photos 영상 준비", () => adopt(incoming));
  }, [incoming, busy, rendering]);
  useEffect(() => {
    onRenderingChange(Boolean(rendering));
  }, [rendering, onRenderingChange]);
  useEffect(() => {
    if (active) return;
    videoRef.current?.pause();
  }, [active]);
  useEffect(() => {
    if (!job || job.state !== "running") return;
    let disposed = false;
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await bridge.job(job.id);
        if (disposed) return;
        setJob(next);
        if (next.state === "completed") {
          setNotice(
            mode === "demo"
              ? "예시 내보내기가 끝났어요. 실제 파일은 만들지 않았어요."
              : "영상과 표지 내보내기가 완료됐어요.",
          );
          onDashboardChange();
        }
        if (next.state === "failed")
          setError(
            next.error ||
              "내보내기에 실패했어요. 설정과 작업 결과를 확인해주세요.",
          );
        if (next.state === "cancelled")
          setNotice("내보내기를 취소했어요. 촬영 원본은 변경하지 않았어요.");
      } catch (e) {
        if (!disposed)
          setError(
            `진행 상태를 확인하지 못했어요. 다시 확인하고 있어요. ${message(e)}`,
          );
      }
      if (!disposed) timeout = setTimeout(poll, 750);
    };
    timeout = setTimeout(poll, 500);
    return () => {
      disposed = true;
      clearTimeout(timeout);
    };
  }, [job?.id, job?.state, bridge, mode]);
  function changeSettings(update: (settings: EditSettings) => EditSettings) {
    if (!project) return;
    setProject({
      ...project,
      settings: update(project.settings),
      updatedAt: new Date().toISOString(),
    });
    setDirty(true);
    setPreview(null);
    setNotice("");
  }
  const setPlace = <K extends keyof EditSettings["place"]>(
    key: K,
    value: EditSettings["place"][K],
  ) => changeSettings((s) => ({ ...s, place: { ...s.place, [key]: value } }));
  const setCover = <K extends keyof EditSettings["cover"]>(
    key: K,
    value: EditSettings["cover"][K],
  ) => changeSettings((s) => ({ ...s, cover: { ...s.cover, [key]: value } }));
  const setCaptions = <K extends keyof EditSettings["captions"]>(
    key: K,
    value: EditSettings["captions"][K],
  ) =>
    changeSettings((s) => ({
      ...s,
      captions: { ...s.captions, [key]: value },
    }));
  function updateCue(id: string, patch: Partial<CaptionCue>) {
    if (!project) return;
    setCaptions(
      "items",
      project.settings.captions.items.map((cue) =>
        cue.id === id ? { ...cue, ...patch } : cue,
      ),
    );
  }
  const choose = () =>
    run("로컬 영상 준비", async () => {
      const next = await bridge.chooseVideo();
      if (next) await adopt(next);
    });
  const load = (id: string) =>
    run("편집 기록 열기", async () => {
      if (projectRef.current && dirtyRef.current)
        await bridge.save(projectRef.current);
      await adopt(await bridge.load(id));
    });
  const save = () =>
    run("편집 설정 저장", async () => {
      if (!project) return;
      await bridge.save(project);
      setDirty(false);
      await refreshRecent();
      onDashboardChange();
      setNotice("편집 설정을 저장했어요. 원본 영상은 그대로 있어요.");
    });
  const makePreview = (kind: "video" | "cover") =>
    run("미리보기 생성", async () => {
      if (!project) return;
      validate(project, kind);
      videoRef.current?.pause();
      const at = kind === "cover" ? project.settings.cover.time : time;
      const sig = signature(project);
      const url = await bridge.preview(project, at, kind);
      if (projectRef.current && signature(projectRef.current) === sig)
        setPreview({ url, time: at, kind, signature: sig });
    });
  const exportProject = () =>
    run("내보내기 준비", async () => {
      if (!project) return;
      validate(project, "export");
      await bridge.save(project);
      setDirty(false);
      await refreshRecent();
      onDashboardChange();
      const result = await bridge.export(project);
      if (result) {
        setJob(result);
        setNotice("선택한 설정으로 내보내기를 시작했어요.");
      } else {
        setNotice("내보내기를 취소했어요. 편집 설정은 저장돼 있어요.");
      }
    });
  const seek = (value: number) => {
    if (!project) return;
    const next = clampedTime(value, project.source.duration);
    setTime(next);
    if (videoRef.current) videoRef.current.currentTime = next;
  };
  const addCue = () => {
    if (!project) return;
    const start = Math.min(time, Math.max(0, project.source.duration - 0.1));
    setCaptions("items", [
      ...project.settings.captions.items,
      {
        id: crypto.randomUUID(),
        start: Number(start.toFixed(2)),
        end: Number(Math.min(project.source.duration, start + 2).toFixed(2)),
        text: "",
      },
    ]);
  };
  if (readonly)
    return (
      <section className="desktop-notice">
        <div>
          <strong>영상 편집은 데스크톱에서 이어가요.</strong>
          <p>
            원본 불러오기, 자막 합성, 표지 생성은 내 Mac에서 실행돼요.
            모바일에서는 공유한 제작 현황을 확인할 수 있어요.
          </p>
        </div>
      </section>
    );
  return (
    <div className="editor-workspace">
      {error && (
        <div className="alert error" role="alert">
          <strong>편집 작업을 완료하지 못했어요.</strong>
          <span>{error}</span>
          <button
            className="quiet"
            aria-label="편집 오류 닫기"
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
          {busy} 중이에요.
        </div>
      )}
      <section className="editor-toolbar panel">
        <div>
          <span className="eyebrow">LOCAL EDITOR</span>
          <strong>
            {project?.source.name || "편집할 영상을 선택해주세요."}
          </strong>
          <span className="editor-runtime">
            {runtime?.message || "편집 환경을 확인하고 있어요."}
          </span>
        </div>
        <button
          className="primary"
          onClick={choose}
          disabled={!!busy || rendering || unavailable}
        >
          로컬 영상 열기
        </button>
      </section>
      {runtime && !runtime.available && (
        <div className="inline-warning" role="alert">
          편집 도구를 사용할 수 없어요. {runtime.message}
        </div>
      )}
      {recent.length > 0 && (
        <section className="editor-recents" aria-label="최근 편집">
          <span>최근 편집</span>
          {recent.map((item) => (
            <button
              key={item.id}
              className={project?.id === item.id ? "current" : ""}
              aria-label={`편집 기록 열기 ${item.name}`}
              disabled={!!busy || rendering}
              onClick={() => load(item.id)}
            >
              {item.name}
            </button>
          ))}
        </section>
      )}
      {!project ? (
        <section className="editor-start panel">
          <div className="editor-start-icon">▷</div>
          <h2>촬영한 장면에 이야기를 더해요.</h2>
          <p>
            로컬 영상을 열거나 촬영 보관함에서 ‘이 영상 편집’을 선택해주세요.
            <br />
            장소 안내 묶음과 본문 자막, 표지를 함께 만들 수 있어요.
          </p>
          <div className="editor-start-steps">
            <span>01 영상 선택</span>
            <span>02 문구와 배치</span>
            <span>03 미리보기와 출력</span>
          </div>
        </section>
      ) : (
        <>
          <div className="editor-meta">
            <span>
              {project.source.width} × {project.source.height}
            </span>
            <span>{formatSeconds(project.source.duration)}</span>
            <span>
              {project.source.hasAudio ? "원본 오디오 포함" : "오디오 없음"}
            </span>
            <span className={project.source.hdr ? "hdr-label" : ""}>
              {project.source.hdr ? "원본 HDR · 재생용 SDR 프록시" : "원본 SDR"}
            </span>
            <span className={dirty ? "unsaved-label" : "saved-label"}>
              {dirty ? "저장하지 않은 변경사항" : "설정 저장됨"}
            </span>
          </div>
          <div className="editor-layout">
            <div className="editor-preview-column">
              <section className="panel editor-player-panel">
                <div className="section-heading">
                  <h2>영상 확인</h2>
                  <span className="editor-badge">재생용 프록시</span>
                </div>
                <div className="editor-video-stage">
                  <video
                    ref={videoRef}
                    src={project.source.videoURL}
                    controls
                    preload="metadata"
                    playsInline
                    aria-label="편집 원본 재생"
                    onTimeUpdate={(e) =>
                      setTime(
                        clampedTime(
                          e.currentTarget.currentTime,
                          project.source.duration,
                        ),
                      )
                    }
                    onError={() =>
                      setMediaError(
                        "재생용 영상을 불러오지 못했어요. 편집 기록을 다시 열어주세요.",
                      )
                    }
                  />
                </div>
                {mediaError && <p className="inline-warning">{mediaError}</p>}
                <div className="editor-seek">
                  <input
                    aria-label="영상 탐색"
                    type="range"
                    min="0"
                    max={Math.max(0, project.source.duration - 0.01)}
                    step="0.01"
                    value={time}
                    onChange={(e) => seek(Number(e.target.value))}
                  />
                  <label>
                    현재 시점
                    <input
                      aria-label="현재 시점"
                      type="number"
                      min="0"
                      max={Math.max(0, project.source.duration - 0.01)}
                      step="0.01"
                      value={Number(time.toFixed(2))}
                      onChange={(e) => seek(Number(e.target.value))}
                    />
                  </label>
                  <span>
                    {formatSeconds(time)} /{" "}
                    {formatSeconds(project.source.duration)}
                  </span>
                </div>
                <p className="muted compact">
                  재생 화면에는 새 문구가 합성되지 않아요. 아래 합성 미리보기로
                  실제 배치를 확인해주세요.
                  {project.source.hdr ? " 내보내기는 HDR 원본을 사용해요." : ""}
                </p>
                <button
                  onClick={() => makePreview("video")}
                  disabled={!!busy || rendering || unavailable}
                >
                  영상 미리보기 만들기
                </button>
              </section>
              <section className="panel editor-authoritative-preview">
                <div className="section-heading">
                  <h2>
                    {preview?.kind === "cover"
                      ? "표지 합성 미리보기"
                      : "영상 합성 미리보기"}
                  </h2>
                  <span className="editor-badge">
                    {mode === "demo" ? "예시 이미지" : "출력 엔진 결과"}
                  </span>
                </div>
                {preview && preview.signature === signature(project) ? (
                  <>
                    <div className="editor-image-stage">
                      <img
                        src={preview.url}
                        alt={`${preview.kind === "cover" ? "표지" : "영상"} ${preview.time.toFixed(2)}초 합성 미리보기`}
                      />
                    </div>
                    <p className="muted compact">
                      {preview.time.toFixed(2)}초의{" "}
                      {preview.kind === "cover" ? "표지" : "영상"} 배치예요.
                      {mode === "demo"
                        ? " 예시 모드에서는 실제 엔진을 실행하지 않아요."
                        : ""}
                    </p>
                  </>
                ) : (
                  <div className="editor-preview-empty">
                    <span>▧</span>
                    <p>현재 설정의 합성 미리보기를 만들어주세요.</p>
                    <small>
                      설정이 바뀌면 이전 미리보기는 표시하지 않아요.
                    </small>
                  </div>
                )}
              </section>
            </div>
            <div className="editor-controls-column">
              <section className="panel">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">PLACE GUIDE</span>
                    <h2>장소 안내 묶음</h2>
                  </div>
                  <span className="editor-badge">핀 + 설명</span>
                </div>
                <label>
                  장소명
                  <input
                    value={project.settings.place.name}
                    onChange={(e) => setPlace("name", e.target.value)}
                    disabled={!!busy || rendering}
                    placeholder="예: 노게 호르몬센터"
                  />
                </label>
                <label>
                  장소 설명
                  <input
                    value={project.settings.place.description}
                    onChange={(e) => setPlace("description", e.target.value)}
                    disabled={!!busy || rendering}
                    placeholder="영상에 고정해서 보여줄 한 줄 설명"
                  />
                </label>
                <label>
                  설명 재질
                  <select
                    value={project.settings.place.material}
                    onChange={(e) =>
                      setPlace(
                        "material",
                        e.target.value as EditSettings["place"]["material"],
                      )
                    }
                    disabled={!!busy || rendering}
                  >
                    <option value="none">없음 · 장소 핀만</option>
                    <option value="tape">설명 테이프</option>
                    <option value="rectangle">검은 설명 바</option>
                  </select>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={project.settings.place.useDefaultPosition}
                    onChange={(e) =>
                      setPlace("useDefaultPosition", e.target.checked)
                    }
                    disabled={!!busy || rendering}
                  />
                  장소 안내 기본 배치 사용
                </label>
                <p className="muted compact">
                  장소 핀을 기준으로 설명 테이프가 함께 움직여요. 기본 배치는
                  기존 템플릿 기준을 그대로 사용해요.
                </p>
                <div className="form-grid">
                  <NumberField
                    label="장소 안내 가로 위치"
                    value={project.settings.place.x}
                    onChange={(v) => setPlace("x", v)}
                    disabled={
                      !!busy ||
                      rendering ||
                      project.settings.place.useDefaultPosition
                    }
                  />
                  <NumberField
                    label="장소 안내 세로 위치"
                    value={project.settings.place.y}
                    onChange={(v) => setPlace("y", v)}
                    disabled={
                      !!busy ||
                      rendering ||
                      project.settings.place.useDefaultPosition
                    }
                  />
                  <NumberField
                    label="장소 핀 크기"
                    value={project.settings.place.size}
                    min={0.005}
                    max={0.2}
                    step={0.001}
                    onChange={(v) => setPlace("size", v)}
                    disabled={!!busy || rendering}
                  />
                </div>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={project.settings.place.persistent}
                    onChange={(e) => setPlace("persistent", e.target.checked)}
                    disabled={!!busy || rendering}
                  />
                  핀은 계속 표시
                </label>
                <label>
                  장소 설명 표시 구간
                  <input
                    value={project.settings.place.showDuring}
                    onChange={(e) => setPlace("showDuring", e.target.value)}
                    disabled={!!busy || rendering}
                    placeholder="비워두면 전체 · 예: 0-4,10-end"
                  />
                </label>
                <p className="muted compact">
                  구간을 정하면 설명은 그때만 보여요. ‘핀은 계속 표시’를 끄면
                  핀도 같은 구간에 나타나요.
                </p>
              </section>
              <section className="panel">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">TIMED CAPTIONS</span>
                    <h2>영상 본문 자막</h2>
                  </div>
                  <button onClick={addCue} disabled={!!busy || rendering}>
                    자막 추가
                  </button>
                </div>
                <div className="form-grid">
                  <NumberField
                    label="본문 자막 크기"
                    value={project.settings.captions.fontSizeRatio}
                    min={0.005}
                    max={0.082}
                    step={0.001}
                    onChange={(v) => setCaptions("fontSizeRatio", v)}
                    disabled={!!busy || rendering}
                  />
                  <NumberField
                    label="본문 자막 세로 위치"
                    min={0.2}
                    max={0.79}
                    value={project.settings.captions.y}
                    onChange={(v) => setCaptions("y", v)}
                    disabled={!!busy || rendering}
                  />
                </div>
                {project.settings.captions.items.length === 0 ? (
                  <p className="editor-no-captions">
                    현재 시점에서 자막을 추가할 수 있어요. 원본에 이미 박힌
                    자막은 따로 유지돼요.
                  </p>
                ) : (
                  <div className="caption-cues">
                    {project.settings.captions.items.length > 1 && (
                      <button
                        className="quiet"
                        onClick={() =>
                          setCaptions(
                            "items",
                            [...project.settings.captions.items].sort(
                              (a, b) => a.start - b.start,
                            ),
                          )
                        }
                        disabled={!!busy || rendering}
                      >
                        자막 시간순 정렬
                      </button>
                    )}
                    {project.settings.captions.items.map((cue, index) => (
                      <div className="caption-cue" key={cue.id}>
                        <div className="caption-cue-heading">
                          <strong>자막 {index + 1}</strong>
                          <button
                            className="quiet"
                            aria-label={`자막 ${index + 1} 삭제`}
                            onClick={() =>
                              setCaptions(
                                "items",
                                project.settings.captions.items.filter(
                                  (c) => c.id !== cue.id,
                                ),
                              )
                            }
                            disabled={!!busy || rendering}
                          >
                            삭제
                          </button>
                        </div>
                        <div className="form-grid">
                          <NumberField
                            label={`자막 ${index + 1} 시작`}
                            value={cue.start}
                            min={0}
                            max={project.source.duration}
                            step={0.01}
                            onChange={(v) => updateCue(cue.id, { start: v })}
                            disabled={!!busy || rendering}
                          />
                          <NumberField
                            label={`자막 ${index + 1} 끝`}
                            value={cue.end}
                            min={0}
                            max={project.source.duration}
                            step={0.01}
                            onChange={(v) => updateCue(cue.id, { end: v })}
                            disabled={!!busy || rendering}
                          />
                        </div>
                        <label>
                          자막 {index + 1} 내용
                          <textarea
                            value={cue.text}
                            onChange={(e) =>
                              updateCue(cue.id, { text: e.target.value })
                            }
                            disabled={!!busy || rendering}
                            placeholder="자연스럽게 이어지는 문장으로 적어주세요."
                          />
                        </label>
                      </div>
                    ))}
                  </div>
                )}
              </section>
              <section className="panel">
                <div className="section-heading">
                  <div>
                    <span className="eyebrow">COVER</span>
                    <h2>표지 훅과 장소 핀</h2>
                  </div>
                  <button
                    className="quiet"
                    onClick={() => setCover("time", Number(time.toFixed(2)))}
                    disabled={!!busy || rendering}
                  >
                    현재 시점을 표지로
                  </button>
                </div>
                <NumberField
                  label="표지 시점"
                  value={project.settings.cover.time}
                  min={0}
                  max={Math.max(0, project.source.duration - 0.01)}
                  step={0.01}
                  onChange={(v) => setCover("time", v)}
                  disabled={!!busy || rendering}
                />
                <label>
                  표지 훅
                  <textarea
                    value={project.settings.cover.hook}
                    onChange={(e) => setCover("hook", e.target.value)}
                    disabled={!!busy || rendering}
                    placeholder={"첫 번째 줄\n두 번째 줄"}
                  />
                </label>
                <p className="muted compact">
                  표지 훅은 두 줄·왼쪽 정렬이에요. 아래 서명은 훅을 따라가고,
                  장소 핀의 가로 중앙 배치와는 별개예요.
                </p>
                <label>
                  표지 글자 크기 방식
                  <select
                    value={project.settings.cover.template}
                    onChange={(e) =>
                      setCover(
                        "template",
                        e.target.value as EditSettings["cover"]["template"],
                      )
                    }
                    disabled={!!busy || rendering}
                  >
                    <option value="rosy-auto">문구 폭에 맞춰 자동 조절</option>
                    <option value="rosy-large">큰 글자 185 기준</option>
                  </select>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={project.settings.cover.useDefaultPosition}
                    onChange={(e) =>
                      setCover("useDefaultPosition", e.target.checked)
                    }
                    disabled={!!busy || rendering}
                  />
                  표지 기본 배치 사용
                </label>
                <div className="form-grid">
                  <NumberField
                    label="표지 훅 가로 위치"
                    value={project.settings.cover.x}
                    onChange={(v) => setCover("x", v)}
                    disabled={
                      !!busy ||
                      rendering ||
                      project.settings.cover.useDefaultPosition
                    }
                  />
                  <NumberField
                    label="표지 훅 세로 위치"
                    value={project.settings.cover.y}
                    onChange={(v) => setCover("y", v)}
                    disabled={
                      !!busy ||
                      rendering ||
                      project.settings.cover.useDefaultPosition
                    }
                  />
                  <NumberField
                    label="표지 장소 핀 가로 위치"
                    value={project.settings.cover.placeX}
                    onChange={(v) => setCover("placeX", v)}
                    disabled={
                      !!busy ||
                      rendering ||
                      project.settings.cover.useDefaultPosition
                    }
                  />
                  <NumberField
                    label="표지 장소 핀 세로 위치"
                    value={project.settings.cover.placeY}
                    onChange={(v) => setCover("placeY", v)}
                    disabled={
                      !!busy ||
                      rendering ||
                      project.settings.cover.useDefaultPosition
                    }
                  />
                </div>
                <div className="button-row">
                  <button
                    onClick={() => makePreview("cover")}
                    disabled={!!busy || rendering || unavailable}
                  >
                    표지 미리보기 만들기
                  </button>
                </div>
              </section>
            </div>
          </div>
          <section className="panel editor-export">
            <div>
              <h2>편집 설정과 결과 저장</h2>
              <p>
                새 영상과 표지를 별도 파일로 만들어요. 촬영 원본은 변경하지
                않아요.
              </p>
            </div>
            <div className="button-row">
              <button onClick={save} disabled={!!busy || rendering}>
                편집 설정 저장
              </button>
              <button
                className="primary"
                onClick={exportProject}
                disabled={!!busy || rendering || unavailable}
              >
                영상과 표지 내보내기
              </button>
            </div>
          </section>
        </>
      )}
      {job && (
        <section
          className={`panel editor-render-job job-${job.state}`}
          aria-label="영상 내보내기 작업"
        >
          <div className="section-heading">
            <h2>
              {job.state === "completed"
                ? "내보내기 완료"
                : job.state === "cancelled"
                  ? "내보내기 취소됨"
                  : job.state === "failed"
                    ? "내보내기 실패"
                    : "영상을 만들고 있어요"}
            </h2>
            <span>{Math.round(job.progress)}%</span>
          </div>
          <progress
            aria-label="영상 내보내기 진행률"
            value={job.progress}
            max="100"
          />
          <p>{job.phase}</p>
          {job.error && <p className="inline-warning">{job.error}</p>}
          {job.outputPath && (
            <p className="file-path">영상 · {job.outputPath}</p>
          )}
          {job.coverPath && <p className="file-path">표지 · {job.coverPath}</p>}
          {job.state === "running" && (
            <button
              onClick={() =>
                run("내보내기 취소", async () => {
                  await bridge.cancel(job.id);
                  setJob(await bridge.job(job.id));
                })
              }
              disabled={!!busy}
            >
              내보내기 취소
            </button>
          )}
          {job.state === "completed" && (
            <button
              onClick={() =>
                run("결과 폴더 열기", async () => {
                  await bridge.reveal(job.id);
                  if (mode === "demo")
                    setNotice(
                      "예시 모드에서는 실제 결과 파일을 만들지 않아요.",
                    );
                })
              }
              disabled={!!busy}
            >
              결과 폴더 열기
            </button>
          )}
        </section>
      )}
    </div>
  );
}
function NumberField({
  label,
  value,
  onChange,
  disabled,
  min = 0,
  max = 1,
  step = 0.01,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) =>
          onChange(e.target.value === "" ? NaN : Number(e.target.value))
        }
        disabled={disabled}
      />
    </label>
  );
}
