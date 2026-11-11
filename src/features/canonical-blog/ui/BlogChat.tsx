import {useEffect,useRef,useState} from "react";
import {CHAT_LIMITS,type BlogChatResponse,type BlogChatRewrite} from "../../../shared/blog-chat";

/** A phrase the writer dragged and attached with `채팅에 추가`. */
export interface ChatAttachment{key:string;paragraphId:string;quote:string}
interface Turn{
  id:string;role:"user"|"assistant";text:string;
  /** Attachments sent with this question (user turns only). */
  attachments?:ChatAttachment[];
  rewrites?:Array<BlogChatRewrite&{state?:"applied"|"failed";message?:string}>;
  memo?:"saved"|"failed";
}
const clip=(text:string,limit:number)=>text.length>limit?text.slice(0,limit)+"…":text;

/**
 * Selection chat. Answers and rewrites stay on this screen only (not saved). A rewrite
 * reaches the manuscript through `onApply` (the normal edit path, saved explicitly);
 * `메모로 남기기` stores the answer as a private annotation on the attached phrase.
 */
export function BlogChat({attachments,revision,bundleId,disabled,focusToken,sourceOf,plainOf,onRemove,onSent,onApply,onMemo,onJump}:{
  attachments:ChatAttachment[];revision:string;bundleId?:string;disabled:boolean;
  /** Changes when a phrase is attached so the question box takes focus. */
  focusToken:string;
  sourceOf:(paragraphId:string)=>string|undefined;
  plainOf:(paragraphId:string)=>string|undefined;
  onRemove:(key:string)=>void;
  /** The question with these attachments was answered; detach them from the next question. */
  onSent:(keys:string[])=>void;
  onApply:(rewrite:BlogChatRewrite)=>string|undefined;
  onMemo:(input:{paragraphId:string;quote:string;context:string;note:string})=>Promise<void>;
  onJump:(paragraphId:string)=>void;
}){
  const [turns,setTurns]=useState<Turn[]>([]),[question,setQuestion]=useState(""),[error,setError]=useState(""),[pending,setPending]=useState(false);
  const controller=useRef<AbortController|null>(null);
  const box=useRef<HTMLTextAreaElement>(null);
  const log=useRef<HTMLOListElement>(null);
  // After the parent's effects: on narrow screens opening the panel first focuses its close
  // button (and remembers the frame as the place to return to); then the question box wins.
  useEffect(()=>{
    if(!focusToken)return;
    const id=requestAnimationFrame(()=>box.current?.focus());
    return ()=>cancelAnimationFrame(id);
  },[focusToken]);
  useEffect(()=>()=>controller.current?.abort(),[]);
  useEffect(()=>{const el=log.current;if(el)el.scrollTop=el.scrollHeight;},[turns.length,pending]);

  async function ask(){
    const text=question.trim();
    if(!text||pending||disabled)return;
    const sent=attachments.filter(a=>sourceOf(a.paragraphId)!==undefined);
    const history=turns.slice(-CHAT_LIMITS.history).map(t=>({role:t.role,text:clip(t.text,CHAT_LIMITS.turn-1)}));
    const user:Turn={id:crypto.randomUUID(),role:"user",text,attachments:sent};
    setTurns(old=>[...old,user]);setQuestion("");setError("");setPending(true);
    const c=new AbortController();controller.current=c;
    try{
      const r=await fetch("/api/blog/chat",{method:"POST",headers:{"Content-Type":"application/json"},signal:c.signal,body:JSON.stringify({
        requestId:user.id,revision,bundleId,history,question:text,
        attachments:sent.map(a=>({paragraphId:a.paragraphId,quote:a.quote,source:sourceOf(a.paragraphId)!})),
      })});
      const value=await r.json();
      if(!r.ok)throw new Error(value.error??"답변을 받지 못했어요.");
      const body=value as BlogChatResponse;
      setTurns(old=>[...old,{id:crypto.randomUUID(),role:"assistant",text:body.reply||"고칠 문장을 제안했어요.",rewrites:body.rewrites}]);
      onSent(sent.map(a=>a.key));
    }catch(e){
      if(c.signal.aborted)setError("질문을 취소했어요.");
      else setError(e instanceof Error?e.message:String(e));
      // Keep the question (attachments stay attached) so the writer can resend it.
      setTurns(old=>old.filter(t=>t.id!==user.id));setQuestion(q=>q||text);
    }finally{
      if(controller.current===c)controller.current=null;
      setPending(false);
    }
  }

  function apply(turnId:string,index:number){
    const turn=turns.find(t=>t.id===turnId),rewrite=turn?.rewrites?.[index];
    if(!rewrite||rewrite.state==="applied")return;
    const failure=onApply(rewrite);
    setTurns(old=>old.map(t=>t.id!==turnId?t:{...t,rewrites:t.rewrites!.map((r,i)=>i!==index?r:{...r,state:failure?"failed":"applied",message:failure})}));
  }
  async function memo(turnId:string){
    const at=turns.findIndex(t=>t.id===turnId),answer=turns[at],asked=turns[at-1];
    const target=asked?.attachments?.[0];
    if(!answer||!target)return;
    const context=plainOf(target.paragraphId);
    if(context===undefined||!context.includes(target.quote)){
      setTurns(old=>old.map(t=>t.id===turnId?{...t,memo:"failed"}:t));
      setError("구절이 본문에서 바뀌어 메모로 남기지 못했어요.");return;
    }
    try{
      await onMemo({paragraphId:target.paragraphId,quote:target.quote,context,note:clip("Q. "+asked.text+"\nA. "+answer.text,3990)});
      setTurns(old=>old.map(t=>t.id===turnId?{...t,memo:"saved"}:t));
    }catch(e){
      setTurns(old=>old.map(t=>t.id===turnId?{...t,memo:"failed"}:t));
      setError(e instanceof Error?e.message:String(e));
    }
  }

  return <section className="ce-chat" aria-label="구절 채팅">
    {turns.length>0&&<div className="ce-chat-head"><button type="button" className="small ce-chat-reset" disabled={pending} onClick={()=>{setTurns([]);setError("");}}>새 대화</button></div>}
    {!turns.length&&<p className="ui-meta ce-chat-help">구절을 고르고 채팅에 추가하면 물어볼 수 있어요. 본문에 반영해야 원고가 바뀌어요.</p>}
    {turns.length>0&&<ol className="ce-chat-log" ref={log} aria-live="polite">
      {turns.map((t,i)=><li key={t.id} className={"ce-chat-turn is-"+t.role}>
        {t.attachments?.map(a=><blockquote key={a.key}><button type="button" className="ce-chat-jump" onClick={()=>onJump(a.paragraphId)} aria-label={`${a.paragraphId} 구절로 이동`}>{a.paragraphId}</button> {clip(a.quote,160)}</blockquote>)}
        <p>{t.text}</p>
        {t.rewrites?.map((r,j)=><div key={j} className="ce-chat-rewrite">
          <p><del>{clip(r.quote,200)}</del> → <ins>{r.replacement?clip(r.replacement,400):"(삭제)"}</ins></p>
          <button type="button" className="secondary small" disabled={disabled||r.state==="applied"} onClick={()=>apply(t.id,j)}>{r.state==="applied"?"반영됨":"본문에 반영"}</button>
          {r.state==="failed"&&<small role="alert">{r.message}</small>}
        </div>)}
        {t.role==="assistant"&&turns[i-1]?.attachments?.length?<button type="button" className="small ce-chat-memo" disabled={t.memo==="saved"} onClick={()=>void memo(t.id)}>{t.memo==="saved"?"메모로 남김":"답변을 메모로 남기기"}</button>:null}
      </li>)}
      {pending&&<li className="ce-chat-turn is-assistant is-pending" role="status"><span className="ui-spinner" aria-hidden="true"/>답변을 기다리는 중… <button type="button" className="small" onClick={()=>controller.current?.abort()}>취소</button></li>}
    </ol>}
    {error&&<p role="alert" className="ce-chat-error">{error}</p>}
    <form onSubmit={e=>{e.preventDefault();void ask();}}>
      {attachments.length>0&&<ul className="ce-chat-chips" aria-label="첨부한 구절">
        {attachments.map(a=><li key={a.key}><span title={a.quote}>{a.paragraphId} · {clip(a.quote,40)}</span><button type="button" aria-label={`첨부 해제: ${clip(a.quote,40)}`} onClick={()=>onRemove(a.key)}>×</button></li>)}
      </ul>}
      <textarea ref={box} aria-label="채팅 질문" value={question} maxLength={CHAT_LIMITS.question} rows={3}
        placeholder={attachments.length?"이 구절에 대해 물어보세요 (예: 더 자연스럽게 바꿔줘)":"구절을 첨부하거나 이 묶음에 대해 물어보세요"}
        onChange={e=>setQuestion(e.target.value)}
        onKeyDown={e=>{
          if(e.nativeEvent.isComposing||e.keyCode===229)return;
          if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();void ask();}
          if(e.key==="Escape"&&pending){e.preventDefault();e.stopPropagation();controller.current?.abort();}
        }}/>
      <div className="ce-chat-actions">
        <small className="ui-meta">Enter 보내기 · Shift+Enter 줄바꿈</small>
        <button type="submit" className="secondary small" disabled={disabled||pending||!question.trim()}>{pending?"답변 중…":"보내기"}</button>
      </div>
    </form>
  </section>;
}
