import {readInline,inlineSource,cssHex,plainText as plain,restyle,type InlineRun,type InlineStyle,type CanonicalFinding} from "./canonical-blog";
import type {ParagraphNode} from "./blog-markup";
export function paragraphSource(p:ParagraphNode):string{
 const runs:InlineRun[]=[];
 p.lines.forEach((line,i)=>{
  if(i)runs.push({text:"\n",style:{}});
  let at=0;
  for(const m of p.marks.filter(m=>m.line===i).sort((a,b)=>a.start-b.start)){
   if(m.start>at)runs.push({text:line.slice(at,m.start),style:{}});
   runs.push({text:line.slice(m.start,m.end),style:m.style});at=m.end;
  }
  if(at<line.length)runs.push({text:line.slice(at),style:{}});
 });
 return inlineSource(runs);
}
/** Paragraph a finding targets. */
export const findingTarget=(f:Pick<CanonicalFinding,"proposal">)=>f.proposal?.tid??f.proposal?.entry?.id;
/** Review entries call the background `bg`; inline styles call it `background`. */
export function entryStyle({bg,...rest}:{color?:string;bg?:string;weight?:number;size?:number}):InlineStyle{
 return {...rest,...(bg?{background:bg}:{})};
}
const normalized=(style:InlineStyle)=>{
 const color=(s?:string)=>s?cssHex(s):undefined;
 return {color:color(style.color),background:color(style.background),weight:style.weight,size:style.size};
};
function styles(source:string){
 return readInline(source).flatMap(r=>Array.from({length:r.text.length},()=>normalized(r.style)));
}
function occurrence(text:string,phrase:string){
 const start=text.indexOf(phrase);
 return start<0?-1:text.indexOf(phrase,start+1)>=0?-2:start;
}
export type Applicability={state:"available"|"applied"|"changed"|"ambiguous"|"unsupported";reason:string;canApply:boolean};
const result=(state:Applicability["state"],reason:string):Applicability=>({state,reason,canApply:state==="available"});
export function findingApplicability(f:CanonicalFinding,source?:string):Applicability{
 const p=f.proposal;
 if(!source||!p)return result("unsupported","대상 문단을 찾을 수 없어요.");
 const text=plain(source);
 if(p.layer==="text"&&p.before&&p.after!==undefined){
  const start=occurrence(text,p.before),after=p.after?occurrence(text,p.after):-1;
  if(after>=0&&(start===-1||(p.after.includes(p.before)&&start===after+p.after.indexOf(p.before))))
   return result("applied","이미 본문에 반영된 제안이에요.");
  if(start===-2)return result("ambiguous","대상 구절이 여러 곳에 있어요. 본문에서 직접 선택해주세요.");
  if(start<0)return result("changed","제안이 바꾸려는 문장이 달라졌어요. 다시 검토해주세요.");
  return result("available","대상 문장이 그대로라 적용할 수 있어요.");
 }
 if(p.layer==="emphasis"&&p.entry){
  const e=p.entry,start=occurrence(text,e.phrase);
  if(start===-2)return result("ambiguous","대상 구절이 여러 곳에 있어요. 본문에서 직접 선택해주세요.");
  if(start<0)return result("changed","강조할 구절이 달라졌어요. 다시 검토해주세요.");
  const desired=normalized(entryStyle(e.style));
  const keys=(p.op==="remove"?["color","background","weight","size"]:Object.keys(desired).filter(k=>desired[k as keyof InlineStyle]!==undefined)) as (keyof InlineStyle)[];
  if(!keys.length)return result("unsupported","적용할 서식이 없어요.");
  const current=styles(source).slice(start,start+e.phrase.length);
  if(current.every(s=>keys.every(k=>s[k]===(p.op==="remove"?undefined:desired[k]))))
   return result("applied","이미 같은 서식이 반영돼 있어요.");
  if(!f.sourceAtReview)return result("changed","검토 당시 대상 서식을 확인할 수 없어 다시 검토가 필요해요.");
  const baseStart=occurrence(plain(f.sourceAtReview),e.phrase);
  if(baseStart<0)return result("changed","검토 당시 대상 구절을 확인할 수 없어요.");
  const before=styles(f.sourceAtReview).slice(baseStart,baseStart+e.phrase.length);
  if(!current.every((s,i)=>keys.every(k=>s[k]===before[i]?.[k])))
   return result("changed","제안이 바꾸려는 서식을 직접 수정하셨어요. 현재 서식을 유지하며 잠갔어요.");
  return result("available","대상 구절과 변경할 서식이 그대로라 적용할 수 있어요.");
 }
 return result("unsupported","이 제안은 본문에서 직접 수정해주세요.");
}
/** Apply a text or emphasis proposal to an inline source; throws when the target no longer matches. */
export function applyFinding(f:CanonicalFinding,source:string):string{
 const p=f.proposal,text=plain(source);
 if(p?.layer==="emphasis"&&p.entry){
  const start=text.indexOf(p.entry.phrase);
  if(start<0)throw new Error("강조할 구절이 바뀌었어요.");
  return restyle(source,start,start+p.entry.phrase.length,entryStyle(p.entry.style),p.op==="remove");
 }
 if(p?.layer==="text"&&p.before&&p.after!==undefined){
  const start=text.indexOf(p.before);
  if(start<0||text.indexOf(p.before,start+1)>=0)
   throw new Error("제안 대상이 바뀌었거나 여러 곳에 있어요. 본문에서 직접 수정해주세요.");
  return replaceInlineText(source,start,start+p.before.length,p.after);
 }
 throw new Error("이 제안은 본문에서 직접 수정해주세요.");
}
/** Preserve styles of unchanged characters when inserting text (for example list check marks). */
export function replaceInlineText(source:string,start:number,end:number,replacement:string){
 const runs=readInline(source),text=runs.map(r=>r.text).join("");
 const originalStyles=runs.flatMap(r=>Array.from({length:r.text.length},()=>r.style));
 const old=text.slice(start,end),n=old.length,m=replacement.length;
 if((n+1)*(m+1)>2_000_000)throw new Error("제안 범위가 너무 길어요. 작은 구간으로 나눠주세요.");
 const lcs=Array.from({length:n+1},()=>new Uint32Array(m+1));
 for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)lcs[i][j]=old[i]===replacement[j]?1+lcs[i+1][j+1]:Math.max(lcs[i+1][j],lcs[i][j+1]);
 const mapping:Array<number|undefined>=Array(m);let i=0,j=0;
 while(i<n&&j<m){if(old[i]===replacement[j]){mapping[j++]=start+i++;}else if(lcs[i+1][j]>=lcs[i][j+1])i++;else j++;}
 const out:InlineRun[]=[];const add=(text:string,style:InlineStyle)=>{if(!text)return;const last=out.at(-1);if(last&&JSON.stringify(last.style)===JSON.stringify(style))last.text+=text;else out.push({text,style});};
 for(let k=0;k<start;k++)add(text[k],originalStyles[k]);
 for(let k=0;k<m;k++)add(replacement[k],mapping[k]===undefined?{}:originalStyles[mapping[k]!]);
 for(let k=end;k<text.length;k++)add(text[k],originalStyles[k]);
 return inlineSource(out);
}
