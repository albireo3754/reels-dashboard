import { useMemo, useState, type ReactNode } from "react";
import { routeBounds, type RouteMapData } from "../../../shared/route-map";
import "./route-map.css";

/** Offline view: no routing, tile requests, geocoding, or local paths. */
export function RouteMapView({ data, renderMedia }: {
  data: RouteMapData;
  renderMedia?: (asset: RouteMapData["assets"][number]) => ReactNode;
}) {
  const [filter, setFilter] = useState("all");
  const [uncertain, setUncertain] = useState(false);
  const [selectedName, setSelectedName] = useState(data.assets[0].name);
  const filtered = data.assets.filter((a) => filter === "all" || a.kind === filter);
  const selected = filtered.find((a) => a.name === selectedName) ?? filtered[0];
  const index = selected ? filtered.indexOf(selected) : -1;
  const bounds = useMemo(() => routeBounds(data, uncertain), [data, uncertain]);
  const [west, south, east, north] = bounds;
  // Preserve local geographic proportions so north/south routes are not distorted.
  const cosine = Math.cos(((north + south) / 2) * Math.PI / 180);
  const scale = Math.min(740 / ((east - west) * cosine), 640 / (north - south));
  const x0 = 400 - (east - west) * cosine * scale / 2;
  const y0 = 350 + (north - south) * scale / 2;
  const xy = (p: number[]) => [x0 + (p[0] - west) * cosine * scale, y0 - (p[1] - south) * scale];
  const line = (points: number[][]) => points.map((p, i) => `${i ? "L" : "M"}${xy(p).join(",")}`).join(" ");
  const selectAt = (i: number) => { if (filtered[i]) setSelectedName(filtered[i].name); };
  return <section className="route-map-view" aria-label="시간별 촬영 지도">
    <p className="route-map-description">{data.captureDate} · {data.timezone} · {data.assets.filter(a => a.kind === "video").length}개 영상 · {data.assets.filter(a => a.kind === "photo").length}개 사진</p>
    <p className="route-map-status">{data.routeStatus}</p>
    <div className="route-map-layout">
      <div className="route-map-main">
        <svg viewBox="0 0 800 700" role="img" aria-label="도로·등산로와 촬영 핀. 핀 또는 시간 목록에서 촬영분을 선택하세요.">
          <g className="route-map-roads">{data.ways.map((w, i) => <path key={i} d={line(w.points)} className={["path", "footway", "steps"].includes(w.kind) ? "trail" : "road"} />)}</g>
          <g className="route-map-legs">{data.legs.map((l, i) => <path key={i} d={line(l.points)}><title>{l.status}</title></path>)}</g>
          <g>{data.pois.map((p, i) => { const [x, y] = xy(p.point); return <g key={i}><circle cx={x} cy={y} r="3" fill="currentColor" /><text className="route-map-poi" x={Math.max(5, Math.min(x + 8, 650))} y={Math.max(20, y - 9)}>{p.name}</text></g>; })}</g>
          <g>{filtered.filter(a => uncertain || !a.uncertain).map(a => { const [x, y] = xy(a.point); return <circle key={a.name} className={`route-map-pin ${a.uncertain ? "uncertain" : ""} ${a.name === selected?.name ? "selected" : ""}`} cx={x} cy={y} r={a.name === selected?.name ? 9 : 5} tabIndex={0} role="button" aria-label={`${a.time} ${a.name} 촬영 핀`} aria-pressed={a.name === selected?.name} onClick={() => setSelectedName(a.name)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedName(a.name); } }}><title>{a.time} · {a.name}{a.uncertain ? " · 위치 불확실" : ""}</title></circle>; })}</g>
          {selected && (uncertain || !selected.uncertain) && <circle className="route-map-selection" cx={xy(selected.point)[0]} cy={xy(selected.point)[1]} r="14" />}
        </svg>
        <div className="route-map-controls">
          <div className="route-map-time-controls"><button disabled={index <= 0} onClick={() => selectAt(index - 1)}>이전 촬영</button><strong aria-live="polite">{selected?.time ?? "촬영 없음"}</strong><button disabled={index < 0 || index >= filtered.length - 1} onClick={() => selectAt(index + 1)}>다음 촬영</button></div>
          <label>촬영 순서<input aria-label="촬영 순서" type="range" min="0" max={Math.max(0, filtered.length - 1)} value={Math.max(0, index)} disabled={!filtered.length} onChange={e => selectAt(Number(e.target.value))} /></label>
          <div className="route-map-options"><label><input type="checkbox" checked={uncertain} onChange={e => setUncertain(e.target.checked)} /> 위치가 불확실한 핀 표시</label><label>촬영 종류<select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">전체</option><option value="video">영상만</option><option value="photo">사진만</option></select></label></div>
          <p className="route-map-legend">● 촬영 위치 · ○ 위치 불확실 · 점선: 참고 경로</p>
          <p className="route-map-attribution">{data.attribution}</p>
        </div>
      </div>
      <aside className="route-map-detail">
        {selected ? <div className="route-map-selected" aria-live="polite"><span>{selected.section}</span><h3>{selected.name}</h3><p>{selected.kind === "video" ? `영상 · ${selected.duration}초` : "사진"} · {selected.time}</p><p className={selected.uncertain ? "route-map-warning" : "route-map-small"}>위치 오차 {selected.accuracy === null || selected.accuracy < 0 ? "알 수 없음" : `약 ${selected.accuracy}m`}{selected.uncertain ? " · 지도 경로 판단에서 제외" : ""}</p>{selected.uncertain && !uncertain && <p className="route-map-small">위치가 불확실해 지도 핀은 숨겼어요. 촬영 기록은 보존해요.</p>}{renderMedia?.(selected)}</div> : <p>선택한 종류의 촬영분이 없어요.</p>}
        <div className="route-map-list" aria-label="시간순 촬영 목록">{filtered.map(a => <button key={a.name} aria-pressed={a.name === selected?.name} className={a.name === selected?.name ? "selected" : ""} onClick={() => setSelectedName(a.name)}><span>{a.time} · {a.kind === "video" ? "영상" : "사진"}</span><strong>{a.name}</strong><small>{a.section}{a.uncertain ? " · 위치 불확실" : ""}</small></button>)}</div>
      </aside>
    </div>
  </section>;
}
