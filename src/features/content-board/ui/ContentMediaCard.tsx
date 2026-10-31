import { useEffect, useRef, useState } from "react";
import type { DashboardBridge, Project } from "../../../shared/contracts";
import type {
  ContentMediaItem,
  ContentMediaPage,
} from "../../../shared/content-media";
import { resourceLabels } from "../../../shared/content-media";
import "./content-board.css";
const stages = {
  idea: "아이디어",
  captured: "촬영 완료",
  selected: "촬영본 선택",
  editing: "편집 중",
  review: "검토 대기",
  published: "게시 완료",
};
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
  const keys = Object.keys(stages) as (keyof typeof stages)[];
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
  index,
}: {
  project: Project;
  bridge: DashboardBridge;
  index: number;
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
  }, [visible, enabled, bridge, project.id]);
  const visual =
    [...(page?.items ?? []), ...folderItems].filter(
      (i) => i.available && ["video", "image"].includes(i.kind),
    ) ?? [];
  const representative =
    visual.find((i) => i.role === "cover") ??
    visual.find((i) => i.role === "final") ??
    visual[0];
  return (
    <div ref={ref} className="board-media-card">
      <button
        type="button"
        className={`board-poster art-${index % 4}`}
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
            item={representative}
            projectId={project.id}
            bridge={bridge}
          />
        ) : (
          <span className="board-poster-empty">
            {enabled
              ? "▧ 연결 자료 보기"
              : bridge.mode === "web"
                ? "미디어는 데스크톱에서 확인"
                : "미디어 연결 전"}
          </span>
        )}
        <span className={`stage-tag stage-${project.stage}`}>
          {stages[project.stage]}
        </span>
        {enabled && <span className="board-view-label">미디어 보기 ↗</span>}
      </button>
      {enabled && (
        <div className="board-media-strip">
          {visual.slice(0, 3).map((item) => (
            <button
              key={item.path + item.role}
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
            className="board-media-count"
            onClick={(e) => {
              opener.current = e.currentTarget;
              setInitial(undefined);
              setOpened(true);
            }}
          >
            연결 자료 {page?.total ?? project.resources?.length}개{" "}
            <span>목록과 재생 →</span>
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
  return url ? (
    <img src={url} alt={`${item.label} 썸네일`} loading="lazy" />
  ) : (
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
          <span className="eyebrow">CONTENTS · {stages[project.stage]}</span>
          <h2>{project.title}</h2>
          <p>다음 할 일 · {project.nextAction || "아직 정하지 않았어요."}</p>
        </div>
        <button autoFocus onClick={onClose} aria-label="미디어 닫기">
          닫기 ×
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
              <span>▷</span>
              <p>목록에서 영상이나 사진을 선택해주세요.</p>
              <small>촬영 폴더를 열어 안의 미디어도 확인할 수 있어요.</small>
            </div>
          )}
        </section>
        <section className="board-file-browser" aria-label="미디어 목록">
          <nav aria-label="자료 폴더 위치">
            <button
              disabled={!folders.length || loading}
              onClick={() => setFolders([])}
            >
              연결 자료
            </button>
            {folders.map((f, i) => (
              <button
                key={f.path}
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
              <select value={role} onChange={(e) => setRole(e.target.value)}>
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
            <p>이 폴더에는 표시할 미디어가 없어요.</p>
          )}
          <div className="board-file-grid">
            {page?.items
              .filter((i) => role === "all" || i.role === role)
              .map((item) => (
                <button
                  key={item.path + item.role}
                  className={selected?.path === item.path ? "selected" : ""}
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
                  <strong>{item.label}</strong>
                  <small>
                    {resourceLabels[item.role]} · {labels[item.kind]}
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
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const supported = ["image", "video", "audio"].includes(item.kind);
  useEffect(() => {
    let live = true;
    setUrl("");
    setError("");
    if (supported)
      void bridge
        .contentMedia!.open(projectId, item.path)
        .then((v) => {
          if (live) setUrl(v.url);
        })
        .catch((e) => {
          if (live) setError(errorText(e));
        });
    return () => {
      live = false;
    };
  }, [bridge, projectId, item.path, supported, retry]);
  return (
    <>
      <div className="board-player-stage">
        {error ? (
          <p role="alert">
            {error}
            <button onClick={() => setRetry((v) => v + 1)}>다시 준비</button>
          </p>
        ) : !supported ? (
          <p>문서·묶음 파일은 연결 자료의 ‘위치 열기’로 확인해주세요.</p>
        ) : !url ? (
          <p role="status">
            {item.kind === "video"
              ? "재생용 영상을 준비하고 있어요. 긴 영상은 시간이 걸릴 수 있어요."
              : "미디어를 불러오고 있어요."}
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
            onError={() =>
              setError("영상을 재생하지 못했어요. 파일 상태를 확인해주세요.")
            }
          />
        ) : (
          <audio
            src={url}
            controls
            aria-label={`${item.label} 재생`}
            onError={() => setError("오디오를 재생하지 못했어요.")}
          />
        )}
      </div>
      <h3>{item.label}</h3>
      <p>
        {resourceLabels[item.role]} · {labels[item.kind]}
      </p>
      {item.kind === "video" && (
        <small>재생용 사본을 사용해요. 원본은 그대로 유지돼요.</small>
      )}
    </>
  );
}
