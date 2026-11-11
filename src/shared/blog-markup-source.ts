import { sha256Hex } from "./lib/hash";
import { bundleParagraphs, parse, serialize, type MarkupDoc, type MarkupBundle } from "./blog-markup";

export const fingerprint = (text: string) => sha256Hex(text);
export const paragraphNodes = (doc: MarkupDoc) => doc.bundles.flatMap(bundleParagraphs);
export function textOf(doc: MarkupDoc): string[] {
  return [
    ...(typeof doc.metadata?.title === "string" ? [doc.metadata.title] : []),
    ...doc.bundles.flatMap(b => b.nodes.flatMap(n => n.kind === "paragraph" ? n.lines : n.text !== undefined ? [n.text] : (n.children ?? []).flatMap(p => p.lines))),
  ];
}
/** Text protection is keyed by paragraph identity, so a layout-only reorder is allowed. */
export function protectedText(doc:MarkupDoc):string {
  return JSON.stringify({
    title:doc.metadata?.title,
    paragraphs:paragraphNodes(doc).map(p=>[p.id,p.lines]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))),
    components:doc.bundles.flatMap(b=>b.nodes.flatMap(n=>n.kind==="component"&&n.text!==undefined?[[n.tag,n.text]]:[])).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });
}
export type Change = "text" | "format" | "structure" | "none";
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function structure(b: MarkupBundle) {
  return { ...b, nodes: b.nodes.map(n => n.kind === "paragraph" ? {kind:n.kind,id:n.id} : {...n,text:undefined,children:n.children?.map(p=>p.id)}) };
}
export function classify(before: MarkupDoc, after: MarkupDoc): {document: Change; bundles: Record<string, Change>; paragraphs: Record<string, Change>} {
  const paragraphs: Record<string, Change> = {};
  const a = new Map(paragraphNodes(before).map(p=>[p.id,p]));
  const z = new Map(paragraphNodes(after).map(p=>[p.id,p]));
  for (const id of new Set([...a.keys(),...z.keys()])) {
    const x=a.get(id), y=z.get(id);
    paragraphs[id]=!x||!y?"text":!equal(x.lines,y.lines)?"text":!equal(x.marks,y.marks)?"format":"none";
  }
  const bundles: Record<string, Change> = {};
  for (const id of new Set([...before.bundles,...after.bundles].map(b=>b.id))) {
    const x=before.bundles.find(b=>b.id===id), y=after.bundles.find(b=>b.id===id);
    bundles[id]=!x||!y?"structure":protectedText({version:1,bundles:[x]})!==protectedText({version:1,bundles:[y]})?"text":
      !equal(structure(x),structure(y))?"structure":serialize({version:1,bundles:[x]})!==serialize({version:1,bundles:[y]})?"format":"none";
  }
  const document: Change = protectedText(before)!==protectedText(after)?"text":
    !equal(before.metadata,after.metadata)||!equal(before.bundles.map(structure),after.bundles.map(structure))?"structure":
    Object.values(bundles).includes("format")?"format":"none";
  return {document,bundles,paragraphs};
}
export function bundleHashes(doc: MarkupDoc) {
  return Object.fromEntries(doc.bundles.map(b=>[b.id,{
    textHash:fingerprint(JSON.stringify(textOf({version:1,bundles:[b]}))),
    fullHash:fingerprint(serialize({version:1,bundles:[b]})),
  }]));
}
export function reviewFresh(axis: string, basedOn: {textHash?:string;fullHash?:string}, current: {textHash:string;fullHash:string}) {
  const key = ["말투","끝맺음","문체","text","voice","ending"].includes(axis) ? "textHash" : "fullHash";
  return basedOn[key] === current[key];
}
export const normalize = (text: string) => serialize(parse(text));

type Edit = {start:number;end:number;lines:string[]};
function diff(base:string[], next:string[]):Edit[] {
  // LCS; blog manuscripts are small, bound memory for accidental giant inputs.
  if ((base.length+1)*(next.length+1)>16_000_000) throw new Error("MERGE_TOO_LARGE");
  const rows=Array.from({length:base.length+1},()=>new Uint32Array(next.length+1));
  for(let i=base.length-1;i>=0;i--) for(let j=next.length-1;j>=0;j--)
    rows[i][j]=base[i]===next[j]?rows[i+1][j+1]+1:Math.max(rows[i+1][j],rows[i][j+1]);
  const edits:Edit[]=[]; let i=0,j=0,edit:Edit|undefined;
  while(i<base.length||j<next.length) {
    if(i<base.length&&j<next.length&&base[i]===next[j]) {if(edit){edits.push(edit);edit=undefined;} i++;j++;continue;}
    edit??={start:i,end:i,lines:[]};
    if(j<next.length&&(i===base.length||rows[i][j+1]>=rows[i+1][j])) edit.lines.push(next[j++]);
    else {i++;edit.end=i;}
  }
  if(edit) edits.push(edit);
  return edits;
}
export type MergeResult = {ok:true;text:string}|{ok:false;conflicts:unknown[]};
function mergeLines(b:string[],m:string[],c:string[]):{ok:true;lines:string[]}|{ok:false;conflicts:unknown[]} {
  const left=diff(b,m),right=diff(b,c), all=[...left];
  const conflicts:unknown[]=[];
  for(const r of right) {
    let duplicate=false;
    for(const l of left) {
      if(equal(l,r)){duplicate=true;continue;}
      const overlap = l.start===l.end && r.start===r.end ? l.start===r.start :
        l.start===l.end ? l.start>r.start&&l.start<r.end :
        r.start===r.end ? r.start>l.start&&r.start<l.end : Math.max(l.start,r.start)<Math.min(l.end,r.end);
      if(overlap) conflicts.push({kind:"line",base:b.slice(Math.min(l.start,r.start),Math.max(l.end,r.end)),mine:l,current:r});
    }
    if(!duplicate)all.push(r);
  }
  if(conflicts.length)return {ok:false,conflicts};
  all.sort((a,z)=>a.start-z.start||a.end-z.end);
  let at=0;const out:string[]=[];
  for(const e of all){out.push(...b.slice(at,e.start),...e.lines);at=e.end;}
  out.push(...b.slice(at));
  return {ok:true,lines:out};
}
export function merge3(base:string,mine:string,current:string):MergeResult {
  let b:string[],m:string[],c:string[];
  try { [b,m,c]=[base,mine,current].map(s=>normalize(s).split("\n")); }
  catch(e) { return {ok:false,conflicts:[{kind:"parse",message:String(e)}]}; }
  const merged=mergeLines(b,m,c);
  if(!merged.ok)return merged;
  try {return {ok:true,text:normalize(merged.lines.join("\n"))};}
  catch(e){return {ok:false,conflicts:[{kind:"merged-parse",message:String(e)}]};}
}
/** The same merge for one paragraph's source. Undefined when both sides changed the same line. */
export function mergeParagraph(base:string,mine:string,current:string):string|undefined {
  const merged=mergeLines(base.split("\n"),mine.split("\n"),current.split("\n"));
  return merged.ok?merged.lines.join("\n"):undefined;
}
