import { MosaicReview } from "./MosaicReview";
import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import type { DashboardBridge, Project } from "../../../shared/contracts";
import {
  analysisContext,
  type AnalysisContext,
  type AnalysisView,
} from "../../../shared/media-analysis";
import { Button, Dialog, Notice, StatusText } from "../../../shared/ui/primitives";
import "./media-analysis.css";
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
          <Dialog
            open
            onClose={() => setOpen(false)}
            // 입력 중인 맥락을 잃지 않도록 바깥 클릭으로는 닫지 않는다(Esc·닫기만).
            closeOnBackdrop={false}
            className="media-analysis-dialog"
            aria-label={`${project.title} 메타데이터 분석`}
            title={`${project.title} · 메타데이터 분석`}
          >
            <Panel project={project} bridge={bridge} />
          </Dialog>,
          document.body,
        )}
    </>
  ) : null;
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
    <section aria-label="프로젝트 메타데이터" className="media-analysis">
      <div
        className="media-analysis-toolbar"
        title="사진과 영상의 대표 프레임을 분석해요. 영상은 시작·중간·후반만 확인하며 동작과 음성은 분석하지 않아요. 선택한 이미지가 분석기로 전송되며 로그인 계정의 사용량이 적용돼요."
      >
        <label>
          분석 폴더
          <select
            className="ui-inline"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
          >
            {folders.map((r) => (
              <option key={r.path} value={r.path}>
                {r.label} · {r.path.split("/").at(-1)}
              </option>
            ))}
          </select>
        </label>
        <label>
          분석기
          <select
            className="ui-inline"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="primary"
          size="large"
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
        </Button>
      </div>
      <p className="ui-meta media-analysis-note">
        대표 프레임만 분석하고 선택한 이미지는 분석기로 전송돼요.
      </p>
      <details className="media-analysis-context">
        <summary>분석에 함께 전달할 가게·메뉴·방문 정보</summary>
        <p className="ui-meta">
          확인한 정보와 출처를 넣어주세요. 다음 분석에도 재사용해요.
        </p>
        <div className="media-analysis-context-grid">
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
                rows={2}
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
              rows={2}
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
        </div>
      </details>
      {run && (
        <StatusText live busy={running} className="media-analysis-status">
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
        </StatusText>
      )}
      {run?.errors.map((e, i) => (
        <Notice key={i} tone="warning" role="alert">
          {e.sourcePath.split("/").at(-1)}: {e.message}
        </Notice>
      ))}
      {error && <Notice tone="danger">{error}</Notice>}
      <div className="media-analysis-search">
        <label>
          설명·태그·OCR 검색
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="맥주, 야외 테이블, 간판…"
          />
        </label>
        <p className="ui-meta">{data?.matches.length ?? 0}개 결과</p>
      </div>
      <div className="media-analysis-results">
        {data?.matches.map((r) => (
          <article key={r.sample.id} className="media-analysis-result ui-hover-host">
            <header>
              <strong>
                {r.sample.sourcePath.split("/").at(-1)}
                {r.sample.time !== null
                  ? ` · ${r.sample.time.toFixed(2)}초`
                  : " · 사진"}
              </strong>
              <span className="media-analysis-result-actions ui-hover-reveal">
                {r.fields.faceRegions && (
                  <Button
                    size="small"
                    aria-expanded={mosaic === r.sample.id}
                    onClick={() =>
                      setMosaic(mosaic === r.sample.id ? undefined : r.sample.id)
                    }
                  >
                    얼굴 모자이크 검토
                  </Button>
                )}
                <Button
                  size="small"
                  onClick={() => {
                    setEditing(r.sample.id);
                    setDescription(r.effective.description);
                  }}
                >
                  설명 수정
                </Button>
              </span>
            </header>
            <p className="media-analysis-description">
              {r.effective.description}
            </p>
            <div className="media-analysis-meta">
              {!!r.effective.contextNotes?.length && (
                <p>기록 근거: {r.effective.contextNotes.join(" / ")}</p>
              )}
              {r.effective.tags.length > 0 && (
                <p>{r.effective.tags.join(" · ")}</p>
              )}
              {r.effective.ocr.length > 0 && (
                <p>화면 글자 후보: {r.effective.ocr.join(" / ")}</p>
              )}
              {r.effective.uncertainties.length > 0 && (
                <p>확인 필요: {r.effective.uncertainties.join(" / ")}</p>
              )}
              {r.fields.faceRegions && (
                <p>
                  얼굴 후보 {r.fields.faceRegions.length}개 · 자동 탐지는 누락될
                  수 있어요. 모자이크 전 모든 영역을 직접 확인해주세요.
                </p>
              )}
              <p>
                {r.provider} ·{" "}
                {data.corrections[r.sample.id] ? "사람 수정 적용" : "모델 분석"}
              </p>
            </div>
            {mosaic === r.sample.id && r.fields.faceRegions && (
              <MosaicReview
                key={r.sample.id}
                api={api}
                projectId={project.id}
                sampleId={r.sample.id}
                candidates={r.fields.faceRegions}
                frame={r.sample.kind === "video-frame"}
              />
            )}
            {editing === r.sample.id && (
              <div className="media-analysis-edit">
                <textarea
                  aria-label="수정 설명"
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
                <div className="media-analysis-edit-actions">
                  <Button onClick={() => setEditing(undefined)}>취소</Button>
                  <Button
                    variant="secondary"
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
                  </Button>
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
