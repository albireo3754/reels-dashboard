'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {Send,X,Loader2} from 'lucide-react';

// Owner-only "지시하기". Draft, preview and list state live here, apart from the 30-second briefing
// refresh, so a refresh never clears what is being typed. Results are rendered as plain text only.
export type InstructionTarget={value:string;label:string};
type Status='queued'|'claimed'|'running'|'needs_user'|'done'|'failed'|'cancelled'|'expired';
export type InstructionItem={id:string;text:string;target:string|null;end_level:string|null;status:Status;created_at:string;updated_at:string;claimed_at:string|null;started_at:string|null;finished_at:string|null;expires_at:string;session_name:string|null;summary:string|null;question:string|null;error_code:string|null};
type Info={enabled:boolean;macOnline:boolean;macReady:{ready:boolean;reason:string|null}|null;maxActive:number;delayAfterMinutes:number;maxChars:number;items:InstructionItem[]};
type Access='loading'|'ok'|'denied'|'error';
export const END_LEVEL_LABELS:Record<string,string>={draft:'초안',review_applied:'리뷰 반영',pre_publish:'게시 직전 패키지',pre_merge:'앱 병합 전'};
const ERROR_LABELS:Record<string,string>={LAUNCH_FAILED:'실행기를 띄우지 못했어요',RESULT_MISSING:'결과 파일이 없어요',RESULT_INVALID:'결과 형식이 맞지 않아요',TIMEOUT:'시간이 초과됐어요',BRIDGE_DISABLED:'Mac 실행 스위치가 꺼졌어요',AGENT_FAILED:'에이전트가 실패했어요',CLAIM_LOST:'Mac이 가져간 뒤 실행 소식이 없어요. 두 번 실행하지 않도록 다시 시작하지 않아요'};
const READY_REASONS:Record<string,string>={disabled:'Mac 실행 스위치 꺼짐',launcher_down:'Paseo 꺼짐',locked:'Mac 잠김',busy:'앞 작업 실행 중'};
const MAX_CHARS=4000;
const codePoints=(s:string)=>[...s].length;
const newKey=()=>{if(typeof crypto.randomUUID==='function')return crypto.randomUUID();const b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;const h=[...b].map(x=>x.toString(16).padStart(2,'0')).join('');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);};
function ago(from:string|null,now:number){if(!from)return '';const m=Math.max(0,Math.floor((now-Date.parse(from))/60000));return m<1?'방금':m<60?m+'분':Math.floor(m/60)+'시간'+(m%60?' '+(m%60)+'분':'');}
export function waitingReason(info:Pick<Info,'enabled'|'macOnline'|'macReady'>){
 if(!info.enabled)return '지시 기능 꺼짐';
 if(!info.macOnline)return 'Mac 꺼짐·연결 끊김';
 if(!info.macReady)return '브리지 준비 상태 확인 전';
 if(!info.macReady.ready)return READY_REASONS[info.macReady.reason??'']??'Mac 준비 안 됨';
 return '곧 시작';
}
function badge(item:InstructionItem,info:Info,now:number){
 const session=item.session_name??'준비 중';
 switch(item.status){
  case 'queued':return 'Mac 대기 중('+waitingReason(info)+')';
  case 'claimed':return '실행 중 · 세션 '+session;
  case 'running':return (item.started_at&&now-Date.parse(item.started_at)>info.delayAfterMinutes*60000?'지연':'실행 중')+' · 세션 '+session;
  case 'needs_user':return '답 필요';
  case 'done':return '완료';
  case 'failed':return '실패';
  case 'cancelled':return '취소됨';
  case 'expired':return '만료됨';
 }
}
const authErrors=new Set(['UNAUTHORIZED']);
function errorMessage(code:string|undefined,extra:{window?:string}={}){
 switch(code){
  case 'RATE_LIMITED':return extra.window==='day'?'24시간에 20건까지 보낼 수 있어요. 내일 다시 보내 주세요.':'1분에 3건까지 보낼 수 있어요. 잠시 뒤 다시 보내 주세요.';
  case 'QUEUE_FULL':return 'Mac 대기 중인 지시가 5건이라 더 받을 수 없어요. 대기 중인 지시를 취소하거나 끝나기를 기다려 주세요.';
  case 'TEXT_TOO_LONG':case 'BODY_TOO_LARGE':return '4,000자 이하로 줄여 주세요.';
  case 'TEXT_INVALID':return '보이지 않는 제어 문자가 섞여 있어요. 내용을 다시 입력해 주세요.';
  case 'TEXT_REQUIRED':return '지시할 내용을 적어 주세요.';
  case 'TARGET_INVALID':case 'TARGET_UNKNOWN':return '대상이 최신 목록에 없어요. 대상을 다시 골라 주세요.';
  case 'IDEMPOTENCY_CONFLICT':return '같은 요청 번호로 다른 내용이 이미 등록됐어요. 미리보기를 다시 눌러 주세요.';
  case 'DISABLED':return '지시 기능이 꺼져 있어요. 오늘 카드의 “Paseo로 직접 이어가기”를 써 주세요.';
  case 'CROSS_SITE':return '보안 확인에 실패했어요. 이 페이지를 새로 열어 주세요.';
  default:return '보내지 못했어요. 연결을 확인하고 다시 보내 주세요. 다시 보내도 한 번만 등록돼요.';
 }
}

export function InstructionsPanel({targets,showList,request}:{targets:InstructionTarget[];showList:boolean;request:{target:string;nonce:number}|null}){
 const [info,setInfo]=useState<Info|null>(null),[access,setAccess]=useState<Access>('loading'),[now,setNow]=useState(0);
 const [open,setOpen]=useState(false),[step,setStep]=useState<'edit'|'preview'>('edit');
 const [text,setText]=useState(''),[target,setTarget]=useState(''),[endLevel,setEndLevel]=useState('');
 const [key,setKey]=useState<string|null>(null),[sending,setSending]=useState(false),[formError,setFormError]=useState(''),[notice,setNotice]=useState('');
 const [cancelling,setCancelling]=useState<string|null>(null),[expanded,setExpanded]=useState(false);
 const [seenNonce,setSeenNonce]=useState<number|null>(null);
 const busy=useRef(false),pending=useRef<AbortController|null>(null);
 // "이 항목으로 지시": open the composer with the verified target (state adjusted during render, not in an effect).
 if(request&&request.nonce!==seenNonce){
  setSeenNonce(request.nonce);
  if(targets.some(t=>t.value===request.target)){setTarget(request.target);setKey(null);setStep('edit');setFormError('');setOpen(true);}
 }
 const clearDraft=useCallback(()=>{setText('');setTarget('');setEndLevel('');setKey(null);setStep('edit');setOpen(false);setFormError('');},[]);
 // force: after a cancel/send, replace any in-flight read so the list reflects the change.
 const load=useCallback(async(force=false)=>{
  if(pending.current&&!force)return;
  pending.current?.abort();
  const controller=new AbortController();pending.current=controller;const timeout=setTimeout(()=>controller.abort(),12000);
  try{
   const r=await fetch('/api/instructions',{cache:'no-store',signal:controller.signal});
   const body=await r.json().catch(()=>({})) as Info&{error?:string};
   if(pending.current!==controller)return;
   setNow(Date.now());
   if(r.status===401||r.status===403||r.redirected){clearDraft();setInfo(null);setAccess('denied');return;}
   if(!r.ok){setAccess(a=>a==='ok'?'ok':'error');return;}
   setInfo(body);setAccess('ok');
  }catch{if(pending.current===controller)setAccess(a=>a==='ok'?'ok':'error');}
  finally{clearTimeout(timeout);if(pending.current===controller)pending.current=null;}
 },[clearDraft]);
 useEffect(()=>{
  const first=setTimeout(()=>void load(),0);
  const tick=()=>{if(document.visibilityState==='visible')void load();};
  const timer=setInterval(tick,30000);
  document.addEventListener('visibilitychange',tick);window.addEventListener('online',tick);
  return()=>{clearTimeout(first);clearInterval(timer);pending.current?.abort();pending.current=null;document.removeEventListener('visibilitychange',tick);window.removeEventListener('online',tick);};
 },[load]);
 const enabled=!!info?.enabled;
 const chars=codePoints(text.trim());
 const targetLabel=(value:string|null)=>value?targets.find(t=>t.value===value)?.label??value:'지정 없음';
 function edit(change:()=>void){change();setKey(null);setFormError('');}
 function preview(){
  if(!text.trim()){setFormError('지시할 내용을 적어 주세요.');return;}
  if(chars>MAX_CHARS){setFormError(errorMessage('TEXT_TOO_LONG'));return;}
  if(target&&!targets.some(t=>t.value===target)){setFormError(errorMessage('TARGET_UNKNOWN'));return;}
  setKey(k=>k??newKey());setFormError('');setStep('preview');
 }
 async function send(){
  if(busy.current||!key)return;busy.current=true;setSending(true);setFormError('');
  try{
   const r=await fetch('/api/instructions',{method:'POST',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify({text,idempotencyKey:key,...(target?{target}:{}),...(endLevel?{endLevel}:{})})});
   const body=await r.json().catch(()=>({})) as {item?:InstructionItem;error?:string;window?:string};
   if(r.status===401||(r.status===403&&authErrors.has(body.error??''))){clearDraft();setInfo(null);setAccess('denied');return;}
   if(r.ok&&body.item){clearDraft();await load(true);setNotice('보냈어요. Mac이 가져가면 아래 목록에서 진행을 볼 수 있어요.');return;}
   if(body.error==='IDEMPOTENCY_CONFLICT'){setKey(null);setStep('edit');}
   setFormError(errorMessage(body.error,body));
  }catch{setFormError(errorMessage(undefined));}
  finally{busy.current=false;setSending(false);}
 }
 async function cancel(id:string){
  if(cancelling)return;setCancelling(id);
  try{
   const r=await fetch('/api/instructions/'+id+'/cancel',{method:'POST',cache:'no-store',headers:{'content-type':'application/json'},body:'{}'});
   if(r.status===401||r.status===403){const b=await r.json().catch(()=>({})) as {error?:string};if(authErrors.has(b.error??'')){clearDraft();setInfo(null);setAccess('denied');return;}}
   await load(true);
   setNotice(r.ok?'취소했어요.':r.status===409?'이미 Mac이 가져가서 취소할 수 없어요. 실행 세션에서 멈춰 주세요.':'취소하지 못했어요. 다시 시도해 주세요.');
  }catch{setNotice('취소하지 못했어요. 연결을 확인해 주세요.');}
  finally{setCancelling(null);}
 }
 const items=info?.items??[];
 const shown=expanded?items:items.slice(0,3);
 return <>
  {showList&&<section className="monitor-section instructions-panel" aria-label="작업 지시">
   <div className="section-heading"><div><h2>작업 지시</h2><p className="muted">{access==='ok'&&info?(!info.enabled?'지시 기능 꺼짐 · 서버 스위치가 켜지면 보낼 수 있어요':info.macOnline?'Mac 연결됨 · '+(info.macReady?.ready?'바로 가져갈 수 있어요':waitingReason(info)):'Mac 대기 중(Mac 꺼짐·연결 끊김) · 보내 두면 Mac이 켜질 때 가져가요'):access==='denied'?'로그인이 필요해요. 사이트를 다시 열어 주세요':access==='error'?'지시 목록을 불러오지 못했어요':'지시 목록을 불러오는 중이에요…'}</p></div>
    <button type="button" className="instruct-button" disabled={access!=='ok'} onClick={()=>{setOpen(true);setNotice('');}}><Send size={15}/> 지시하기</button></div>
   {notice&&<p className="instruction-notice" role="status">{notice}</p>}
   {access==='ok'&&<ul className="instruction-list">{shown.map(item=><li key={item.id} className={'instruction-item '+item.status}>
    <div className="instruction-head"><span className={'instruction-badge '+item.status+(badge(item,info!,now).startsWith('지연')?' delayed':'')}>{badge(item,info!,now)}</span><span className="instruction-time">{item.status==='running'||item.status==='claimed'?'실행 '+ago(item.started_at??item.claimed_at,now)+'째':ago(item.created_at,now)+(ago(item.created_at,now)==='방금'?'':' 전')}</span></div>
    <p className="instruction-text">{item.text}</p>
    {(item.target||item.end_level)&&<p className="instruction-meta">{item.target&&<>대상 {targetLabel(item.target)}</>}{item.target&&item.end_level&&' · '}{item.end_level&&<>끝 {END_LEVEL_LABELS[item.end_level]??item.end_level}</>}</p>}
    {item.status==='running'&&item.started_at&&now-Date.parse(item.started_at)>info!.delayAfterMinutes*60000&&<p className="instruction-note">{info!.delayAfterMinutes}분이 넘었어요. Paseo에서 세션 {item.session_name??'(이름 없음)'}을 확인해 주세요. 실행 중이라 자리를 계속 차지해요.</p>}
    {item.status==='needs_user'&&<><p className="instruction-question">답 필요: {item.question??'(질문 없음)'}</p><p className="instruction-note">Paseo에서 세션 {item.session_name??'(이름 없음)'}을 열어 답하세요</p></>}
    {item.status==='failed'&&<p className="instruction-note">{ERROR_LABELS[item.error_code??'']??'실패했어요'}</p>}
    {['claimed','running','done','failed'].includes(item.status)&&item.session_name&&<p className="instruction-session">세션 {item.session_name}</p>}
    {item.status==='expired'&&<p className="instruction-note">Mac이 24시간 안에 가져가지 않았어요. 필요하면 다시 지시해 주세요.</p>}
    {item.summary&&<p className="instruction-summary">{item.summary}</p>}
    {item.status==='queued'&&<button type="button" className="instruction-cancel" disabled={cancelling===item.id} onClick={()=>void cancel(item.id)}>{cancelling===item.id?'취소하는 중…':'대기 취소'}</button>}
   </li>)}{!items.length&&<li className="muted instruction-empty">아직 보낸 지시가 없어요.</li>}</ul>}
   {items.length>3&&<button type="button" className="text-button instruction-more" onClick={()=>setExpanded(v=>!v)}>{expanded?'최근 3개만 보기':'지시 '+items.length+'개 모두 보기'}</button>}
  </section>}
  {open&&access==='ok'&&<div className="instruction-backdrop"><section role="dialog" aria-modal="true" aria-label="지시하기" className="instruction-sheet">
   <button type="button" className="close" onClick={()=>setOpen(false)} aria-label="지시 창 닫기"><X size={20}/></button>
   <h2>{step==='edit'?'지시하기':'이대로 보낼까요?'}</h2>
   {!enabled&&<p className="notice" role="note">지시 기능이 꺼져 있어요(서버 스위치). 켜지기 전에는 오늘 카드의 “Paseo로 직접 이어가기”로 요청을 복사해 쓸 수 있어요.</p>}
   {step==='edit'?<div className="instruction-form">
    <label htmlFor="instruction-text">무엇을 할까요? <small>(필수)</small></label>
    <textarea id="instruction-text" value={text} disabled={!enabled} rows={6} placeholder="예: 레몬젤리 릴스 캡션 초안을 두 가지로 써 줘" onChange={e=>{const v=e.target.value;edit(()=>setText(v));}}/>
    <p className={'instruction-count'+(chars>MAX_CHARS?' over':'')}>{chars.toLocaleString('ko-KR')} / {MAX_CHARS.toLocaleString('ko-KR')}자</p>
    <label htmlFor="instruction-target">대상 <small>(선택)</small></label>
    <select id="instruction-target" value={target} disabled={!enabled} onChange={e=>{const v=e.target.value;edit(()=>setTarget(v));}}><option value="">지정 없음</option>{targets.map(t=><option key={t.value} value={t.value}>{t.label}</option>)}</select>
    <label htmlFor="instruction-end">끝 수준 <small>(선택)</small></label>
    <select id="instruction-end" value={endLevel} disabled={!enabled} onChange={e=>{const v=e.target.value;edit(()=>setEndLevel(v));}}><option value="">지정 없음</option>{Object.entries(END_LEVEL_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select>
    {formError&&<p className="instruction-error" role="alert">{formError}</p>}
    <div className="instruction-actions"><button type="button" className="instruct-secondary" onClick={()=>setOpen(false)}>닫기(내용 유지)</button><button type="button" className="instruct-button" disabled={!enabled||!text.trim()||chars>MAX_CHARS} onClick={preview}>미리보기</button></div>
   </div>:<div className="instruction-preview">
    <p className="instruction-preview-text">{text.trim()}</p>
    <dl><dt>대상</dt><dd>{targetLabel(target||null)}</dd><dt>끝 수준</dt><dd>{endLevel?END_LEVEL_LABELS[endLevel]:'지정 없음'}</dd><dt>Mac</dt><dd>{info?(info.macOnline&&info.macReady?.ready?'연결됨 · 바로 가져갈 수 있어요':'대기 예정 · '+waitingReason(info)):'확인 전'}</dd></dl>
    <p className="muted">Mac이 가져가면 Paseo에서 에이전트가 실행돼요. push·배포·게시·업로드·삭제는 하지 않고 준비물까지만 만든 뒤 알려 줘요. 대기 중에는 취소할 수 있어요.</p>
    {formError&&<p className="instruction-error" role="alert">{formError}</p>}
    <div className="instruction-actions"><button type="button" className="instruct-secondary" disabled={sending} onClick={()=>{setStep('edit');setFormError('');}}>고치기</button><button type="button" className="instruct-button" disabled={sending||!enabled} aria-busy={sending} onClick={()=>void send()}>{sending?<Loader2 size={15} className="spinning"/>:<Send size={15}/>} {sending?'보내는 중…':'보내기'}</button></div>
   </div>}
  </section></div>}
 </>;
}
