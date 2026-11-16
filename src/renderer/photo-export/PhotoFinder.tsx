import { useState } from "react";
import type { DashboardBridge, Groups } from "../../shared/contracts";
import { findPhotos, type FoundPhoto, type PhotosFindResult } from "../../shared/photos-find";
import { readableTime } from "./shared";

export function PhotoFinder({ date, bridge, disabled, importDisabled, run, indexRunId, onIndexed, onSearchStart, onImport, onGroup }: {
  date: string;
  bridge: DashboardBridge;
  disabled: boolean;
  importDisabled: boolean;
  run: (name: string, fn: () => Promise<void>) => Promise<void>;
  indexRunId?: string;
  onIndexed: (groups: Groups) => void;
  onSearchStart: () => void;
  onImport: (asset: FoundPhoto) => void;
  onGroup: (id: string) => void;
}) {
  const [kind, setKind] = useState<"video" | "photo" | "all">("video");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const [filename, setFilename] = useState("");
  const [result, setResult] = useState<PhotosFindResult | null>(null);
  const [searched, setSearched] = useState("");
  const query = JSON.stringify({ date, mediaKind: kind,
    ...(kind === "video" && min !== "" ? { minDuration: Number(min) } : {}),
    ...(kind === "video" && max !== "" ? { maxDuration: Number(max) } : {}),
    ...(filename.trim() ? { filename: filename.trim() } : {}) });
  const current = searched === query && result?.groups.indexRunID === indexRunId ? result : null;
  return <section aria-label="촬영본 빠르게 찾기" className="ui-section">
    <h2>촬영본 빠르게 찾기</h2>
    <p>위 날짜에서 종류·길이·파일명으로 찾아요. 길이는 초 단위예요.</p>
    <form onSubmit={e => { e.preventDefault(); void run("촬영본 검색", async () => {
      setResult(null); onSearchStart();
      const found = await findPhotos((method, args) => bridge.request(method, args), JSON.parse(query));
      onIndexed(found.groups); setResult(found); setSearched(query);
    }); }}>
      <fieldset disabled={disabled || !date} className="library-controls">
        <label>촬영본 종류 <select value={kind} onChange={e => setKind(e.target.value as typeof kind)}>
          <option value="video">영상</option><option value="photo">사진</option><option value="all">전체</option>
        </select></label>
        <label>최소 길이(초) <input type="number" min="0" step="any" value={min} disabled={kind !== "video"} onChange={e => setMin(e.target.value)} /></label>
        <label>최대 길이(초) <input type="number" min="0" step="any" value={max} disabled={kind !== "video"} onChange={e => setMax(e.target.value)} /></label>
        <button type="button" onClick={() => { setKind("video"); setMin("90"); setMax("150"); }}>약 2분 (90~150초)</button>
        <label>파일명 포함 <input value={filename} onChange={e => setFilename(e.target.value)} placeholder="예: IMG_1234" /></label>
        <button type="submit" className="primary">촬영본 찾기</button>
      </fieldset>
    </form>
    {current && <div aria-label="촬영본 검색 결과" aria-live="polite">
      <p>{current.scannedCount}개 중 {current.matches.length}개를 찾았어요.</p>
      {current.matches.length === 0 && <p>날짜나 길이 조건을 바꿔보세요.</p>}
      {current.matches.map(asset => <div className="ui-row" key={asset.id}>
        <div><strong>{asset.publicFilename || asset.id}</strong><p>{readableTime(asset.capturedAt)} · {asset.mediaKind === "video" ? `${Math.floor(asset.durationSeconds / 60)}분 ${(asset.durationSeconds % 60).toFixed(1)}초` : "사진"} · {asset.pixelWidth}×{asset.pixelHeight}</p></div>
        <button disabled={disabled} onClick={() => onGroup(asset.groupId)}>촬영 그룹 보기</button>
        {asset.mediaKind === "video" && <button disabled={disabled || importDisabled} onClick={() => onImport(asset)}>프로젝트로 추가</button>}
      </div>)}
    </div>}
  </section>;
}
