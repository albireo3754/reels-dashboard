'use client';
import {useCallback,useEffect,useState} from 'react';
import {SourceBoardIndex, SourceBoardPanel} from "../components/source-board";
import {ScheduledPublications} from '../components/scheduled-publications';
import {ProductionMonitor} from '../components/production-monitor';
import {channelLabels,stateLabels,statusLabels} from '../lib/monitor';
import {HomeScreen} from '../components/home-screen';
import {VideoPreview} from '../components/video-preview';
import {OriginalMediaPreview} from '../components/media-preview-dialog';
import {RouteMapPanel} from '../components/route-map';
import {PublishingCopyPanel} from '../components/publishing-copy';
import {InstructionsPanel,type InstructionTarget} from '../components/instructions-panel';
import {validPaseoTarget} from '../lib/paseo-request.mjs';
import {useBriefingSync,type Content,type Asset} from "../features/briefing-sync";
import {ArrowUpRight,ArrowLeft,Camera,Check,ChevronRight,Cloud,FileText,Film,Folder,Image as ImageIcon,RefreshCw,Search,Wifi,WifiOff,X} from 'lucide-react';
const roleNames:Record<string,string>={footage:'촬영본',final:'완성본',cover:'표지',draft:'시안',document:'제작 문서',folder:'자료 폴더'};
const date=(value:string|null)=>value?new Date(value).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Seoul'}):'아직 동기화 전';
const size=(bytes:number)=>bytes>1024*1024?`${(bytes/1024/1024).toFixed(1)} MB`:bytes>1024?`${Math.round(bytes/1024)} KB`:`${bytes} B`;
const title=(c:Content)=>c.title.replace(/^촬영 · /,'').replace(/\d{4}-\d{2}-\d{2}_?/,'').replaceAll('_',' ');
const stateOf=(c:Content)=>c.state??(c.stage==='done'||c.stage==='published'?'complete':c.stage==='review'?'review':'in_progress');
const active=(c:Content)=>['review','channel_pending','in_progress'].includes(stateOf(c));
const badge=(c:Content)=>stateLabels[stateOf(c)];
function Channels({c}:{c:Content}){return c.publications?.length?<div className="channel-chips">{c.publications.map(p=><span key={p.channel} className={p.status} title={p.scheduledAt?`예약 ${date(p.scheduledAt)}`:undefined}>{channelLabels[p.channel]}{p.channel==='youtube'?` ${p.format==='shorts'?'쇼츠':'본편'}`:''} · {statusLabels[p.status]}</span>)}</div>:null;}
function Kind({a}:{a:Asset}){return a.is_directory?<Folder size={18}/>:a.mime_type.startsWith('image')?<ImageIcon size={18}/>:a.mime_type.startsWith('video')?<Film size={18}/>:<FileText size={18}/>;}
export function Briefing(){
 const [tab,setTab]=useState<'briefing'|'contents'|'captures'>('briefing'),[filter,setFilter]=useState('active'),[query,setQuery]=useState(''),[selectedId,setSelectedId]=useState<string|null>(null);
 const [channel,setChannel]=useState('all'),[sort,setSort]=useState('priority'),[view,setView]=useState('list'),[kind,setKind]=useState('all');
 const [openedMedia,setOpenedMedia]=useState<{mode:'original'|'preview';asset:Asset}|null>(null);
 const preview=openedMedia?.mode==='original'?openedMedia.asset:null;
 function setSelected(c:Content|null){setOpenedMedia(null);setSelectedId(c?.id??null);}
 function openMedia(asset:Asset,mode:'original'|'preview'){setOpenedMedia({mode,asset});}
 function closeMedia(){setOpenedMedia(null);}
 const [instructRequest,setInstructRequest]=useState<{target:string;nonce:number}|null>(null);
 const onAccessLost=useCallback(()=>{setSelectedId(null);setOpenedMedia(null);},[]);
 const {data,error,loading,connected,checkedAt,authRequired,refresh}=useBriefingSync(onAccessLost);
 const selected=data?.contents.find(c=>c.id===selectedId)??null;
 useEffect(()=>{setSelectedId(new URLSearchParams(window.location.search).get('content'));},[]);
 useEffect(()=>{const listener=(e:KeyboardEvent)=>{if(e.key==='Escape'){if(openedMedia)setOpenedMedia(null);else setSelectedId(null);}};window.addEventListener('keydown',listener);return()=>window.removeEventListener('keydown',listener);},[openedMedia]);
 const contents=data?.contents??[];
 const captures=data?.contents.filter(c=>c.id.startsWith('capture:'))??[];
 const counts={active:contents.filter(active).length,review:contents.filter(c=>stateOf(c)==='review').length,complete:contents.filter(c=>stateOf(c)==='complete').length};
 const order:Record<string,number>={review:0,channel_pending:0,in_progress:1,scheduled:2,complete:3};
 const byPriority=(a:Content,b:Content)=>order[stateOf(a)]-order[stateOf(b)]||(a.priority??Infinity)-(b.priority??Infinity)||(['review','editing','selected','captured','idea','done','published'].indexOf(a.stage)-['review','editing','selected','captured','idea','done','published'].indexOf(b.stage))||b.date.localeCompare(a.date)||a.title.localeCompare(b.title,'ko');
 const priority=contents.filter(active).sort(byPriority);
 const results=(tab==='captures'?captures:contents).filter(c=>{
  const state=stateOf(c),entry=c.publications?.find(p=>p.channel===channel);
  if(channel!=='all'&&!entry)return false;
  if(kind!=='all'&&(c.kind??'content')!==kind)return false;
  if(tab!=='captures'&&filter!=='all'&&(filter==='active'?!active(c)||entry?.status==='published':filter==='review'?c.stage!=='review':filter==='complete'?state!=='complete':filter==='scheduled'?!c.publications?.some(p=>p.status==='scheduled')&&state!=='scheduled':c.stage!==filter))return false;
  return `${c.title} ${c.next_action} ${c.date}`.normalize('NFKC').toLowerCase().includes(query.normalize('NFKC').toLowerCase());
 }).sort(sort==='priority'?byPriority:sort==='title'?(a,b)=>a.title.localeCompare(b.title,'ko'):(a,b)=>(sort==='oldest'?1:-1)*a.date.localeCompare(b.date));
 const selectedBoard=data?.monitor?.sourceBoards?.find(entry=>entry.projectId===selected?.id)?.board;
 const assets=selected?data?.assets.filter(a=>a.content_id===selected.id)??[]:[];
 // Instruction targets: only ids from the synchronized data that pass the Paseo target check (the server re-checks).
 const instructTargets:InstructionTarget[]=[];
 const todayTarget=validPaseoTarget(data?.monitor?.autopilot.today?.target);
 if(todayTarget&&data?.monitor?.autopilot.today)instructTargets.push({value:todayTarget,label:'오늘 볼 항목 · '+data.monitor.autopilot.today.title});
 for(const c of [...contents].sort(byPriority)){const v=validPaseoTarget('project:'+c.id);if(v&&!instructTargets.some(t=>t.value===v))instructTargets.push({value:v,label:title(c)+' · '+c.date});}
 function navigate(next:typeof tab){setTab(next);setQuery('');setFilter('active');setChannel('all');setKind('all');setSelected(null);}
 function card(c:Content,compact=false){const n=data?.assets.filter(a=>a.content_id===c.id).length??0;return <button className={`content-card ${compact?'compact':''}`} key={c.id} onClick={()=>setSelected(c)}><div className={`card-symbol ${stateOf(c)}`}><span>{c.id.startsWith('capture:')?<Camera size={22}/>:stateOf(c)==='complete'?<Check size={22}/>:<Film size={22}/>}</span><span className={`badge ${stateOf(c)}`}>{badge(c)}</span></div><div className="card-copy"><p className="eyebrow">{c.date_basis==='publication'?'게시일':c.date_basis==='capture'?'촬영일':'기록일'} · {c.date}</p><h3>{title(c)}{c.kind==='operation'&&<small className="kind-tag">운영</small>}{c.priority!=null&&<small className="kind-tag">순서 {c.priority}</small>}</h3><Channels c={c}/><p className="next-action">{c.next_action||'다음 작업을 확인해요'}</p><div className="card-foot"><span>연결 자료 {n}개</span><ChevronRight size={17}/></div></div></button>}
 return <div className="shell"><header className="topbar"><a className="brand" href="/" aria-label="로지 제작 브리핑 홈"><span className="brand-mark">r<span>•</span></span><span>rosy<span className="brand-sub">PRODUCTION NOTES</span></span></a><div className="private-pill"><span/> 우리의 작업실</div></header>
 <main><div className="page-top"><h1>제작 현황</h1><div className="sync-card"><div><span className={`status-dot ${connected&&!error&&data?.online?'online':''}`}/><strong>{!connected?'인터넷 연결 끊김':error?'최신 현황 확인 필요':data?.online?'Mac 연결됨':'서버에 저장된 기록'}</strong></div><p>마지막 동기화 {date(data?.syncedAt??null)}</p>{checkedAt&&<p className="last-checked">이 기기에서 확인 {date(checkedAt)}</p>}<button onClick={()=>void refresh()} disabled={loading} aria-label="진행 정보 새로고침"><RefreshCw size={14} className={loading?'spinning':''}/> 새로고침</button></div></div>

 <nav className="tabs" aria-label="제작 현황 탐색">{([['briefing','대시보드'],['contents','콘텐츠'],['captures','촬영함']] as const).map(([key,label])=><button key={key} className={tab===key?'active':''} onClick={()=>navigate(key)}>{label}{key!=='briefing'&&<span>{key==='contents'?contents.length:captures.length}</span>}</button>)}</nav>
 {error&&<div className="notice error" role="alert">{error} {data&&'마지막으로 불러온 정보를 표시하고 있어요.'}{authRequired&&<a className="reauth-link" href="/">로그인 다시 확인</a>}</div>}
 {data&&tab==='briefing'&&<ScheduledPublications contents={data.contents} monitor={data.monitor??null} onOpen={setSelectedId}/>}
 {!authRequired&&<InstructionsPanel targets={instructTargets} showList={tab==='briefing'} request={instructRequest}/>}
 {!data&&<div className="empty">{loading?'제작 기록을 가져오고 있어요…':'새로고침해서 기록을 불러와 주세요.'}</div>}
 {data&&data.contents.length===0&&<div className="empty"><Cloud/><h2>첫 제작 기록을 기다리고 있어요</h2><p>로컬 대시보드가 연결되면 촬영 자료와 진행 상황이 여기에 모여요.</p></div>}
 {data&&data.contents.length>0&&tab==='briefing'&&<>
 <div className="progress-tabs" role="group" aria-label="진행 단계 요약">{([['active','진행 중',counts.active],['review','검토 대기',counts.review],['complete','완료',counts.complete]] as const).map(([key,label,n])=><button key={key} onClick={()=>{navigate('contents');setFilter(key)}}>{label}<strong>{n}</strong></button>)}</div>
 <SourceBoardIndex entries={data.monitor?.sourceBoards??[]} onOpen={id=>setSelectedId(id)}/>
 <ProductionMonitor monitor={data.monitor??null} contents={data.contents} syncedAt={data.syncedAt} onOpen={id=>setSelectedId(id)} onInstruct={todayTarget?target=>setInstructRequest(r=>({target,nonce:(r?.nonce??0)+1})):undefined}/>
 <section className="next-section"><div className="section-heading"><div><h2>진행 중인 작업</h2></div><span>{priority.length}개의 진행 중인 콘텐츠</span></div><div className="next-list">{priority.slice(0,5).map((c,i)=><button key={c.id} className="next-row" onClick={()=>setSelected(c)}><span className="row-no">{String(i+1).padStart(2,'0')}</span><div><span className={`badge ${stateOf(c)}`}>{badge(c)}</span><h3>{title(c)}{c.priority!=null&&<small className="kind-tag">순서 {c.priority}</small>}</h3><Channels c={c}/><p>{c.next_action}</p></div><ArrowUpRight size={20}/></button>)}{!priority.length&&<p className="muted">지금 검토·편집 중인 콘텐츠가 없어요. 촬영함에서 다음 이야기를 골라보세요.</p>}</div></section>
 <section><div className="section-heading"><div><h2>최근 완료</h2></div><button className="text-button" onClick={()=>{navigate('contents');setFilter('complete')}}>완료 전체 <ArrowUpRight size={16}/></button></div><div className="cards">{contents.filter(c=>stateOf(c)==='complete').slice(0,3).map(c=>card(c,true))}</div></section>
 <aside className="quiet-note"><Cloud size={20}/><p>진행 정보는 서버에 보관돼요. Mac이 꺼져 있어도 마지막 기록을 확인할 수 있어요. 원본 파일은 기존 위치에 그대로 보관돼요.</p></aside>
 </>}
 {data&&tab!=='briefing'&&<section className="browse"><div className="section-heading"><div><p className="eyebrow">{tab==='captures'?'THE FOOTAGE LIBRARY':'YOUR CONTENTS'}</p><h2>{tab==='captures'?'촬영함':'콘텐츠 보드'}</h2></div><span>{results.length}개</span></div><label className="search"><Search size={18}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder={tab==='captures'?'장소나 촬영 날짜로 찾아보세요':'콘텐츠 이름이나 다음 할 일 검색'} aria-label="콘텐츠 검색"/></label>{tab==='contents'&&<><div className="filters">{['active','review','scheduled','complete','all'].map(s=><button key={s} onClick={()=>setFilter(s)} className={s===filter?'active':''} aria-pressed={s===filter}>{({active:'진행 중',review:'검토 대기',scheduled:'공개 예약 대기',complete:'완료',all:'전체'} as Record<string,string>)[s]}</button>)}</div><div className="board-options"><label>채널<select aria-label="채널 필터" value={channel} onChange={e=>setChannel(e.target.value)}><option value="all">모든 채널</option>{Object.entries(channelLabels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label><label>종류<select aria-label="작업 종류" value={kind} onChange={e=>setKind(e.target.value)}><option value="all">전체</option><option value="content">콘텐츠</option><option value="operation">운영</option></select></label><label>정렬<select aria-label="콘텐츠 정렬" value={sort} onChange={e=>setSort(e.target.value)}><option value="priority">작업 우선순</option><option value="newest">날짜 최신순</option><option value="oldest">날짜 오래된순</option><option value="title">제목 가나다순</option></select></label><div className="view-toggle" role="group" aria-label="보드 표시"><button aria-pressed={view==='list'} onClick={()=>setView('list')}>목록</button><button aria-pressed={view==='grid'} onClick={()=>setView('grid')}>카드</button></div></div></>}<div className={`cards board-cards ${view==='list'?'list-view':''}`}>{results.map(c=>card(c))}</div>{!results.length&&<div className="empty">찾는 조건에 맞는 기록이 없어요.</div>}</section>}
 <HomeScreen/><footer><span>rosy · small scenes, lasting stories</span><span>모든 날짜는 기록에 표시된 기준을 따라요.</span></footer></main>
 {selected&&<div className="modal-backdrop" onClick={()=>setSelected(null)}><section role="dialog" aria-modal="true" aria-label={title(selected)} className={`detail-sheet ${selected.route_map?'has-route-map':''}`} onClick={e=>e.stopPropagation()}><button className="close" onClick={()=>setSelected(null)} aria-label="상세 닫기"><X size={22}/></button><span className={`badge ${stateOf(selected)}`}>{badge(selected)}</span><h2>{title(selected)}</h2>{selectedBoard&&<SourceBoardPanel key={selected.id} board={selectedBoard}/>}<Channels c={selected}/>{selected.publications?.filter(p=>p.status==='scheduled').map(p=><p className="notice" key={p.channel}>{channelLabels[p.channel]} · {date(p.scheduledAt??null)} 공개 예약{p.scheduledAt&&Date.parse(p.scheduledAt)<=Date.now()?' · 예정 시각이 지났어요. 실제 공개 여부를 확인해주세요.':''}</p>)}<p className="muted">{selected.date_basis==='publication'?'실제 게시일':selected.date_basis==='capture'?'촬영일':'기록 기준일'} · {selected.date}</p><div className="next-box"><p className="eyebrow">NEXT ACTION</p><p>{selected.next_action||'다음 할 일이 등록되지 않았어요.'}</p></div>{selected.public_url&&<a className="publish-link" href={selected.public_url} target="_blank" rel="noreferrer">게시물 보러 가기 <ArrowUpRight size={16}/></a>}{selected.publications?.filter(p=>p.url).map(p=><a key={p.channel} className="publish-link" href={p.url} target="_blank" rel="noreferrer">{channelLabels[p.channel]} 게시물 <ArrowUpRight size={16}/></a>)}{!selected.id.startsWith('capture:')&&<PublishingCopyPanel key={selected.id+JSON.stringify(selected.publishing_copy)} copy={selected.publishing_copy}/>}{selected.route_map&&<RouteMapPanel key={selected.id} data={selected.route_map} assets={assets} mediaEnabled={!!data?.mediaEnabled} online={!!data?.online} previewsEnabled={!!data?.previewsEnabled} onOpen={a=>openMedia(a,'original')} onPreview={a=>openMedia(a,'preview')}/>}{!selected.route_map&&selected.route_map_status==='unavailable'&&<p className="notice">등록된 촬영 지도를 읽지 못했어요. 데스크톱에서 지도 자료를 확인해주세요.</p>}<div className="section-heading"><h3>연결된 자료</h3><span>{assets.length}개</span></div><p className="asset-help">{data?.mediaEnabled?(data.online?'필요한 파일을 선택하면 로컬 자료에서 불러와요.':'Mac의 로컬 서버가 연결되면 파일을 열 수 있어요.'):data?.previewsEnabled?'영상은 저화질 미리보기로 재생할 수 있어요.':'자료 종류와 진행 상태를 확인할 수 있어요. 모바일 원본 열기는 준비 중이에요.'}</p><div className="asset-list">{assets.map(a=><div className="asset" key={a.id}><div className="asset-icon"><Kind a={a}/></div><div><span>{roleNames[a.role]}</span><strong>{a.label}</strong><small>{!a.available?'경로 확인 필요':a.is_directory?`${a.item_count??'—'}개 미디어 · 로컬 폴더`:size(a.bytes)}</small></div>{!a.is_directory&&(data?.mediaEnabled||(data?.previewsEnabled&&a.mime_type.startsWith('video/')))&&<div className="asset-actions">
  {data?.previewsEnabled&&a.mime_type.startsWith('video/')&&<button className="asset-preview" onClick={()=>openMedia(a,'preview')} aria-label={`${a.label} 미리보기 재생`}><Film size={16}/>미리보기 재생</button>}
  {data?.mediaEnabled&&<button disabled={!data.online||!a.available} onClick={()=>openMedia(a,'original')} aria-label={`${a.label} 열기`}><ArrowUpRight size={19}/></button>}
 </div>}</div>)}</div><p className="asset-help">폴더는 등록된 위치와 파일 수를 보여줘요. 폴더 내 컷 선별·편집은 데스크톱에서 이어가요.</p></section></div>}
 {selected&&openedMedia?.mode==='preview'&&<VideoPreview key={openedMedia.asset.id} id={openedMedia.asset.id} label={openedMedia.asset.label} connected={connected} onClose={closeMedia}/>}
 {preview&&<OriginalMediaPreview key={preview.id} id={preview.id} label={preview.label} mimeType={preview.mime_type} onClose={closeMedia}/>}
 </div>
}
