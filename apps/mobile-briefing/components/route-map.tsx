'use client';

import {useEffect, useMemo, useState} from 'react';
import {ArrowUpRight, ChevronLeft, ChevronRight, Film, MapPin} from 'lucide-react';
import type {RouteMapData} from '../lib/route-map';

type Resource = {id:string;content_id:string;role:string;label:string;file_name:string;mime_type:string;bytes:number;is_directory:number;available:number;item_count:number|null};
type Props = {data:RouteMapData;assets:Resource[];mediaEnabled:boolean;previewsEnabled:boolean;online:boolean;onOpen:(asset:Resource)=>void;onPreview:(asset:Resource)=>void};

/** The public DTO has no filesystem paths, executable HTML, previews or Photos IDs. */
export function RouteMapPanel({data,assets,mediaEnabled,previewsEnabled,online,onOpen,onPreview}:Props){
 const [selectedName,setSelectedName]=useState(data.assets[0]?.name??'');
 const [filter,setFilter]=useState<'all'|'video'|'photo'>('all');
 const [showUncertain,setShowUncertain]=useState(false);
 const visible=useMemo(()=>data.assets.filter(a=>filter==='all'||a.kind===filter),[data,filter]);
 const selected=visible.find(a=>a.name===selectedName)??visible[0];
 const selectedIndex=selected?visible.indexOf(selected):-1;
 useEffect(()=>{if(selected&&selectedName!==selected.name)setSelectedName(selected.name)},[selected,selectedName]);
 const {project,path}=useMemo(()=>{
  const points=[...data.assets.filter(a=>showUncertain||!a.uncertain).map(a=>a.point),...data.pois.map(a=>a.point),...data.legs.flatMap(l=>l.points)];
  if(!points.length)points.push(data.assets[0].point);
  let left=180,right=-180,bottom=90,top=-90;
  for(const [x,y] of points){left=Math.min(left,x);right=Math.max(right,x);bottom=Math.min(bottom,y);top=Math.max(top,y)}
  const scaleX=Math.cos((top+bottom)/2*Math.PI/180),dx=Math.max((right-left)*scaleX,.0004),dy=Math.max(top-bottom,.0004);
  const scale=Math.min(640/dx,480/dy),cx=(left+right)/2,cy=(top+bottom)/2;
  const project=(p:[number,number]):[number,number]=>[360+(p[0]-cx)*scaleX*scale,270-(p[1]-cy)*scale];
  return {project,path:(p:[number,number][])=>p.map((p,i)=>`${i?'L':'M'}${project(p).join(',')}`).join(' ')};
 },[data,showUncertain]);
 const matching=selected?assets.filter(a=>!a.is_directory&&a.file_name===selected.name&&((selected.kind==='video'&&a.mime_type.startsWith('video/'))||(selected.kind==='photo'&&a.mime_type.startsWith('image/')))):[];
 const linked=matching.length===1?matching[0]:null;
 const uncertainCount=data.assets.filter(a=>a.uncertain).length;
 return <section className="route-map-panel" aria-label="촬영 동선 지도">
  <div className="route-map-heading"><div><p className="eyebrow">CAPTURE ROUTE</p><h3><MapPin size={17}/> 시간별 촬영 동선</h3></div><span>{data.captureDate} · {data.assets.length}개</span></div>
  <p className="route-map-status">{data.routeStatus}</p>
  <div className="route-map-canvas"><svg viewBox="0 0 720 540" role="img" aria-label="촬영 위치와 참고 경로. 시간순 목록에서도 각 촬영분을 선택할 수 있어요.">
   <g aria-hidden="true">{data.ways.map((w,i)=><path key={i} d={path(w.points)} className={['path','footway','steps'].includes(w.kind)?'route-trail':'route-road'}/>)}{data.legs.map((l,i)=><path key={i} d={path(l.points)} className="route-candidate"/>)}
   {data.pois.map((p,i)=>{const [x,y]=project(p.point);return <g key={i}><circle cx={x} cy={y} r="3" fill="#42634b"/><text x={Math.max(8,Math.min(712,x))} y={y-11} textAnchor={x>570?'end':x<150?'start':'middle'} className="route-poi">{p.name}</text></g>})}</g>
   {visible.filter(a=>showUncertain||!a.uncertain).map(a=>{const [x,y]=project(a.point);return <circle key={a.name} cx={x} cy={y} r={a.name===selected?.name?8:5} className={`route-pin ${a.uncertain?'uncertain':''} ${a.name===selected?.name?'active':''}`} role="button" tabIndex={0} aria-label={`${a.time} ${a.name}${a.uncertain?' 위치 불확실':''}`} onClick={()=>setSelectedName(a.name)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelectedName(a.name)}}}><title>{a.time} · {a.name}</title></circle>})}
  </svg><p className="route-attribution">{data.attribution} · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">지도 저작권</a></p></div>
  <div className="route-map-controls"><div className="route-time-controls"><button aria-label="이전 촬영" disabled={selectedIndex<=0} onClick={()=>setSelectedName(visible[selectedIndex-1].name)}><ChevronLeft size={18}/></button><strong aria-live="polite">{selected?.time??'해당 촬영 없음'} <small>{data.timezone}</small></strong><button aria-label="다음 촬영" disabled={selectedIndex<0||selectedIndex>=visible.length-1} onClick={()=>setSelectedName(visible[selectedIndex+1].name)}><ChevronRight size={18}/></button></div>
  <label className="route-slider-label">촬영 순서 <span>{selectedIndex<0?0:selectedIndex+1} / {visible.length}</span><input aria-label="촬영 순서" type="range" min={0} max={Math.max(0,visible.length-1)} value={Math.max(0,selectedIndex)} disabled={!visible.length} onChange={e=>setSelectedName(visible[Number(e.target.value)].name)}/></label>
  <div className="route-filter-row"><label>촬영 종류 <select aria-label="촬영 종류" value={filter} onChange={e=>setFilter(e.target.value as typeof filter)}><option value="all">사진 + 영상</option><option value="video">영상만</option><option value="photo">사진만</option></select></label><label><input type="checkbox" checked={showUncertain} onChange={e=>setShowUncertain(e.target.checked)}/> 위치 불확실 {uncertainCount}개 표시</label></div>
  <p className="route-legend"><span>● 촬영 핀</span><span>○ 위치 불확실</span><span>┄ 참고 경로</span></p></div>
  {selected&&<div className="route-selection"><span>{selected.section}</span><strong>{selected.name}</strong><p>{selected.kind==='video'?`영상 · ${selected.duration}초`:'사진'} · {selected.uncertain?'위치 불확실 · ':''}기록된 위치 정확도 {selected.accuracy===null||selected.accuracy<0?'알 수 없음':`${selected.accuracy}m`}</p>
   <p>{!mediaEnabled?'모바일 원본 열기는 준비 중이에요. 지도와 촬영 정보는 Mac이 꺼져 있어도 확인할 수 있어요.':!linked?'연결된 원본 자료가 없어요. 데스크톱에서 이 파일을 연결해주세요.':!online?'Mac이 연결되면 원본을 열 수 있어요.':!linked.available?'원본 위치를 확인해주세요.':'연결된 원본을 열 수 있어요.'}</p>
   {linked&&<p className="route-linked-resource">연결 자료 · {linked.label}</p>}
   {linked&&previewsEnabled&&selected.kind==='video'&&<button className="route-open video-preview-open" onClick={()=>onPreview(linked)}><Film size={16}/>미리보기 재생</button>}
   {linked&&mediaEnabled&&<button className="route-open" disabled={!online||!linked.available} onClick={()=>onOpen(linked)}>원본 열기 <ArrowUpRight size={16}/></button>}
  </div>}
  <div className="route-capture-list" aria-label="시간순 촬영 목록">{visible.map(a=><button key={a.name} className={a.name===selected?.name?'selected':''} aria-pressed={a.name===selected?.name} onClick={()=>setSelectedName(a.name)}><time>{a.time}</time><span><strong>{a.kind==='video'?'영상':'사진'} · {a.name}</strong><small>{a.section}{a.uncertain?' · 위치 불확실':''}</small></span></button>)}{!visible.length&&<p className="muted">선택한 종류의 촬영분이 없어요.</p>}</div>
 </section>;
}
