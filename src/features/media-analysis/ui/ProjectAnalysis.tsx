import { MosaicReview } from "./MosaicReview";
import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import type { DashboardBridge, Project } from "../../../shared/contracts";
import {
  analysisContext,
  type AnalysisContext,
  type AnalysisView,
} from "../../../shared/media-analysis";
export function ProjectAnalysis({
  project,
  bridge,
}: {
  project: Project;
  bridge: DashboardBridge;
}) {
  const [open, setOpen] = useState(false);
  return bridge.analysis ? (
    <>
      <button onClick={() => setOpen(!open)}>사진·영상 메타데이터 분석</button>
      {open &&
        createPortal(
          <AnalysisDialog
            project={project}
            bridge={bridge}
            close={() => setOpen(false)}
          />,
          document.body,
        )}
    </>
  ) : null;
}
function AnalysisDialog({
  project,
  bridge,
  close,
}: {
  project: Project;
  bridge: DashboardBridge;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={`${project.title} 메타데이터 분석`}
      style={{
        width: "min(1000px,92vw)",
        maxHeight: "88vh",
        overflow: "auto",
        padding: 24,
        borderRadius: 16,
        border: "1px solid #8886",
      }}
      onCancel={close}
      onClose={close}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h2>{project.title} · 메타데이터 분석</h2>
        <button autoFocus onClick={close}>
          닫기
        </button>
      </header>
      <Panel project={project} bridge={bridge} />
    </dialog>
  );
}
function Panel({
  project,
  bridge,
}: {
  project: Project;
  bridge: DashboardBridge;
}) {
  const folders = project.resources?.filter((r) => r.role === "folder") ?? [];
  const [folder, setFolder] = useState(
    folders.find((r) => r.path.endsWith("/originals"))?.path ??
      folders[0]?.path ??
      "",
  );
  const [providers, setProviders] = useState<{ id: string; label: string }[]>(
    [],
  );
  const [provider, setProvider] = useState("codex"),
    [query, setQuery] = useState("");
  const [data, setData] = useState<AnalysisView>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string>(),
    [description, setDescription] = useState("");
  const [mosaic, setMosaic] = useState<string>();
  const [context, setContext] = useState<AnalysisContext>();
  const contextLoaded = useRef(false);
  const contextBaseline = useRef("");
  const contextRevision = useRef<number | undefined>(undefined);
  const api = bridge.analysis!;
  useEffect(() => {
    let live = true;
    api
      .providers()
      .then((p) => {
        if (live) setProviders(p);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [api]);
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .search({ projectId: project.id, query })
        .then((d) => {
          if (live) {
            setData(d);
            if (!contextLoaded.current) {
              setContext(d.context ?? analysisContext.parse({}));
              contextLoaded.current = true;
              contextBaseline.current = JSON.stringify(
                d.context ?? analysisContext.parse({}),
              );
              contextRevision.current = d.revision;
            }
            if (
              JSON.stringify(d.context ?? analysisContext.parse({})) ===
              contextBaseline.current
            )
              contextRevision.current = d.revision;
          }
        })
        .catch((e) => {
          if (live) setError(String(e));
        });
    void load();
    const timer = setInterval(load, 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, project.id, query]);
  const run = data?.runs.at(-1),
    running = run?.status === "running";
  return (
    <section
      aria-label="프로젝트 메타데이터"
      style={{
        padding: 16,
        border: "1px solid #8886",
        borderRadius: 12,
        marginTop: 12,
      }}
    >
      <p>
        사진과 영상의 대표 프레임을 분석해요. 영상은 시작·중간·후반만 확인하며
        동작과 음성은 분석하지 않아요. 선택한 이미지가 분석기로 전송되며 로그인
        계정의 사용량이 적용돼요.
      </p>
      <label>
        분석 폴더{" "}
        <select value={folder} onChange={(e) => setFolder(e.target.value)}>
          {folders.map((r) => (
            <option key={r.path} value={r.path}>
              {r.label} · {r.path.split("/").at(-1)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {" "}
        분석기{" "}
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <details>
        <summary>분석에 함께 전달할 가게·메뉴·방문 정보</summary>
        <p>
          확인한 정보와 출처를 넣어주세요. 다음 분석에도 재사용하며, 화면 관찰과
          기록 근거를 구분해 저장해요.
        </p>
        {(
          [
            ["venue", "가게·지점"],
            ["location", "위치·주변 지역"],
            ["visit", "방문·촬영 날짜와 그날의 상황"],
            ["menus", "주문 메뉴·정확한 이름·곁들임"],
            ["surroundings", "매장·주변 공간"],
            ["notes", "파일별 설명·추가 맥락"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <textarea
              aria-label={label}
              value={context?.[key] ?? ""}
              disabled={busy || running}
              onChange={(e) =>
                setContext((c) => ({
                  ...analysisContext.parse({}),
                  ...c,
                  [key]: e.target.value,
                }))
              }
            />
          </label>
        ))}
        <label>
          정보 출처
          <textarea
            aria-label="정보 출처"
            value={context?.sources.join("\n") ?? ""}
            disabled={busy || running}
            onChange={(e) =>
              setContext((c) => ({
                ...analysisContext.parse({}),
                ...c,
                sources: e.target.value.split("\n").filter(Boolean),
              }))
            }
          />
        </label>
      </details>
      <button
        disabled={busy || running || !folder || !data || !context}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await api.start({
              projectId: project.id,
              folder,
              provider,
              context,
              expectedRevision: contextRevision.current,
            });
            const next = await api.search({ projectId: project.id, query });
            contextBaseline.current = JSON.stringify(
              next.context ?? analysisContext.parse({}),
            );
            contextRevision.current = next.revision;
            setData(next);
          } catch (e) {
            setError(String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        폴더 분석 시작
      </button>
      {run && (
        <p role="status">
          {
            {
              running: "분석 중",
              completed: "완료",
              partial: "일부 실패",
              failed: "실패",
              interrupted: "중단됨",
            }[run.status]
          }{" "}
          · 원본 {run.processedFiles}/{run.totalFiles}개 · 이미지{" "}
          {run.analyzedSamples}개
        </p>
      )}
      {run?.errors.map((e, i) => (
        <p key={i} role="alert">
          {e.sourcePath.split("/").at(-1)}: {e.message}
        </p>
      ))}
      {error && <p role="alert">{error}</p>}
      <label>
        설명·태그·OCR 검색{" "}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="맥주, 야외 테이블, 간판…"
        />
      </label>
      <p>{data?.matches.length ?? 0}개 결과</p>
      <div style={{ maxHeight: 500, overflow: "auto" }}>
        {data?.matches.map((r) => (
          <article
            key={r.sample.id}
            style={{ padding: "12px 0", borderTop: "1px solid #8884" }}
          >
            <strong>
              {r.sample.sourcePath.split("/").at(-1)}
              {r.sample.time !== null
                ? ` · ${r.sample.time.toFixed(2)}초`
                : " · 사진"}
            </strong>
            <p>{r.effective.description}</p>
            {r.fields.faceRegions && (
              <div><p>얼굴 후보 {r.fields.faceRegions.length}개 · 자동 탐지는 누락될 수 있어요. 모자이크 전 모든 영역을 직접 확인해주세요.</p>
              <button onClick={() => setMosaic(mosaic === r.sample.id ? undefined : r.sample.id)}>얼굴 모자이크 검토</button>
              {mosaic === r.sample.id && <MosaicReview key={r.sample.id} api={api} projectId={project.id} sampleId={r.sample.id} candidates={r.fields.faceRegions} frame={r.sample.kind === "video-frame"} />}</div>
            )}
            {!!r.effective.contextNotes?.length && (
              <p>기록 근거: {r.effective.contextNotes.join(" / ")}</p>
            )}
            <p>{r.effective.tags.join(" · ")}</p>
            {r.effective.ocr.length > 0 && (
              <p>화면 글자 후보: {r.effective.ocr.join(" / ")}</p>
            )}
            {r.effective.uncertainties.length > 0 && (
              <p>확인 필요: {r.effective.uncertainties.join(" / ")}</p>
            )}
            <small>
              {r.provider} ·{" "}
              {data.corrections[r.sample.id] ? "사람 수정 적용" : "모델 분석"}
            </small>
            <button
              onClick={() => {
                setEditing(r.sample.id);
                setDescription(r.effective.description);
              }}
            >
              설명 수정
            </button>
            {editing === r.sample.id && (
              <div>
                <textarea
                  aria-label="수정 설명"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
                <button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.correct({
                        projectId: project.id,
                        sampleId: r.sample.id,
                        expectedRevision: data.revision,
                        fields: { description },
                      });
                      setData(
                        await api.search({ projectId: project.id, query }),
                      );
                      setEditing(undefined);
                    } catch (e) {
                      setError(String(e));
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  수정 저장
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
