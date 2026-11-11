import {useEffect,useState} from "react";
import type {BlogAnnotation} from "../../../shared/blog-annotations";
export interface AnnotationTarget {id:string;text:string;context:string;checked:boolean;requestId:string}
async function annotations(input?:unknown):Promise<BlogAnnotation[]>{
  const response=await fetch("/api/blog/annotations",input?{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)}:undefined);
  const value=await response.json();if(!response.ok)throw new Error(value.error??"주석을 저장하지 못했어요.");return value;
}
/** My private phrase notes (색·메모·체크). The panel tab shows the count, so this pane has no title of its own. */
export function UserAnnotations({target,revision,onClose,onJump,onChanged,onCount}:{target?:AnnotationTarget;revision:string;onClose:()=>void;onJump:(id:string)=>void;onChanged:()=>void;onCount?:(count:number)=>void}){
  const [items,setItems]=useState<BlogAnnotation[]>([]),[note,setNote]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false);
  useEffect(()=>{annotations().then(setItems).catch(e=>setError(String(e)));},[revision]);
  useEffect(()=>{setNote("");setError("");},[target?.requestId]);
  useEffect(()=>{onCount?.(items.length);},[items.length]);
  async function add(){
    if(!target)return;setBusy(true);setError("");
    try{setItems(await annotations({action:"add",id:target.requestId,paragraphId:target.id,quote:target.text,context:target.context,note,checked:target.checked}));onChanged();onClose();}
    catch(e){setError(String(e));}finally{setBusy(false);}
  }
  return <section className="ce-user-annotations" aria-label="내 주석">
    {target&&<form className="ce-annotation-form" onSubmit={e=>{e.preventDefault();void add();}}>
      <blockquote>{target.text}</blockquote>
      <label>구절 메모<textarea autoFocus key={target.requestId} aria-label="구절 메모" value={note} onChange={e=>setNote(e.target.value)} placeholder={target.checked?"체크한 이유를 적어도 좋아요":"여기에 바꾸고 싶은 점을 적으세요"} maxLength={4000}/></label>
      <div className="ce-annotation-actions">
        <button className="secondary small" disabled={busy||(!target.checked&&!note.trim())} type="submit">{target.checked?"체크 저장":"메모 저장"}</button>
        <button className="small" disabled={busy} type="button" onClick={onClose}>취소</button>
      </div>
    </form>}
    {error&&<p role="alert" className="ce-annotation-error">{error}</p>}
    {items.map(item=><article key={item.id}>
      <blockquote>{item.quote}</blockquote>
      {item.note&&<p>{item.note}</p>}
      <div className="ce-annotation-actions">
        <label className="ui-check"><input type="checkbox" aria-label={item.quote+" 확인 완료"} checked={item.checked} disabled={busy} onChange={async e=>{const checked=e.target.checked;setItems(old=>old.map(a=>a.id===item.id?{...a,checked}:a));setBusy(true);setError("");try{setItems(await annotations({action:"check",id:item.id,checked}));onChanged();}catch(err){setItems(old=>old.map(a=>a.id===item.id?item:a));setError(String(err));}finally{setBusy(false);}}}/> 확인 완료</label>
        <button className="small" onClick={()=>onJump(item.paragraphId)}>구절로 이동</button>
      </div>
      {!item.fresh&&<small>본문이 달라졌거나 아직 저장 전인 구절이에요.</small>}
    </article>)}
    {!items.length&&!target&&<p className="ui-meta">본문에서 구절을 고른 뒤 메모·✓ 체크를 누르면 여기에 모여요.</p>}
  </section>;
}
