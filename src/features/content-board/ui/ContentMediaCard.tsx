import { useEffect, useRef, useState } from "react";
import {
  projectStageLabels as stages,
  projectStages,
  type DashboardBridge,
  type Project,
} from "../../../shared/contracts";
import type {
  ContentDocumentText,
  ContentMediaItem,
  ContentMediaPage,
} from "../../../shared/content-media";
import { resourceLabels } from "../../../shared/content-media";
import {
  openingVideoStatus,
  playbackCopyStatus,
  useContentPlayback,
} from "../../../shared/ui/useContentPlayback";
import { DocumentViewer } from "./DocumentViewer";
import "./content-board.css";
const labels = {
  video: "영상",
  image: "사진",
  audio: "오디오",
  folder: "폴더",
  document: "문서",
  archive: "묶음 파일",
};
const errorText = (e: unknown) =>
  e instanceof Error
    ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")
    : "자료를 불러오지 못했어요.";
export function StageProgress({ project }: { project: Project }) {
  const keys = projectStages;
  return (
    <div
      className="board-stage-progress"
      aria-label={`현재 진행: ${stages[project.stage]}`}
    >
      {keys.map((stage, i) => (
        <span
          key={stage}
          title={stages[stage]}
          className={i <= keys.indexOf(project.stage) ? "reached" : ""}
          aria-current={stage === project.stage ? "step" : undefined}
        />
      ))}
      <small>{stages[project.stage]}</small>
    </div>
  );
}
export function ContentMediaCard({
  project,
  bridge,
}: {
  project: Project;
  bridge: DashboardBridge;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [page, setPage] = useState<ContentMediaPage>();
  const [error, setError] = useState("");
  const [opened, setOpened] = useState(false);
  const opener = useRef<HTMLElement | null>(null);
  const [initial, setInitial] = useState<ContentMediaItem>();
  const [folderItems, setFolderItems] = useState<ContentMediaItem[]>([]);
  const enabled =
    bridge.mode !== "web" &&
    !!bridge.contentMedia &&
    !!project.resources?.length;
  useEffect(() => {
    if (!ref.current || !enabled) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "150px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [enabled]);
  useEffect(() => {
    if (!visible || !enabled) return;
    let live = true;
    bridge
      .contentMedia!.list(project.id)
      .then((value) => {
        if (live) setPage(value);
        if (
          !value.items.some(
            (i) => i.available && ["video", "image"].includes(i.kind),
          )
        ) {
          const folder = value.items.find(
            (i) => i.available && i.kind === "folder",
          );
          if (folder)
            void bridge
              .contentMedia!.list(project.id, folder.path)
              .then((children) => {
                if (live) setFolderItems(children.items);
              })
              .catch(() => {});
        }
      })
      .catch((e) => {
        if (live) setError(errorText(e));
      });
    return () => {
      live = false;
    };
  }, [visible, enabled, bridge, project.id, project.resources, project.outbound?.generation]);
  const allVisual =
    [...(page?.items ?? []), ...folderItems].filter(
      (i) => i.available && ["video", "image"].includes(i.kind),
    ) ?? [];
  const outboundPaths = new Set(project.outbound?.files.map(f => `${project.outbound!.directory}/${f.name}`.normalize("NFC")) ?? []);
  const visual = project.outbound?.generation
    ? allVisual.filter(item => outboundPaths.has(item.path.normalize("NFC")))
    : allVisual;
  const representative =
    visual.find((i) => i.role === "cover") ??
    visual.find((i) => i.role === "final") ??
    visual[0];
  return (
    <div ref={ref} className="board-media-card">
      <button
        type="button"
        className="board-poster"
        disabled={!enabled}
        onClick={(e) => {
          opener.current = e.currentTarget;
          setInitial(representative);
          setOpened(true);
        }}
        aria-label={`${project.title} 미디어 보기`}
      >
        {representative ? (
          <Thumbnail
            key={project.outbound?.generation}
            item={representative}
            projectId={project.id}
            bridge={bridge}
          />
        ) : (
          <span className="board-poster-empty">
            {enabled
              ? "연결 자료 보기"
              : bridge.mode === "web"
                ? "미디어는 데스크톱에서 확인"
                : "미디어 연결 전"}
          </span>
        )}
        {enabled && (
          <span className="board-view-label ui-hover-reveal" aria-hidden="true">
            미디어 보기
          </span>
        )}
      </button>
      {enabled && (
        <div className="board-media-strip">
          {visual.slice(0, 3).map((item) => (
            <button
              key={item.path + item.role + (project.outbound?.generation ?? 0)}
              aria-label={`${item.label} 미리보기`}
              onClick={(e) => {
                opener.current = e.currentTarget;
                setInitial(item);
                setOpened(true);
              }}
            >
              <Thumbnail item={item} projectId={project.id} bridge={bridge} />
            </button>
          ))}
          <button
            className="board-media-count small"
            title="연결 자료 목록과 재생"
            onClick={(e) => {
              opener.current = e.currentTarget;
              setInitial(undefined);
              setOpened(true);
            }}
          >
            자료 {page?.total ?? project.resources?.length}개
          </button>
        </div>
      )}
      {error && (
        <p className="board-media-error">
          목록을 불러오지 못했어요. 미디어 보기에서 다시 확인해주세요.
        </p>
      )}
      {opened && (
        <MediaExplorer
          key={project.outbound?.generation}
          project={project}
          bridge={bridge}
          initial={initial}
          onClose={() => {
            setOpened(false);
            requestAnimationFrame(() => opener.current?.focus());
          }}
        />
      )}
    </div>
  );
}
function Thumbnail({
  item,
  projectId,
  bridge,
}: {
  item: ContentMediaItem;
  projectId: string;
  bridge: DashboardBridge;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let live = true;
    if (item.available && ["image", "video"].includes(item.kind))
      void bridge
        .contentMedia!.thumbnail(projectId, item.path)
        .then((v) => {
          if (live) setUrl(v);
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [bridge, projectId, item.path, item.available, item.kind]);
  if (url) return <img src={url} alt={`${item.label} 썸네일`} loading="lazy" />;
  if (item.available && item.kind === "folder")
    return (
      <span className="board-thumbnail-placeholder folder" aria-hidden="true">
        <FolderIcon />
      </span>
    );
  if (item.available && item.kind === "document")
    return (
      <span className="board-thumbnail-placeholder document" aria-hidden="true">
        <DocumentIcon />
        <b>{extensionLabel(item.path)}</b>
      </span>
    );
  return (
    <span className="board-thumbnail-placeholder">
      {item.available ? labels[item.kind] : "파일 없음"}
    </span>
  );
}
function MediaExplorer({
  project,
  bridge,
  initial,
  onClose,
}: {
  project: Project;
  bridge: DashboardBridge;
  onClose: () => void;
  initial?: ContentMediaItem;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [folders, setFolders] = useState<ContentMediaItem[]>([]);
  const [page, setPage] = useState<ContentMediaPage>();
  const [selected, setSelected] = useState<ContentMediaItem>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [role, setRole] = useState("all");
  const [retry, setRetry] = useState(0);
  const folder = folders.at(-1)?.path;
  useEffect(() => {
    dialog.current?.showModal();
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = old;
    };
  }, []);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError("");
    setPage(undefined);
    setSelected(folder ? undefined : initial);
    setRole("all");
    bridge
      .contentMedia!.list(project.id, folder)
      .then((value) => {
        if (live) setPage(value);
      })
      .catch((e) => {
        if (live) setError(errorText(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [bridge, project.id, folder, retry]);
  async function more() {
    if (!page || page.nextOffset === null || loading) return;
    setLoading(true);
    setError("");
    try {
      const next = await bridge.contentMedia!.list(
        project.id,
        folder,
        page.nextOffset,
      );
      setPage({ ...next, items: [...page.items, ...next.items] });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="board-media-dialog"
      aria-label={`${project.title} 자료와 진행사항`}
      onCancel={onClose}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialog.current) onClose();
      }}
    >
      <header>
        <div>
          <h2>{project.title}</h2>
          <p>다음 할 일 · {project.nextAction || "아직 정하지 않았어요."}</p>
        </div>
        <button
          autoFocus
          className="icon-button"
          onClick={onClose}
          aria-label="미디어 닫기"
          title="닫기 (Esc)"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M6 6l12 12 M18 6L6 18" />
          </svg>
        </button>
      </header>
      <StageProgress project={project} />
      <div className="board-explorer-layout">
        <section className="board-player" aria-label="선택한 미디어">
          {selected ? (
            <MediaPlayer
              key={selected.path}
              item={selected}
              projectId={project.id}
              bridge={bridge}
            />
          ) : (
            <div className="board-player-empty">
              <p>목록에서 영상·사진·문서를 선택해주세요.</p>
            </div>
          )}
        </section>
        <section className="board-file-browser" aria-label="미디어 목록">
          <nav aria-label="자료 폴더 위치">
            <button
              className="small"
              disabled={!folders.length || loading}
              onClick={() => setFolders([])}
            >
              연결 자료
            </button>
            {folders.map((f, i) => (
              <button
                key={f.path}
                className="small"
                disabled={loading}
                onClick={() => setFolders(folders.slice(0, i + 1))}
              >
                / {f.label}
              </button>
            ))}
          </nav>
          <div className="board-list-toolbar">
            <strong>{page ? `${page.total}개 자료` : "자료 확인 중"}</strong>
            <label>
              자료 종류
              <select
                className="ui-inline"
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                <option value="all">전체</option>
                {Object.entries(resourceLabels).map(([v, label]) => (
                  <option value={v} key={v}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error && (
            <p role="alert">
              {error}{" "}
              <button onClick={() => setRetry((v) => v + 1)}>
                다시 불러오기
              </button>
            </p>
          )}
          {loading && <p role="status">자료를 불러오고 있어요.</p>}
          {page && page.items.length === 0 && (
            <p>이 폴더에는 표시할 자료가 없어요.</p>
          )}
          <div className="board-file-grid">
            {page?.items
              .filter((i) => role === "all" || i.role === role)
              // Folders lead the grid so the tree reads like a file browser.
              .sort((a, b) => Number(b.kind === "folder") - Number(a.kind === "folder"))
              .map((item) => (
                <button
                  key={item.path + item.role}
                  className={[
                    item.kind === "folder" ? "folder" : "",
                    selected?.path === item.path ? "selected" : "",
                  ].join(" ").trim() || undefined}
                  aria-pressed={selected?.path === item.path}
                  disabled={!item.available || loading}
                  onClick={() =>
                    item.kind === "folder"
                      ? setFolders([...folders, item])
                      : setSelected(item)
                  }
                  aria-label={`${item.label} ${item.kind === "folder" ? "폴더 열기" : "보기"}`}
                >
                  <Thumbnail
                    item={item}
                    projectId={project.id}
                    bridge={bridge}
                  />
                  <strong>
                    {item.label}
                    {item.kind === "folder" && <span aria-hidden="true">/</span>}
                  </strong>
                  <small>
                    {item.kind === "folder"
                      ? `${item.role === "folder" ? "" : `${resourceLabels[item.role]} · `}폴더 · 열기 ›`
                      : `${resourceLabels[item.role]} · ${labels[item.kind]}`}
                    {!item.available ? " · 파일 없음" : ""}
                  </small>
                </button>
              ))}
          </div>
          {page &&
            role !== "all" &&
            !page.items.some((i) => i.role === role) && (
              <p>불러온 목록에 이 종류의 자료가 없어요.</p>
            )}
          {page?.nextOffset != null && (
            <button disabled={loading} onClick={more}>
              자료 더 보기 ({page.items.length}/{page.total})
            </button>
          )}
        </section>
      </div>
    </dialog>
  );
}
function MediaPlayer({
  item,
  projectId,
  bridge,
}: {
  item: ContentMediaItem;
  projectId: string;
  bridge: DashboardBridge;
}) {
  const supported = ["image", "video", "audio"].includes(item.kind);
  const readable = item.kind === "document";
  const {
    media,
    error: mediaError,
    preparingCopy,
    playbackFailed,
    retry: retryMedia,
  } = useContentPlayback(bridge.contentMedia, projectId, item.path, supported);
  const url = media?.url ?? "";
  const videoFailed = () =>
    playbackFailed(
      media?.playback === "copy"
        ? "재생용 사본도 재생하지 못했어요. 파일 상태를 확인해주세요."
        : "영상을 재생하지 못했어요. 파일 상태를 확인해주세요.",
    );
  const [doc, setDoc] = useState<ContentDocumentText>();
  const [docError, setDocError] = useState("");
  const [docRetry, setDocRetry] = useState(0);
  useEffect(() => {
    let live = true;
    setDoc(undefined);
    setDocError("");
    if (readable)
      void bridge
        .contentMedia!.text(projectId, item.path)
        .then((v) => {
          if (live) setDoc(v);
        })
        .catch((e) => {
          if (live) setDocError(errorText(e));
        });
    return () => {
      live = false;
    };
  }, [bridge, projectId, item.path, readable, docRetry]);
  const error = readable ? docError : mediaError;
  const retry = readable ? () => setDocRetry((v) => v + 1) : retryMedia;
  return (
    <>
      <div
        className={`board-player-stage${readable && doc && !error ? " document" : ""}`}
      >
        {error ? (
          <p role="alert">
            {error}
            <button onClick={retry}>다시 준비</button>
          </p>
        ) : readable ? (
          doc ? (
            <DocumentViewer
              item={item}
              doc={doc}
              projectId={projectId}
              bridge={bridge}
            />
          ) : (
            <p role="status">문서를 불러오고 있어요.</p>
          )
        ) : !supported ? (
          <p>묶음 파일은 연결 자료의 ‘위치 열기’로 확인해주세요.</p>
        ) : !url ? (
          <p role="status">
            {item.kind !== "video"
              ? "미디어를 불러오고 있어요."
              : preparingCopy
                ? playbackCopyStatus
                : openingVideoStatus}
          </p>
        ) : item.kind === "image" ? (
          <img src={url} alt={item.label} />
        ) : item.kind === "video" ? (
          <video
            key={url}
            src={url}
            controls
            playsInline
            preload="metadata"
            aria-label={`${item.label} 재생`}
            onError={videoFailed}
            // Audio plays on without an error when only the video codec is
            // unsupported; no frame dimensions means the video cannot be shown.
            onLoadedMetadata={(e) => {
              if (!e.currentTarget.videoWidth) videoFailed();
            }}
          />
        ) : (
          <audio
            src={url}
            controls
            aria-label={`${item.label} 재생`}
            onError={() => playbackFailed("오디오를 재생하지 못했어요.")}
          />
        )}
      </div>
      <h3>{item.label}</h3>
      <p>
        {resourceLabels[item.role]} · {labels[item.kind]}
      </p>
      {item.kind === "video" && media?.playback && (
        <small>
          {media.playback === "copy"
            ? "재생용 사본으로 재생해요. 원본은 그대로 유지돼요."
            : "원본 파일을 그대로 재생해요."}
        </small>
      )}
      {doc?.truncated && (
        <small>문서가 길어 앞부분만 표시했어요. 전체는 ‘위치 열기’로 확인해주세요.</small>
      )}
    </>
  );
}
const extensionLabel = (file: string) =>
  (file.split("/").at(-1)?.split(".").at(-1) ?? "").slice(0, 4).toUpperCase();
function FolderIcon() {
  return (
    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.1l2 2.2h8.9A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z" fill="currentColor" fillOpacity="0.14" />
      <path d="M3 10h18" />
    </svg>
  );
}
function DocumentIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round">
      <path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
      <path d="M14 3v4h4 M8.5 12h7 M8.5 15.5h7" />
    </svg>
  );
}
