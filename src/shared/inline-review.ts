/**
 * In-manuscript review planning.
 *
 * Turns stored review findings into transient, review-only descriptors that the
 * editor frame renders next to the target paragraph. Nothing here writes to the
 * manuscript: descriptors only carry offsets/diffs computed from the current
 * (possibly unsaved) paragraph source. Applying still goes through the editor's
 * explicit apply path, which re-validates against the newest source.
 */
import {readInline,restyle,type CanonicalDocument,type CanonicalFinding,type CanonicalReview,type InlineRun,type InlineStyle} from "./canonical-blog";
import {findingApplicability,type Applicability} from "./review-applicability";

export type DiffSegment={type:"equal"|"del"|"ins";text:string};
export type InlineProposalKind="text"|"format"|"note";
export interface InlineProposal{
  /** Stable key for this screen: the finding id, prefixed with the bundle only when ids collide across reviews. */
  id:string;
  findingId:string;
  bundleId:string;
  kind:InlineProposalKind;
  /** Target paragraph when the finding names one that exists in the document. */
  paragraphId?:string;
  axis?:string;
  severity?:string;
  observation:string;
  state:Applicability["state"]|"decided"|"note";
  canApply:boolean;
  reason:string;
  decision?:string;
  /** Plain-text offsets in the current paragraph; only set when the target is uniquely located. */
  start?:number;
  end?:number;
  phrase?:string;
  /** Absolute plain-text ranges to strike through in place. */
  deleted?:Array<[number,number]>;
  segments?:DiffSegment[];
  before?:string;
  after?:string;
  format?:{before:InlineRun[];after:InlineRun[];beforeLabel:string;afterLabel:string};
  /** Other proposals whose target range overlaps this one in the same paragraph. */
  overlaps?:string[];
  /**
   * Content fingerprint of the finding. The frame echoes the one it displayed so
   * an apply/keep click is refused when polling replaced the finding meanwhile.
   */
  sig:string;
}

/** Fingerprint of what a finding proposes; ids alone can be reused by a re-review. */
export function proposalSignature(f:CanonicalFinding){
  const p=f.proposal;
  return JSON.stringify(p?[p.layer,p.tid??null,p.before??null,p.after??null,p.op??null,p.entry??null]:["note",f.observation]);
}

const plainOf=(source:string)=>readInline(source).map(r=>r.text).join("");
/** Word-ish tokens: runs of letters/digits stay together, everything else is one char. */
function tokens(text:string){return text.match(/[\p{L}\p{N}]+|[^\p{L}\p{N}]/gu)??[];}
function push(out:DiffSegment[],type:DiffSegment["type"],text:string){
  if(!text)return;const last=out.at(-1);
  if(last?.type===type)last.text+=text;else out.push({type,text});
}
const graphemeSegmenter=typeof Intl!=="undefined"&&typeof Intl.Segmenter==="function"?new Intl.Segmenter(undefined,{granularity:"grapheme"}):undefined;
/** User-perceived characters, so prefix/suffix refinement never splits an emoji or surrogate pair. */
function chars(text:string){return graphemeSegmenter?Array.from(graphemeSegmenter.segment(text),s=>s.segment):Array.from(text);}
/** Token-level LCS diff, refined to shared prefixes/suffixes inside a replaced word. */
export function diffSegments(before:string,after:string):DiffSegment[]{
  const a=tokens(before),b=tokens(after),n=a.length,m=b.length;
  if((n+1)*(m+1)>1_000_000)return [{type:"del",text:before},{type:"ins",text:after}].filter(s=>s.text) as DiffSegment[];
  const lcs=Array.from({length:n+1},()=>new Uint32Array(m+1));
  for(let i=n-1;i>=0;i--)for(let j=m-1;j>=0;j--)lcs[i][j]=a[i]===b[j]?lcs[i+1][j+1]+1:Math.max(lcs[i+1][j],lcs[i][j+1]);
  const out:DiffSegment[]=[];let i=0,j=0,del="",ins="";
  // Each changed stretch between equal tokens becomes one deletion + one
  // insertion; their shared prefix/suffix stays as context, so
  // "쉬었어요"→"쉬었다" only marks the changed ending.
  const flush=()=>{
    const d=chars(del),s=chars(ins);
    let p=0;while(p<d.length&&p<s.length&&d[p]===s[p])p++;
    let q=0;while(q<d.length-p&&q<s.length-p&&d[d.length-1-q]===s[s.length-1-q])q++;
    push(out,"equal",d.slice(0,p).join(""));push(out,"del",d.slice(p,d.length-q).join(""));
    push(out,"ins",s.slice(p,s.length-q).join(""));push(out,"equal",d.slice(d.length-q).join(""));
    del="";ins="";
  };
  while(i<n||j<m){
    if(i<n&&j<m&&a[i]===b[j]){flush();push(out,"equal",a[i]);i++;j++;}
    else if(i<n&&(j===m||lcs[i+1][j]>=lcs[i][j+1])){del+=a[i];i++;}
    else{ins+=b[j];j++;}
  }
  flush();
  return out;
}
function deletedRanges(segments:DiffSegment[],start:number):Array<[number,number]>{
  const out:Array<[number,number]>=[];let at=start;
  for(const s of segments){
    if(s.type==="ins")continue;
    if(s.type==="del")out.push([at,at+s.text.length]);
    at+=s.text.length;
  }
  return out;
}
/** Plain-text spans of rendered links ('[label](https://…)'), matching inlineHtml(). */
function linkSpans(source:string):Array<[number,number]>{
  const out:Array<[number,number]>=[];let at=0;
  for(const r of readInline(source)){
    for(const m of r.text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g))out.push([at+m.index!,at+m.index!+m[0].length]);
    at+=r.text.length;
  }
  return out;
}
const cutsLink=(links:Array<[number,number]>,start:number,end:number)=>links.some(([a,b])=>start<b&&a<end&&(start>a||end<b));
function unique(text:string,phrase:string){
  const start=text.indexOf(phrase);
  return start<0||text.indexOf(phrase,start+1)>=0?undefined:start;
}
function sample(source:string,start:number,end:number):InlineRun[]{
  let at=0;
  return readInline(source).flatMap(r=>{
    const lo=Math.max(0,start-at),hi=Math.min(r.text.length,end-at);at+=r.text.length;
    return lo<hi?[{...r,text:r.text.slice(lo,hi)}]:[];
  });
}
const COLOR_NAMES:Record<string,string>={"#333333":"기본색","#a64132":"적갈색","#85613f":"갈색","#0096dc":"하늘색","#54b800":"초록","#fff8b2":"노랑","#ffe3c8":"살구","#e2e2e2":"연회색"};
function colorName(value:string|undefined,fallback:string){
  if(!value)return fallback;
  const rgb=value.match(/\d+/g);
  const hex=value.startsWith("#")?value.toLowerCase():rgb?"#"+rgb.slice(0,3).map(n=>Number(n).toString(16).padStart(2,"0")).join(""):value;
  return COLOR_NAMES[hex]??hex;
}
export function describeRuns(runs:InlineRun[],baseSize=16){
  return [...new Set(runs.map(r=>`${r.style.size??baseSize}px · ${r.style.weight===700?"굵게":"보통"} · 글자 ${colorName(r.style.color,"기본색")} · 배경 ${colorName(r.style.background,"없음")}`))].join(" / ");
}
/** Current vs proposed formatting of an emphasis target, as runs that can be rendered with real styles. */
export function formatComparison(f:CanonicalFinding,source:string,baseSize?:number){
  const e=f.proposal?.entry;if(!e)return undefined;
  const start=unique(plainOf(source),e.phrase);if(start===undefined)return undefined;
  const {bg,...style}=e.style;
  const after=restyle(source,start,start+e.phrase.length,{...style,...(bg?{background:bg}:{})} as InlineStyle,f.proposal?.op==="remove");
  const beforeRuns=sample(source,start,start+e.phrase.length),afterRuns=sample(after,start,start+e.phrase.length);
  return {start,before:beforeRuns,after:afterRuns,beforeLabel:describeRuns(beforeRuns,baseSize),afterLabel:describeRuns(afterRuns,baseSize)};
}

const HIDDEN_STATUS=["withdrawn","rejected","obsolete"];
export interface PlanInput{
  doc:Pick<CanonicalDocument,"format"|"paragraphs"|"reviews">;
  edits:Record<string,string>;
  decisions:Record<string,string>;
  /** Bundles changed in this session (legacy reviews lock on these). */
  changed?:string[];
  baseSizes?:Record<string,number|undefined>;
}
/** Legacy (non-markup) reviews keep their bundle-level freshness lock. */
function legacyApplicability(f:CanonicalFinding,review:CanonicalReview,source:string|undefined,changed:string[]):Applicability{
  const p=f.proposal;
  const result=(state:Applicability["state"],reason:string):Applicability=>({state,reason,canApply:state==="available"});
  if(!source||!p)return result("unsupported","대상 문단을 찾을 수 없어요.");
  if(f.fresh===false||!review.freshText||changed.includes(review.bundleId))return result("changed","검토 당시와 문장이 달라요. 이전 제안의 적용은 잠겨 있어요.");
  const phrase=p.layer==="text"?p.before:p.layer==="emphasis"?p.entry?.phrase:undefined;
  if(!phrase)return result("unsupported","이 제안은 본문에서 직접 수정해주세요.");
  const text=plainOf(source),start=text.indexOf(phrase);
  if(start<0)return result("changed","제안이 바꾸려는 문장이 달라졌어요. 다시 검토해주세요.");
  if(text.indexOf(phrase,start+1)>=0)return result("ambiguous","대상 구절이 여러 곳에 있어요. 본문에서 직접 선택해주세요.");
  return result("available","대상 문장이 그대로라 적용할 수 있어요.");
}

/**
 * Build in-manuscript descriptors for every visible finding. Recomputed after
 * each edit/apply so overlapping or same-paragraph proposals are re-validated
 * against the newest source before they can be applied.
 */
export function planInlineProposals({doc,edits,decisions,changed=[],baseSizes={}}:PlanInput):InlineProposal[]{
  const items:InlineProposal[]=[];
  const seen=new Map<string,number>();
  for(const review of doc.reviews)for(const f of review.findings)seen.set(f.id,(seen.get(f.id)??0)+1);
  for(const review of doc.reviews){
    for(const f of review.findings){
      if(HIDDEN_STATUS.includes(f.status??""))continue;
      const id=(seen.get(f.id)??0)>1?`${review.bundleId}:${f.id}`:f.id;
      const p=f.proposal;
      const targetId=p?.tid??p?.entry?.id;
      const paragraph=targetId?doc.paragraphs.find(x=>x.id===targetId):undefined;
      const source=paragraph?edits[paragraph.id]??paragraph.source:undefined;
      const base={id,findingId:f.id,bundleId:review.bundleId,axis:f.axis,severity:f.severity,observation:f.observation,paragraphId:paragraph?.id};
      const actionable=p&&((p.layer==="text"&&p.before&&p.after!==undefined)||(p.layer==="emphasis"&&p.entry));
      if(!actionable){
        // Photo/layout/structure opinions cannot be expressed as a text replacement.
        items.push({...base,sig:proposalSignature(f),kind:"note",state:decisions[id]?"decided":"note",canApply:false,decision:decisions[id],reason:"본문 교체로 적용할 수 없는 의견이에요. 내용을 확인하고 직접 판단해주세요."});
        continue;
      }
      const kind:InlineProposalKind=p!.layer==="text"?"text":"format";
      const availability=doc.format==="markup"?findingApplicability(f,source):legacyApplicability(f,review,source,changed);
      const item:InlineProposal={...base,sig:proposalSignature(f),kind,state:availability.state,canApply:availability.canApply,reason:availability.reason,before:p!.before,after:p!.after,phrase:kind==="text"?p!.before:p!.entry!.phrase};
      if(decisions[id]){
        // An applied proposal that is now present in the text reads as "applied";
        // anything else the user decided stays hidden as "decided".
        item.state=decisions[id]!=="현재 유지"&&availability.state==="applied"?"applied":"decided";
        item.canApply=false;item.decision=decisions[id];
      }
      if(kind==="text")item.segments=diffSegments(p!.before!,p!.after!);
      // Only locate targets that are uniquely present and still applicable; never
      // decorate a guessed position.
      if(item.state==="available"&&source!==undefined){
        const text=plainOf(source),phrase=item.phrase!;
        const start=unique(text,phrase);
        const links=linkSpans(source);
        if(start===undefined){item.state="changed";item.canApply=false;item.reason="대상 구절 위치를 확정할 수 없어요. 다시 검토해주세요.";}
        else if(cutsLink(links,start,start+phrase.length)){
          // A link renders as its label only, so a target inside '[label](url)'
          // (e.g. part of the URL) has no faithful on-screen position.
          item.state="unsupported";item.canApply=false;item.reason="링크 주소나 링크 글자 일부를 바꾸는 제안이라 본문에 정확히 표시할 수 없어요. 본문에서 직접 수정해주세요.";
        }else{
          item.start=start;item.end=start+phrase.length;
          // A deletion inside a fully targeted link marks the whole link label.
          if(kind==="text")item.deleted=deletedRanges(item.segments!,start).map(([a,b])=>{
            for(const [x,y] of links)if(a<y&&x<b){a=Math.min(a,x);b=Math.max(b,y);}
            return [a,b] as [number,number];
          });
          else{
            const cmp=formatComparison(f,source,baseSizes[paragraph!.id]);
            if(cmp)item.format={before:cmp.before,after:cmp.after,beforeLabel:cmp.beforeLabel,afterLabel:cmp.afterLabel};
          }
        }
      }
      items.push(item);
    }
  }
  // Flag overlapping live targets so the user knows applying one re-checks the other.
  const live=items.filter(i=>i.start!==undefined);
  for(const a of live){
    const o=live.filter(b=>b!==a&&b.paragraphId===a.paragraphId&&b.start!<a.end!&&a.start!<b.end!).map(b=>b.id);
    if(o.length)a.overlaps=o;
  }
  return items;
}
