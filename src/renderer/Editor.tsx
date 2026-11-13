import { errorMessage } from "../shared/lib/errors";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { DashboardBridge } from "../shared/contracts";
import type {
  AgentUiBridge,
  CaptionCue,
  EditSettings,
  EditorBridge,
  EditorProject,
  EditorSummary,
  RenderJob,
} from "../shared/editor";
import { followCoverDefaults } from "../shared/editor";
import "./editor.css";
import { TemplatePanel } from "../features/editor-templates";
import { CaptionFileTools } from "../features/subtitle-files";
import {
  selectCoverTemplate,
} from "../shared/editor-model";
import {
  Button,
  ChevronDownIcon,
  CloseIcon,
  EmptyState,
  IconButton,
  Notice,
  PlusIcon,
  StatusText,
} from "../shared/ui/primitives";
import { Menu } from "../shared/ui/Popover";
import { Icon } from "./ui";
import {
  clampedTime,
  formatSeconds,
  signature,
  validate,
} from "./editor/format";
import { EditorSection, NumberField, NumberInput } from "./editor/EditorFields";

type EditorProps = {
  bridge: EditorBridge;
  agent?: AgentUiBridge;
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
const recentDate = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString("ko-KR", { month: "long", day: "numeric" });
};

export function Editor({
  bridge,
  agent,
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
  const [conflict, setConflict] = useState(false);
  const [time, setTime] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [job, setJob] = useState<RenderJob | null>(null);
  const [mediaError, setMediaError] = useState("");
  // Original-first playback: `project.source.videoURL` streams the source file.
  // After a load/decode error the editor asks once for a playback copy.
  const [playback, setPlayback] = useState<{
    id: string;
    mode: "preparing" | "copy" | "failed";
    url: string;
  } | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
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
  useEffect(() => {
    void agent
      ?.reportContext({
        projectId: project?.id ?? null,
        dirty,
        time,
        active,
        busy: Boolean(busy) || Boolean(rendering),
      })
      .catch((e) => setError(errorMessage(e)));
  }, [agent, project?.id, dirty, time, active, busy, rendering]);
  useEffect(() => {
    if (!agent) return;
    const changed = agent.onProjectChanged((next) => {
      void refreshRecent().catch((e) => setError(errorMessage(e)));
      onDashboardChange();
      if (projectRef.current?.id !== next.id) return;
      if (dirtyRef.current && !busyRef.current) {
        setConflict(true);
        setNotice(
          "다른 연결에서 설정이 바뀌었어요. 현재 편집은 보존했으며 저장 전 다시 열어 확인해주세요.",
        );
        return;
      }
      setProject(next);
      setPreview(null);
    });
    const started = agent.onRenderStarted((next) => {
      setJob(next);
      setNotice("내보내기를 시작했어요.");
    });
    return () => {
      changed();
      started();
    };
  }, [agent, bridge]);
  async function run(name: string, operation: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(name);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (e) {
      if (errorMessage(e).includes("STALE_PROJECT")) setConflict(true);
      setError(errorMessage(e));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }
  async function adopt(next: EditorProject) {
    if (projectRef.current && dirtyRef.current) {
      const saved = await bridge.save(projectRef.current);
      if (saved.id === next.id) next = saved;
    }
    videoRef.current?.pause();
    setProject(next);
    setPlayback(null);
    setDirty(false);
    setConflict(false);
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
        if (live) setError(errorMessage(e));
      });
    void bridge
      .list()
      .then((value) => {
        if (live) setRecent(value);
      })
      .catch((e) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [active, bridge, readonly]);
  useEffect(() => {
    if (
      !incoming ||
      incomingRef.current === `${incoming.id}:${incoming.updatedAt}` ||
      busy ||
      rendering
    )
      return;
    incomingRef.current = `${incoming.id}:${incoming.updatedAt}`;
    void run("Photos 영상 준비", () => adopt(incoming));
  }, [incoming, busy, rendering]);
  useEffect(() => {
    onRenderingChange(Boolean(rendering));
  }, [rendering, onRenderingChange]);
  useEffect(() => {
    if (active) return;
    videoRef.current?.pause();
  }, [active]);
  // 미리보기 열의 sticky 위치가 상단 바 높이(줄바꿈 포함)를 따라가게 한다.
  useEffect(() => {
    const header = headerRef.current;
    const workspace = workspaceRef.current;
    if (!header || !workspace || typeof ResizeObserver === "undefined") return;
    const sync = () =>
      workspace.style.setProperty(
        "--editor-header-height",
        `${header.offsetHeight}px`,
      );
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(header);
    return () => observer.disconnect();
  }, [readonly]);
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
              : next.outputPath?.endsWith(".png")
                ? "카드 이미지 내보내기가 완료됐어요."
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
            `진행 상태를 확인하지 못했어요. 다시 확인하고 있어요. ${errorMessage(e)}`,
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
  const currentPlayback =
    playback && project && playback.id === project.id ? playback : null;
  const playbackMode = currentPlayback?.mode ?? "original";
  const playbackURL = currentPlayback
    ? currentPlayback.url
    : (project?.source.videoURL ?? "");
  async function playbackFailed() {
    const id = project?.id;
    if (!id || playbackMode === "preparing") return;
    if (playbackMode !== "original" || !bridge.playbackCopy || readonly) {
      setMediaError(
        playbackMode === "copy"
          ? "재생용 사본도 재생하지 못했어요. 편집 기록을 다시 열어주세요."
          : "영상을 재생하지 못했어요. 편집 기록을 다시 열어주세요.",
      );
      return;
    }
    setMediaError("");
    setPlayback({ id, mode: "preparing", url: "" });
    try {
      const url = await bridge.playbackCopy(id);
      if (projectRef.current?.id === id) setPlayback({ id, mode: "copy", url });
    } catch (e) {
      if (projectRef.current?.id !== id) return;
      setPlayback({ id, mode: "failed", url: "" });
      setMediaError(errorMessage(e));
    }
  }
  const choose = () =>
    run("로컬 영상 준비", async () => {
      const next = await bridge.chooseVideo();
      if (next) await adopt(next);
    });
  const load = (id: string) =>
    run("편집 기록 열기", async () => {
      await adopt(await bridge.load(id));
    });
  const save = () =>
    run("편집 설정 저장", async () => {
      if (!project) return;
      const saved = await bridge.save(project);
      setProject(saved);
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
  const exportProject = (target: "both" | "cover" = "both") =>
    run("내보내기 준비", async () => {
      if (!project) return;
      validate(project, target === "cover" ? "cover" : "export");
      const saved = await bridge.save(project);
      setProject(saved);
      setDirty(false);
      await refreshRecent();
      onDashboardChange();
      const result = await bridge.export(saved, target);
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
  const locked = !!busy || rendering;
  const follow = project?.settings.cover.template === "rosy-follow";
  const coverExportLabel = follow
    ? "마지막 장 PNG 내보내기"
    : "표지 PNG 내보내기";
  const previewReady =
    !!project && !!preview && preview.signature === signature(project);
  const frameStyle = project
    ? ({
        "--editor-aspect": `${project.source.width || 9} / ${project.source.height || 16}`,
      } as CSSProperties)
    : undefined;
  return (
    <div className="editor-workspace" ref={workspaceRef}>
      <header
        ref={headerRef}
        className="editor-header ui-toolbar"
        data-divided=""
      >
        <div className="editor-title">
          <h2 title={project?.source.name}>
            {project?.source.name || "영상 편집"}
          </h2>
          <p className="ui-meta editor-meta" title={runtime?.message}>
            {project ? (
              <>
                <span>
                  {project.source.width} × {project.source.height}
                </span>
                <span>{formatSeconds(project.source.duration)}</span>
                <span>
                  {project.source.hasAudio ? "원본 오디오 포함" : "오디오 없음"}
                </span>
                <span>
                  {project.source.hdr
                    ? playbackMode === "copy"
                      ? "원본 HDR · 재생용 SDR 사본"
                      : "원본 HDR 그대로 재생"
                    : playbackMode === "copy"
                      ? "원본 SDR · 재생용 사본"
                      : "원본 SDR"}
                </span>
              </>
            ) : (
              <span>{runtime?.message || "편집 환경을 확인하고 있어요."}</span>
            )}
          </p>
        </div>
        {(busy || project) && (
          <StatusText
            live={!!busy}
            busy={!!busy}
            className="editor-save-state"
            title={
              !busy && dirty
                ? "편집 설정을 저장하면 다음에 이어서 열 수 있어요."
                : undefined
            }
          >
            {busy
              ? `${busy} 중…`
              : dirty
                ? "저장하지 않은 변경사항"
                : "저장됨"}
          </StatusText>
        )}
        {project && (
          <div className="editor-header-actions">
            <Button
              onClick={choose}
              disabled={locked || unavailable}
              aria-label="로컬 영상 열기"
              title="로컬 영상 열기"
            >
              열기
            </Button>
            {recent.length > 0 && (
              <Menu
                label="최근 편집"
                trigger={<ChevronDownIcon />}
                triggerClassName="icon-button"
                triggerProps={{ disabled: locked }}
                items={recent.map((item) => ({
                  label: item.name,
                  title: `편집 기록 열기 ${item.name}`,
                  checked: item.id === project.id,
                  disabled: locked,
                  onSelect: () => void load(item.id),
                }))}
              />
            )}
            <Button
              onClick={save}
              disabled={locked}
              aria-label="편집 설정 저장"
              title="편집 설정 저장 · 원본 영상은 그대로 있어요."
            >
              저장
            </Button>
            <Menu
              label="결과 내보내기"
              trigger={
                <>
                  내보내기
                  <ChevronDownIcon />
                </>
              }
              triggerClassName="primary editor-export-trigger"
              triggerProps={{
                disabled: locked || unavailable,
                title:
                  "새 영상과 표지를 별도 파일로 만들어요. 촬영 원본은 변경하지 않아요.",
              }}
              items={[
                {
                  label: "영상과 표지 내보내기",
                  disabled: locked || unavailable,
                  onSelect: () => void exportProject(),
                },
                {
                  label: coverExportLabel,
                  disabled: locked || unavailable,
                  onSelect: () => void exportProject("cover"),
                },
              ]}
            />
          </div>
        )}
      </header>
      {error && (
        <div className="ui-notice editor-alert" data-tone="danger" role="alert">
          <span>
            <strong>편집 작업을 완료하지 못했어요.</strong> {error}
          </span>
          <IconButton
            label="편집 오류 닫기"
            size="small"
            onClick={() => setError("")}
          >
            <CloseIcon />
          </IconButton>
        </div>
      )}
      {runtime && !runtime.available && (
        <p className="ui-notice editor-alert" data-tone="warning" role="alert">
          편집 도구를 사용할 수 없어요. {runtime.message}
        </p>
      )}
      {conflict && project && (
        <div className="ui-notice editor-alert" data-tone="warning" role="alert">
          <span>저장된 설정이 바뀌었어요. 현재 입력은 그대로 남아 있어요.</span>
          <Button
            size="small"
            variant="secondary"
            disabled={locked}
            onClick={() =>
              void run("저장본 다시 열기", async () => {
                const latest = await bridge.load(project.id);
                setProject(latest);
                setDirty(false);
                setConflict(false);
                setPreview(null);
              })
            }
          >
            내 변경을 버리고 저장본 열기
          </Button>
        </div>
      )}
      {notice && (
        <p className="ui-notice editor-alert" role="status">
          {notice}
        </p>
      )}
      {job && (
        <section
          className="editor-job"
          data-state={job.state}
          aria-label="영상 내보내기 작업"
        >
          <div className="editor-job-line">
            <h2>
              {job.state === "completed"
                ? "내보내기 완료"
                : job.state === "cancelled"
                  ? "내보내기 취소됨"
                  : job.state === "failed"
                    ? "내보내기 실패"
                    : "영상을 만들고 있어요"}
            </h2>
            <span className="ui-meta">{Math.round(job.progress)}%</span>
            {job.phase && (
              <span className="ui-meta ui-truncate editor-job-phase">
                {job.phase}
              </span>
            )}
            <span className="ui-spacer" aria-hidden="true" />
            {job.state === "running" && (
              <Button
                size="small"
                onClick={() =>
                  run("내보내기 취소", async () => {
                    await bridge.cancel(job.id);
                    setJob(await bridge.job(job.id));
                  })
                }
                disabled={!!busy}
              >
                내보내기 취소
              </Button>
            )}
            {job.state === "completed" && (
              <Button
                size="small"
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
              </Button>
            )}
          </div>
          <progress
            aria-label="영상 내보내기 진행률"
            value={job.progress}
            max="100"
          />
          {job.outputPath && (
            <p className="file-path">영상 · {job.outputPath}</p>
          )}
          {job.coverPath && <p className="file-path">표지 · {job.coverPath}</p>}
        </section>
      )}
      {!project ? (
        <>
          <EmptyState
            className="editor-empty"
            title="편집할 영상을 열어주세요"
            description="촬영 보관함에서 ‘이 영상 편집’을 골라도 돼요."
            actions={
              <Button
                variant="primary"
                onClick={choose}
                disabled={locked || unavailable}
              >
                로컬 영상 열기
              </Button>
            }
          />
          {recent.length > 0 && (
            <section className="editor-recents" aria-label="최근 편집">
              <h3 className="ui-meta">최근 편집</h3>
              <ul className="ui-list" data-divided="">
                {recent.map((item) => (
                  <li key={item.id}>
                    <button
                      className="ui-row"
                      aria-label={`편집 기록 열기 ${item.name}`}
                      disabled={locked}
                      onClick={() => load(item.id)}
                    >
                      <span className="ui-row-icon" aria-hidden="true">
                        <Icon name="editor" />
                      </span>
                      <span className="ui-row-title">{item.name}</span>
                      <span className="ui-row-meta">
                        {recentDate(item.updatedAt)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      ) : (
        <div className="editor-layout">
          <div className="editor-preview-column">
            <div
              className="editor-frames"
              data-orientation={
                project.source.width > project.source.height
                  ? "landscape"
                  : undefined
              }
              style={frameStyle}
            >
              <figure className="editor-frame">
                <div className="editor-frame-media">
                  {playbackMode === "preparing" ? (
                    <p className="editor-preview-empty" role="status">
                      원본을 바로 재생하지 못해 재생용 사본을 준비하고 있어요.
                    </p>
                  ) : (
                    <video
                      ref={videoRef}
                      key={playbackURL || "none"}
                      src={playbackURL || undefined}
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
                      onLoadedMetadata={(e) => {
                        // Chromium keeps playing the audio of a file whose video
                        // codec it cannot decode and reports no error, so a video
                        // without frame dimensions also counts as a failure.
                        if (!e.currentTarget.videoWidth) {
                          void playbackFailed();
                          return;
                        }
                        // Resume where the original stopped once the copy is loaded.
                        if (playbackMode === "copy" && time > 0)
                          e.currentTarget.currentTime = time;
                      }}
                      onError={() => void playbackFailed()}
                    />
                  )}
                </div>
                <figcaption
                  className="ui-meta"
                  title="재생 화면에는 새 문구가 합성되지 않아요. 합성 미리보기로 실제 배치를 확인해주세요."
                >
                  {playbackMode === "copy" ? "재생용 사본" : "원본"}
                  {project.source.hdr ? " · 내보내기는 HDR 원본을 사용해요." : ""}
                </figcaption>
              </figure>
              <figure className="editor-frame">
                <div className="editor-frame-media">
                  {previewReady && preview ? (
                    <img
                      src={preview.url}
                      alt={`${preview.kind === "cover" ? "표지" : "영상"} ${preview.time.toFixed(2)}초 합성 미리보기`}
                    />
                  ) : (
                    <p
                      className="editor-preview-empty"
                      title="설정이 바뀌면 이전 미리보기는 표시하지 않아요."
                    >
                      현재 설정의 합성 미리보기를 만들어주세요.
                    </p>
                  )}
                </div>
                <figcaption
                  className="ui-meta"
                  title={
                    mode === "demo"
                      ? "예시 모드에서는 실제 엔진을 실행하지 않아요."
                      : "출력 엔진으로 만든 결과예요."
                  }
                >
                  {previewReady && preview
                    ? `${preview.time.toFixed(2)}초 ${preview.kind === "cover" ? "표지" : "영상"} 합성`
                    : "합성 미리보기"}
                </figcaption>
              </figure>
            </div>
            {mediaError && <Notice tone="warning">{mediaError}</Notice>}
            <input
              className="editor-seek-range"
              aria-label="영상 탐색"
              type="range"
              min="0"
              max={Math.max(0, project.source.duration - 0.01)}
              step="0.01"
              value={time}
              onChange={(e) => seek(Number(e.target.value))}
            />
            <div className="editor-seek">
              <input
                className="ui-narrow"
                aria-label="현재 시점"
                title="현재 시점(초)"
                type="number"
                min="0"
                max={Math.max(0, project.source.duration - 0.01)}
                step="0.01"
                value={Number(time.toFixed(2))}
                onChange={(e) => seek(Number(e.target.value))}
              />
              <span className="ui-meta">
                {formatSeconds(time)} / {formatSeconds(project.source.duration)}
              </span>
              <span className="ui-spacer" aria-hidden="true" />
              <Button
                variant="secondary"
                onClick={() => makePreview("video")}
                disabled={locked || unavailable}
              >
                영상 미리보기 만들기
              </Button>
            </div>
          </div>
          <div className="editor-controls-column">
            <TemplatePanel
              settings={project.settings}
              disabled={locked}
              onChange={changeSettings}
            />
            <EditorSection id="editor-place" title="장소 안내 묶음">
              <div className="editor-fields">
                <label>
                  장소명
                  <input
                    value={project.settings.place.name}
                    onChange={(e) => setPlace("name", e.target.value)}
                    disabled={locked}
                    placeholder="예: 노게 호르몬센터"
                  />
                </label>
                <label>
                  장소 설명
                  <input
                    value={project.settings.place.description}
                    onChange={(e) => setPlace("description", e.target.value)}
                    disabled={locked}
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
                    disabled={locked}
                  >
                    <option value="none">없음 · 장소 핀만</option>
                    <option value="tape">설명 테이프</option>
                    <option value="rectangle">검은 설명 바</option>
                  </select>
                </label>
                <label title="구간을 정하면 설명은 그때만 보여요. ‘핀은 계속 표시’를 끄면 핀도 같은 구간에 나타나요.">
                  장소 설명 표시 구간
                  <input
                    value={project.settings.place.showDuring}
                    onChange={(e) => setPlace("showDuring", e.target.value)}
                    disabled={locked}
                    placeholder="비워두면 전체 · 예: 0-4,10-end"
                  />
                </label>
              </div>
              <div className="editor-checks">
                <label
                  className="ui-check"
                  title="장소 핀을 기준으로 설명 테이프가 함께 움직여요. 기본 배치는 기존 템플릿 기준을 그대로 사용해요."
                >
                  <input
                    type="checkbox"
                    checked={project.settings.place.useDefaultPosition}
                    onChange={(e) =>
                      setPlace("useDefaultPosition", e.target.checked)
                    }
                    disabled={locked}
                  />
                  장소 안내 기본 배치 사용
                </label>
                <label className="ui-check">
                  <input
                    type="checkbox"
                    checked={project.settings.place.persistent}
                    onChange={(e) => setPlace("persistent", e.target.checked)}
                    disabled={locked}
                  />
                  핀은 계속 표시
                </label>
              </div>
              <div className="editor-numbers">
                <NumberField
                  label="장소 안내 가로 위치"
                  short="가로"
                  value={project.settings.place.x}
                  onChange={(v) => setPlace("x", v)}
                  disabled={
                    locked || project.settings.place.useDefaultPosition
                  }
                />
                <NumberField
                  label="장소 안내 세로 위치"
                  short="세로"
                  value={project.settings.place.y}
                  onChange={(v) => setPlace("y", v)}
                  disabled={
                    locked || project.settings.place.useDefaultPosition
                  }
                />
                <NumberField
                  label="장소 핀 크기"
                  short="핀 크기"
                  value={project.settings.place.size}
                  min={0.005}
                  max={0.2}
                  step={0.001}
                  onChange={(v) => setPlace("size", v)}
                  disabled={locked}
                />
              </div>
            </EditorSection>
            <EditorSection
              id="editor-captions"
              title="본문 자막"
              actions={
                <>
                  {project.settings.captions.items.length > 1 && (
                    <Button
                      size="small"
                      onClick={() =>
                        setCaptions(
                          "items",
                          [...project.settings.captions.items].sort(
                            (a, b) => a.start - b.start,
                          ),
                        )
                      }
                      disabled={locked}
                    >
                      자막 시간순 정렬
                    </Button>
                  )}
                  <Button size="small" onClick={addCue} disabled={locked}>
                    <PlusIcon />
                    자막 추가
                  </Button>
                </>
              }
            >
              <CaptionFileTools
                key={project.id}
                cues={project.settings.captions.items}
                duration={project.source.duration}
                sourceName={project.source.name}
                contextKey={`${project.id}:${project.updatedAt}:${signature(project)}`}
                disabled={locked}
                onReplace={(items) => setCaptions("items", items)}
              />
              <div className="editor-numbers">
                <NumberField
                  label="본문 자막 크기"
                  short="글자 크기"
                  value={project.settings.captions.fontSizeRatio}
                  min={0.005}
                  max={0.082}
                  step={0.001}
                  onChange={(v) => setCaptions("fontSizeRatio", v)}
                  disabled={locked}
                />
                <NumberField
                  label="본문 자막 세로 위치"
                  short="세로 위치"
                  min={0.2}
                  max={0.79}
                  value={project.settings.captions.y}
                  onChange={(v) => setCaptions("y", v)}
                  disabled={locked}
                />
              </div>
              {project.settings.captions.items.length === 0 ? (
                <p
                  className="ui-meta editor-no-captions"
                  title="원본에 이미 박힌 자막은 따로 유지돼요."
                >
                  자막이 없어요. 현재 시점에서 추가할 수 있어요.
                </p>
              ) : (
                <ol className="caption-cues">
                  {project.settings.captions.items.map((cue, index) => (
                    <li className="caption-cue ui-hover-host" key={cue.id}>
                      <span className="caption-cue-index" aria-hidden="true">
                        {index + 1}
                      </span>
                      <span className="caption-cue-times">
                        <NumberInput
                          label={`자막 ${index + 1} 시작`}
                          value={cue.start}
                          min={0}
                          max={project.source.duration}
                          step={0.01}
                          onChange={(v) => updateCue(cue.id, { start: v })}
                          disabled={locked}
                        />
                        <span aria-hidden="true">–</span>
                        <NumberInput
                          label={`자막 ${index + 1} 끝`}
                          value={cue.end}
                          min={0}
                          max={project.source.duration}
                          step={0.01}
                          onChange={(v) => updateCue(cue.id, { end: v })}
                          disabled={locked}
                        />
                      </span>
                      <textarea
                        aria-label={`자막 ${index + 1} 내용`}
                        rows={2}
                        value={cue.text}
                        onChange={(e) =>
                          updateCue(cue.id, { text: e.target.value })
                        }
                        disabled={locked}
                        placeholder="자연스럽게 이어지는 문장으로 적어주세요."
                      />
                      <IconButton
                        label={`자막 ${index + 1} 삭제`}
                        size="small"
                        className="ui-hover-reveal"
                        onClick={() =>
                          setCaptions(
                            "items",
                            project.settings.captions.items.filter(
                              (c) => c.id !== cue.id,
                            ),
                          )
                        }
                        disabled={locked}
                      >
                        <CloseIcon />
                      </IconButton>
                    </li>
                  ))}
                </ol>
              )}
            </EditorSection>
            <EditorSection
              id="editor-cover"
              title={follow ? "팔로우 마지막 장" : "표지 훅과 장소 핀"}
              actions={
                <Button
                  size="small"
                  onClick={() => setCover("time", Number(time.toFixed(2)))}
                  disabled={locked}
                >
                  현재 시점을 표지로
                </Button>
              }
            >
              <div className="editor-fields">
                <label>
                  표지 글자 크기 방식
                  <select
                    value={project.settings.cover.template}
                    onChange={(e) =>
                      changeSettings((s) =>
                        selectCoverTemplate(
                          s,
                          e.target.value as EditSettings["cover"]["template"],
                        ),
                      )
                    }
                    disabled={locked}
                  >
                    <option value="rosy-auto">문구 폭에 맞춰 자동 조절</option>
                    <option value="rosy-large">큰 글자 185 기준</option>
                    <option value="rosy-follow">
                      서명 있는 팔로우 마지막 장
                    </option>
                  </select>
                </label>
                <NumberField
                  label="표지 시점"
                  value={project.settings.cover.time}
                  min={0}
                  max={Math.max(0, project.source.duration - 0.01)}
                  step={0.01}
                  onChange={(v) => setCover("time", v)}
                  disabled={locked}
                />
                <label
                  className="editor-field-wide"
                  title={
                    follow
                      ? "두 줄 안내와 팔로우 문구 아래에 분홍 서명을 배치해요. 선택한 프레임을 9:16 PNG로 저장하며 영상 뒤에 자동으로 붙이지 않아요."
                      : "표지 훅은 두 줄·왼쪽 정렬이에요. 아래 서명은 훅을 따라가고, 장소 핀의 가로 중앙 배치와는 별개예요."
                  }
                >
                  {follow ? "마지막 장 안내 문구 (두 줄)" : "표지 훅"}
                  <textarea
                    rows={2}
                    value={project.settings.cover.hook}
                    onChange={(e) => setCover("hook", e.target.value)}
                    disabled={locked}
                    placeholder={"첫 번째 줄\n두 번째 줄"}
                  />
                </label>
              </div>
              {follow && (
                <fieldset disabled={locked} className="follow-cover-fields">
                  <legend>팔로우 문구와 서명</legend>
                  <div className="editor-fields">
                    <label>
                      팔로우 문구
                      <input
                        value={
                          project.settings.cover.followCta ??
                          followCoverDefaults.cta
                        }
                        maxLength={100}
                        onChange={(e) => setCover("followCta", e.target.value)}
                      />
                    </label>
                    <label>
                      서명 (영문 계정명)
                      <input
                        value={
                          project.settings.cover.followSignature ??
                          followCoverDefaults.signature
                        }
                        maxLength={80}
                        onChange={(e) =>
                          setCover("followSignature", e.target.value)
                        }
                      />
                    </label>
                  </div>
                  <div className="editor-numbers">
                    <NumberField
                      label="마지막 장 배경 어둡기 (%)"
                      min={0}
                      max={85}
                      step={1}
                      value={Math.round(
                        (project.settings.cover.followDarkness ??
                          followCoverDefaults.darkness) * 100,
                      )}
                      onChange={(v) => setCover("followDarkness", v / 100)}
                      disabled={locked}
                    />
                  </div>
                </fieldset>
              )}
              <div className="editor-checks">
                <label className="ui-check">
                  <input
                    type="checkbox"
                    checked={project.settings.cover.useDefaultPosition}
                    onChange={(e) =>
                      setCover("useDefaultPosition", e.target.checked)
                    }
                    disabled={locked}
                  />
                  표지 기본 배치 사용
                </label>
              </div>
              <div className="editor-numbers">
                <NumberField
                  label="표지 훅 가로 위치"
                  short="훅 가로"
                  value={project.settings.cover.x}
                  onChange={(v) => setCover("x", v)}
                  disabled={
                    locked || project.settings.cover.useDefaultPosition
                  }
                />
                <NumberField
                  label="표지 훅 세로 위치"
                  short="훅 세로"
                  value={project.settings.cover.y}
                  onChange={(v) => setCover("y", v)}
                  disabled={
                    locked || project.settings.cover.useDefaultPosition
                  }
                />
                <NumberField
                  label="표지 장소 핀 가로 위치"
                  short="핀 가로"
                  value={project.settings.cover.placeX}
                  onChange={(v) => setCover("placeX", v)}
                  disabled={
                    locked ||
                    project.settings.cover.useDefaultPosition ||
                    follow
                  }
                />
                <NumberField
                  label="표지 장소 핀 세로 위치"
                  short="핀 세로"
                  value={project.settings.cover.placeY}
                  onChange={(v) => setCover("placeY", v)}
                  disabled={
                    locked ||
                    project.settings.cover.useDefaultPosition ||
                    follow
                  }
                />
              </div>
              <div className="editor-section-actions">
                <Button
                  variant="secondary"
                  onClick={() => makePreview("cover")}
                  disabled={locked || unavailable}
                >
                  {follow ? "마지막 장 미리보기 만들기" : "표지 미리보기 만들기"}
                </Button>
              </div>
            </EditorSection>
          </div>
        </div>
      )}
    </div>
  );
}
