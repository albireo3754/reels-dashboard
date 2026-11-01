/** One-time layers-era importer. Reads caller-owned data; never embeds a manuscript. */
import { parseDocument } from "yaml";
import { type MarkupDoc, type MarkupNode, type ParagraphNode, type MarkStyle } from "./blog-markup";
export interface LegacyBlock {text?:string|string[];photo?:string;alt?:string;pair?:boolean;group?:string;photos?:string[][];heading?:string;divider?:boolean;x?:string}
export interface LegacyBundle {id:string;name:string;question:string;core:boolean;from:string;to:string;transition_in?:string|null}
export interface LegacyEmphasis {id:string;phrase:string;occurrence?:number;style:{color?:string;bg?:string;weight?:number;size?:number;sizeRole?:MarkStyle["sizeRole"]};role?:string}
export const hexColor=(s:string)=>s.replace(/rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)/g,(_,r,g,b)=>"#"+[r,g,b].map(n=>Number(n).toString(16).padStart(2,"0")).join("")).toLowerCase();
export function extractLegacy(source:string) {
  const body=source.split("### 본문\n")[1]?.split("### 비공개")[0];
  if(body===undefined)throw new Error("Missing legacy body");
  const texts:Record<string,string[]>={};let tags="",i=0;
  for(const block of body.split(/\n\s*\n/).filter(s=>s.trim())) {
    const b=block.replace(/^\n+|\n+$/g,""),s=b.trim();
    if(s.startsWith("〔")||s.startsWith("####")||s==="---")continue;
    if(/^#\S/.test(s)){tags=s;continue;}
    texts["T"+(++i)]=b.split("\n").map(l=>l.replace(/<[^>]+>/g,"").replace(/\*\*|==/g,""));
  }
  return {texts,tags};
}
export const blockKey=(g:LegacyBlock):string=>g.photo?"photo:"+g.photo:g.group?"group:"+g.photos![0][0]:g.heading?"heading:"+g.heading:g.divider?"divider":g.x?"x:"+g.x:String(g.text);
export function convertLayers(input:{source:string;layout:LegacyBlock[];bundles:LegacyBundle[];emphasis:LegacyEmphasis[];media:string;notes:string;questionTopic:string;mapPlace:string;mapHref:string;style:Record<string,unknown>}):MarkupDoc {
  const {texts,tags}=extractLegacy(input.source);
  const yaml=input.source.match(/^---\n([\s\S]*?)\n---/)?.[1];
  if(!yaml)throw new Error("Missing YAML");
  const metadata=parseDocument(yaml).toJSON();
  Object.assign(metadata,{markup:1,media:input.media,notes:input.notes,style:input.style});
  const used=new Set<string>();
  function para(id:string):ParagraphNode {
    if(!texts[id]||used.has(id))throw new Error("Missing or duplicate paragraph "+id);
    used.add(id);
    const p:ParagraphNode={kind:"paragraph",id,lines:texts[id],marks:[],notes:[]};
    for(const e of input.emphasis.filter(e=>e.id===id)) {
      let count=0,found=false;
      for(let line=0;line<p.lines.length;line++) {
        let start=-1;
        while((start=p.lines[line].indexOf(e.phrase,start+1))>=0) {
          if(++count!==(e.occurrence??1))continue;
          const style:MarkStyle={};
          if(e.style.weight===700)style.weight=700;
          if(e.style.color)style.color=hexColor(e.style.color);
          if(e.style.bg)style.background=hexColor(e.style.bg);
          if(e.style.size!==undefined)style.size=e.style.size;
          if(e.style.sizeRole)style.sizeRole=e.style.sizeRole;
          p.marks.push({n:p.marks.length+1,line,start,end:start+e.phrase.length,style,role:e.role});
          found=true;
        }
      }
      if(!found)throw new Error("Missing emphasis "+id+": "+e.phrase);
    }
    p.marks.sort((a,b)=>a.line-b.line||a.start-b.start).forEach((m,i)=>m.n=i+1);
    return p;
  }
  function node(g:LegacyBlock):MarkupNode {
    if(g.photo)return {kind:"component",tag:"Photo",attrs:{file:g.photo,alt:g.alt??"",...(g.pair?{pair:true as const}:{})}};
    if(g.group)return {kind:"component",tag:"Collage",attrs:{layout:g.group,files:g.photos!.map(p=>p[0]).join(" · "),alts:g.photos!.map(p=>p[1]).join(" · ")}};
    if(g.heading)return {kind:"component",tag:"Heading",attrs:{},text:g.heading};
    if(g.divider)return {kind:"component",tag:"Divider",attrs:{}};
    if(!g.x)return para(String(g.text));
    if(g.x==="question-card")return {kind:"component",tag:"QuestionCard",attrs:{topic:input.questionTopic}};
    if(g.x==="naver-map")return {kind:"component",tag:"Map",attrs:{place:input.mapPlace,href:input.mapHref}};
    if(g.x==="tags")return {kind:"component",tag:"Tags",attrs:{},text:tags};
    if(g.x==="price-box"||g.x==="visit-info")return {kind:"component",tag:g.x==="price-box"?"PriceBox":"VisitCard",attrs:{},children:(Array.isArray(g.text)?g.text:[String(g.text)]).map(para)};
    throw new Error("Unsupported block "+g.x);
  }
  const keys=input.layout.map(blockKey);let at=0;
  if(new Set(keys).size!==keys.length)throw new Error("Ambiguous block anchors");
  const bundles=input.bundles.map(b=>{
    const start=keys.indexOf(b.from),end=keys.indexOf(b.to);
    if(start!==at||end<start)throw new Error("Bundle gap/overlap "+b.id);
    at=end+1;
    return {id:b.id,name:b.name,question:b.question,core:b.core,...(b.transition_in?{transitionIn:b.transition_in}:{}),nodes:input.layout.slice(start,end+1).map(node)};
  });
  if(at!==keys.length||used.size!==Object.keys(texts).length||input.emphasis.some(e=>!used.has(e.id)))throw new Error("Unassigned content");
  return {version:1,metadata,frontmatter:yaml,bundles};
}
