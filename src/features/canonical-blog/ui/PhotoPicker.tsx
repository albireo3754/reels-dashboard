import { useEffect, useMemo, useRef, useState } from "react";
import { CloseIcon } from "../../../shared/ui/primitives";
import { errorMessage } from "../../../shared/lib/errors";
import { stickerKey, type StickerAnchor } from "../../../shared/blog-stickers";
import { PHOTO_ALT_LIMIT, defaultAlt, evidenceImageUrl, evidenceThumbnailUrl, searchEvidence, type EvidenceImage, type EvidenceLibrary, type PhotoInsert } from "../../../shared/blog-evidence";

const PAGE = 60;
const when = (item: EvidenceImage) => item.time === null ? "사진" : Number(item.time).toFixed(1) + "초";

/** Non-modal so the writer can click the manuscript to choose the position while it stays open. */
export function PhotoPicker({ revision, placements, anchors, target, disabled, onTarget, onChange, onReveal, onClose }: {
  revision: string; placements: PhotoInsert[]; anchors: StickerAnchor[]; target: string; disabled: boolean;
  onTarget: (key: string) => void; onChange: (items: PhotoInsert[]) => void; onReveal: (id: string) => void; onClose: () => void;
}) {
  const [library, setLibrary] = useState<EvidenceLibrary>();
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [capture, setCapture] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [picked, setPicked] = useState<EvidenceImage>();
  const [alt, setAlt] = useState("");
  const search = useRef<HTMLInputElement>(null);
  // The search box appears once the library arrives.
  const ready = !!library?.connected;
  useEffect(() => { if (ready) search.current?.focus(); }, [ready]);
  // The revision changes after a save, which is when "already in the manuscript" can change.
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    fetch("/api/blog/evidence", { signal: controller.signal })
      .then(async r => { const value = await r.json(); if (!r.ok) throw new Error(value.error ?? "분석 결과를 읽지 못했어요."); setLibrary(value); })
      .catch(e => { if (!controller.signal.aborted) setError(errorMessage(e)); });
    return () => controller.abort();
  }, [revision]);
  const items = library?.items ?? [];
  const captures = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item.captureId, (counts.get(item.captureId) ?? 0) + 1);
    return [...counts];
  }, [items]);
  const found = useMemo(() => searchEvidence(items, query, capture), [items, query, capture]);
  useEffect(() => setLimit(PAGE), [query, capture]);
  const used = useMemo(() => new Set([...(library?.usedIds ?? []), ...placements.map(p => p.imageId)]), [library, placements]);
  const anchor = anchors.find(a => stickerKey(a) === target) ?? anchors.find(a => a.label.includes("문단 ·")) ?? anchors[0];
  const label = (p: Pick<PhotoInsert, "bundleId" | "before">) => anchors.find(a => stickerKey(a) === stickerKey(p))?.label ?? "위치 확인 필요";
  function pick(item: EvidenceImage) { setPicked(item); setAlt(defaultAlt(item.description)); }
  function insert() {
    if (!picked || !anchor) return;
    onChange([...placements, { id: crypto.randomUUID(), imageId: picked.id, bundleId: anchor.bundleId, before: anchor.before, alt: alt.trim() }]);
    setPicked(undefined);
  }
  return <section id="ce-photo-picker" className="ce-photo-picker" aria-label="사진 고르기" onKeyDown={e => { if (e.key === "Escape") { e.stopPropagation(); if (picked) setPicked(undefined); else onClose(); } }}>
    <header className="ce-photo-head">
      <div><h2>사진 고르기</h2><p className="ui-meta" role="status">{library?.connected ? `${items.length}장 중 ${found.length}장${library.unresolved ? ` · 분석 안 된 ${library.unresolved}장 제외` : ""}` : "분석 결과를 불러오는 중"}</p></div>
      <button className="icon-button" aria-label="사진 고르기 닫기" title="사진 고르기 닫기" onClick={onClose}><CloseIcon /></button>
    </header>
    {error && <p className="ce-photo-note is-error" role="alert">{error}</p>}
    {library && !library.connected && <p className="ce-photo-note">이 프로젝트에는 사진 분석 결과가 연결되지 않았어요. 검증된 <code>results.json</code>을 <code>reviews/media-evidence.json</code> 포인터(또는 원고 frontmatter <code>editor.mediaEvidence</code>)로 연결하면 여기서 고를 수 있어요.</p>}
    {library?.connected && <>
      <div className="ce-photo-filters">
        <input ref={search} type="search" aria-label="사진 검색" placeholder="장면·태그·간판 글자로 찾기" value={query} onChange={e => setQuery(e.target.value)} />
        <select aria-label="촬영물" value={capture} onChange={e => setCapture(e.target.value)}>
          <option value="">촬영물 전체</option>
          {captures.map(([id, count]) => <option key={id} value={id}>{id} ({count})</option>)}
        </select>
      </div>
      {picked ? <div className="ce-photo-detail">
        <button className="small ce-photo-back" onClick={() => setPicked(undefined)}>← 목록으로</button>
        <img src={evidenceImageUrl(picked.id)} alt={picked.description} />
        <p className="ce-photo-meta">{picked.captureId} · {when(picked)} · <code>{picked.id}</code></p>
        {picked.faceCount > 0 && <p className="ce-photo-note" role="status">얼굴 후보 {picked.faceCount}곳이 있어요. 인물이 보이면 자르거나 모자이크해서 써 주세요.</p>}
        <p>{picked.description}</p>
        {!!picked.ocr.length && <p className="ce-photo-meta">글자: {picked.ocr.join(" · ")}</p>}
        {!!picked.tags.length && <p className="ce-photo-meta">{picked.tags.map(t => "#" + t).join(" ")}</p>}
        {!!picked.contextNotes.length && <details><summary>기록과 연결한 맥락</summary><ul>{picked.contextNotes.map(n => <li key={n}>{n}</li>)}</ul></details>}
        {!!picked.uncertainties.length && <details><summary>불확실한 점 {picked.uncertainties.length}개</summary><ul>{picked.uncertainties.map(n => <li key={n}>{n}</li>)}</ul></details>}
        <label>사진 설명 (대체 텍스트)<textarea aria-label="사진 설명" rows={2} maxLength={PHOTO_ALT_LIMIT} value={alt} onChange={e => setAlt(e.target.value.replace(/[\r\n]/g, " "))} /></label>
        <label>넣을 위치<select aria-label="사진 넣을 위치" value={anchor ? stickerKey(anchor) : ""} disabled={disabled} onChange={e => onTarget(e.target.value)}>{anchors.map(a => <option key={stickerKey(a)} value={stickerKey(a)}>{a.label}</option>)}</select></label>
        <p className="ce-photo-meta">본문의 사진·문단을 누르면 그 뒤가 선택돼요.</p>
        {used.has(picked.id) && <p className="ce-photo-note" role="status">이 사진은 이미 본문에 있어요.</p>}
        <button className="secondary" disabled={disabled || !anchor || !alt.trim() || used.has(picked.id) || placements.length >= 30} onClick={insert}>이 위치에 넣기</button>
      </div> : <>
        <ul className="ce-photo-grid" aria-label="분석된 사진">
          {found.slice(0, limit).map(item => <li key={item.id}><button aria-label={`${item.captureId} ${when(item)} 사진 보기`} title={item.description} onClick={() => pick(item)}>
            <img src={evidenceThumbnailUrl(item.id)} alt="" loading="lazy" decoding="async" />
            <span>{when(item)}</span>
            {used.has(item.id) && <em>본문 사용</em>}
            {item.faceCount > 0 && <i>얼굴 후보</i>}
          </button></li>)}
        </ul>
        {!found.length && <p className="ce-photo-note">찾는 사진이 없어요. 검색어나 촬영물을 바꿔 보세요.</p>}
        {found.length > limit && <button className="small ce-photo-more" onClick={() => setLimit(limit + PAGE)}>더 보기 ({found.length - limit}장 남음)</button>}
      </>}
    </>}
    {!!placements.length && <div className="ce-photo-pending">
      <h3>저장 전 사진 {placements.length}장</h3>
      <ol>{placements.map((p, i) => <li key={p.id}><img src={evidenceThumbnailUrl(p.imageId)} alt="" /><span>{label(p)}</span>
        <button className="small" aria-label={`사진 ${i + 1} 위치 보기`} onClick={() => onReveal(p.id)}>위치 보기</button>
        <button className="small" aria-label={`사진 ${i + 1} 빼기`} disabled={disabled} onClick={() => onChange(placements.filter(x => x.id !== p.id))}>빼기</button>
      </li>)}</ol>
      <small className="ui-meta">몇 초 뒤 원고에 들어가요. 그 전에 ‘빼기’로 취소할 수 있어요.</small>
    </div>}
  </section>;
}
