import { useEffect, useRef, useState } from "react";
import type { DashboardBridge, Project } from "../../../shared/contracts";
import { ROUTE_MAP_FILENAME, type LocalRouteMap } from "../../../shared/route-map";
import { RouteMapView } from "./RouteMapView";

export function ContentRouteMap({ project, bridge }: { project: Project; bridge: DashboardBridge }) {
  const [opened, setOpened] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  if (!bridge.routeMap || !project.resources?.some(r => r.role === "document" && r.path.split(/[\\/]/).at(-1) === ROUTE_MAP_FILENAME)) return null;
  return <><button className="route-map-open" ref={opener} onClick={() => setOpened(true)}>촬영 지도 · 동선 보기</button>{opened && <RouteDialog project={project} bridge={bridge} close={() => { setOpened(false); requestAnimationFrame(() => opener.current?.focus()); }} />}</>;
}
function RouteDialog({ project, bridge, close }: { project: Project; bridge: DashboardBridge; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [loaded, setLoaded] = useState<LocalRouteMap | null>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    ref.current?.showModal(); const old = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = old; };
  }, []);
  useEffect(() => {
    let live = true;
    const load = () => bridge.routeMap!.load(project.id).then(value => { if (live) { setLoaded(value); setError(""); } }).catch(e => { if (live) setError(e instanceof Error ? e.message : "지도를 불러오지 못했어요."); });
    void load(); const timer = setInterval(() => void load(), 30000);
    return () => { live = false; clearInterval(timer); };
  }, [bridge, project.id, retry]);
  return <dialog ref={ref} className="route-map-dialog" aria-label={`${project.title} 촬영 지도`} onCancel={close} onClose={close} onClick={e => { if (e.target === ref.current) close(); }}>
    <header><h2>{project.title} · 촬영 지도</h2><button autoFocus aria-label="촬영 지도 닫기" onClick={close}>닫기 ×</button></header>
    {error && <p role="alert">{error} <button onClick={() => setRetry(v => v + 1)}>다시 불러오기</button></p>}
    {loaded === undefined && !error && <p role="status">촬영 지도를 불러오고 있어요.</p>}
    {loaded === null && <p>연결한 촬영 지도 문서가 없어요.</p>}
    {loaded && <RouteMapView data={loaded.data} renderMedia={asset => <RouteMedia key={`${asset.name}:${loaded.mediaByName[asset.name] ?? ""}`} projectId={project.id} file={loaded.mediaByName[asset.name]} name={asset.name} bridge={bridge} />} />}
  </dialog>;
}
function RouteMedia({ bridge, projectId, file, name }: { bridge: DashboardBridge; projectId: string; file?: string; name: string }) {
  const [media, setMedia] = useState<{ url: string; kind: string }>();
  const [error, setError] = useState("");
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    if (!requested || !file || !bridge.contentMedia) return;
    let live = true;
    bridge.contentMedia.open(projectId, file).then(value => { if (live) setMedia(value); }).catch(e => { if (live) setError(e instanceof Error ? e.message : "원본을 열지 못했어요."); });
    return () => { live = false; };
  }, [bridge, projectId, file, requested]);
  if (!file) return <p className="route-map-small">이 촬영분의 원본은 아직 연결되지 않았어요. Photos에서 촬영일과 파일명으로 확인할 수 있어요.</p>;
  return <div className="route-map-media">
    {!requested && <button onClick={() => setRequested(true)}>선택한 촬영분 열기</button>}
    {requested && !media && !error && <p role="status">재생용 자료를 준비하고 있어요.</p>}
    {error && <p role="alert">{error}</p>}
    {media && (media.kind === "video" ? <video controls preload="metadata" src={media.url} aria-label={`${name} 재생`} onError={() => setError("영상을 재생하지 못했어요.")} /> : <img src={media.url} alt={name} onError={() => setError("사진을 열지 못했어요.")} />)}
  </div>;
}
