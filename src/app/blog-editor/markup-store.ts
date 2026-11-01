import type {VisualEvidence} from "../../shared/markup-review";
import {paragraphSource,findingApplicability,findingTarget} from "../../shared/review-applicability";
import {reviewDocument} from "../../shared/markup-review";
import {AnnotationStore} from "./annotations";
import {readFile,writeFile,realpath,mkdir,rename,readdir,stat} from "node:fs/promises";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {z} from "zod";
import type {EditorConfig} from "./store";
import {bundleParagraphs,parse,serialize,validate,legend,type ParagraphNode,type MarkStyle} from "../../shared/blog-markup";
import {paragraphNodes,bundleHashes,reviewFresh,fingerprint} from "../../shared/blog-markup-source";
import {load,save} from "../../shared/blog-markup-store";
import {renderHtml,MARKUP_STYLE_CSS} from "../../shared/blog-markup-render";
import {readInline,inlineSource,escapeHtml,cssHex as colorHex,type InlineRun,type CanonicalDocument} from "../../shared/canonical-blog";
function edited(original:ParagraphNode,source:string):ParagraphNode{
  const runs=readInline(source),text=runs.map(r=>r.text).join("");
  if(/[<>]/.test(text)||/\n\s*\n/.test(text))throw new Error("문단 내부의 빈 문단·HTML은 지원하지 않아요.");
  const result:ParagraphNode={kind:"paragraph",id:original.id,lines:text.split("\n"),marks:[],notes:[]};
  let line=0,column=0;
  for(const run of runs){
    const parts=run.text.split("\n");
    parts.forEach((part,i)=>{
      if(i){line++;column=0;}
      if(part&&Object.keys(run.style).length){
        const style:MarkStyle={};
        if(run.style.color)style.color=colorHex(run.style.color);
        if(run.style.background)style.background=colorHex(run.style.background);
        if(run.style.weight===700)style.weight=700;
        if(run.style.size)style.size=run.style.size;
        const old=original.marks.find(m=>original.lines[m.line].slice(m.start,m.end)===part);
        if(style.size)style.sizeRole=old?.style.size===style.size?old.style.sizeRole:style.size<16?"down":"up";
        result.marks.push({n:result.marks.length+1,line,start:column,end:column+part.length,style,role:old?.role??"사용자 편집"});
      }
      column+=part.length;
    });
  }
  return result;
}
const patchSchema=z.strictObject({revision:z.string(),edits:z.array(z.strictObject({id:z.string(),source:z.string().min(1).max(20000)})).max(100),title:z.string().min(1).max(200).optional()});
export class MarkupStore {
  private bases=new Map<string,{text:string;fingerprint:string}>();
  constructor(readonly config:EditorConfig,private capture?: (bundleIds:string[],directory:string,revision:string)=>Promise<VisualEvidence[]>){}
  async inputs(){
    if(await realpath(this.config.canon)!==path.resolve(this.config.canon))throw new Error("정본 경로가 바뀌었어요.");
    const base=await load(this.config.canon),doc=parse(base.text);
    if(doc.metadata?.markup!==1)throw new Error("markup: 1 원본이 필요해요.");
    const layout=await readFile(this.config.layout,"utf8");
    const media=path.resolve(path.dirname(this.config.canon),String(doc.metadata.media??""));
    if(media!==path.resolve(this.config.media))throw new Error("설정과 원본의 미디어 경로가 달라요.");
    let rules="";
    if(typeof doc.metadata.notes==="string"){
      const note=path.resolve(path.dirname(this.config.canon),doc.metadata.notes);
      if(path.dirname(note)!==path.dirname(this.config.canon))throw new Error("notes는 정본과 같은 폴더여야 해요.");
      const notes=await readFile(note,"utf8");
      rules=notes.match(/^## 규칙\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]??"";
    }
    return {base,doc,layout,media,rules};
  }
  private fonts(layout:string){
    return layout.replace(/url\(([^)]+)\)/g,(_,v)=>`url('/api/blog/asset?kind=font&name=${encodeURIComponent(path.basename(v.replace(/["']/g,"")))}')`);
  }
  async load():Promise<CanonicalDocument>{
    const x=await this.inputs(),hashes=bundleHashes(x.doc);
    this.bases.set(x.base.fingerprint,x.base);
    while(this.bases.size>100)this.bases.delete(this.bases.keys().next().value!);
    let reviews:any[]=[];
    if(this.config.review){
      try{
        const source=JSON.parse(await readFile(this.config.review,"utf8"));
        reviews=await Promise.all(source.reviews.map(async(r:any)=>{
          let receipt:any;
          if(this.config.requests&&/^[0-9a-f-]{36}$/i.test(r.requestId??"")){
            try{receipt=reviewDocument(JSON.parse(await readFile(path.join(this.config.requests,r.requestId+".json"),"utf8")).source);}
            catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
          }
          return {...r,visualFresh:r.visualSourceFingerprint===x.base.fingerprint,freshText:hashes[r.bundleId]?.textHash===r.basedOn?.textHash,
            findings:r.findings.map((f:any)=>{
              const id=findingTarget(f);
              const fresh=!!hashes[r.bundleId]&&reviewFresh(f.axis,f.basedOn??r.basedOn,hashes[r.bundleId]);
              const baseline=receipt?paragraphNodes(receipt).find(p=>p.id===id):fresh?paragraphNodes(x.doc).find(p=>p.id===id):undefined;
              return {...f,sourceAtReview:f.sourceAtReview??(baseline?paragraphSource(baseline):undefined),status:source.corrections?.[f.id]?.status??f.status??"proposed",fresh};
            })};
        }));
      }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    }
    return {
      savedAt:(await stat(this.config.canon)).mtime.toISOString(),
      format:"markup",title:String(x.doc.metadata?.title??""),path:this.config.canon,revision:x.base.fingerprint,
      frameVersion:x.base.fingerprint,fontCss:this.fonts([...x.layout.matchAll(/@font-face\s*\{[^}]*\}/g)].map(m=>m[0]).join("\n")),
      paragraphs:paragraphNodes(x.doc).map(p=>({id:p.id,source:paragraphSource(p)})),
      bundles:x.doc.bundles.map(b=>({id:b.id,name:b.name,question:b.question,paragraphIds:bundleParagraphs(b).map(p=>p.id)})),
      reviews,warnings:[...x.base.warnings,...validate(x.doc).filter(i=>i.level!=="fact").map(i=>i.where+": "+i.message)],
    };
  }
  async asset(kind:string,name:string){
    if(!name||name!==path.basename(name))throw new Error("잘못된 자산 이름");
    const x=await this.inputs();let file:string;
    if(kind==="photo"){
      const names=x.doc.bundles.flatMap(b=>b.nodes.flatMap(n=>n.kind==="component"?(n.tag==="Photo"?[n.attrs.file]:n.tag==="Collage"?String(n.attrs.files).split(" · "):[]):[]));
      if(!names.includes(name))throw new Error("연결되지 않은 사진");
      file=path.join(x.media,name);
    }else if(kind==="font"){
      const ref=[...x.layout.matchAll(/url\(([^)]+)\)/g)].map(m=>m[1].replace(/["']/g,"")).find(p=>path.basename(p)===name&&p.endsWith(".woff2"));
      if(!ref)throw new Error("연결되지 않은 글꼴");
      file=path.resolve(path.dirname(this.config.layout),ref);
    }else throw new Error("잘못된 자산 종류");
    const resolved=await realpath(file);
    if(resolved!==path.resolve(file)&&!(this.config.assetFiles??[]).includes(resolved))throw new Error("자산 경로가 바뀌었어요.");
    return resolved;
  }
  async frame(){
    const x=await this.inputs();
    const styles=this.fonts([...x.layout.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m=>m[1]).join("\n"));
    const article=renderHtml(x.doc,{media:""},true).replace(/src="([^"]*)"/g,(_,name)=>`src="/api/blog/asset?kind=photo&name=${encodeURIComponent(name)}"`);
    return `<!doctype html><html lang="ko" data-markup="true"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}
body{background:white}main,main.mobile{width:100%;margin:0 auto;padding:24px 20px;box-sizing:border-box}header{margin-bottom:32px}[contenteditable]{outline:none;cursor:text;min-height:1em}[contenteditable]:focus{outline:2px solid #91b8a6;outline-offset:8px}.editor-bundle-label{font:11px sans-serif;color:#83988b;text-align:left;margin:10px 0 18px}.editor-bundle.active{box-shadow:inset 3px 0 #5b8875}
</style>${MARKUP_STYLE_CSS}<main><header><small>블로그 정본</small><h1 contenteditable="true" spellcheck="false" data-tid="$title" role="textbox" aria-label="글 제목">${escapeHtml(String(x.doc.metadata?.title??""))}</h1></header>${article}</main><script type="module" src="/editor-frame.js"></script></html>`;
  }
  async save(value:unknown){
    const patch=patchSchema.parse(value),base=this.bases.get(patch.revision);
    if(!base)throw new Error("편집 기준이 만료됐어요. 변경을 복사한 뒤 다시 불러와주세요.");
    if(new Set(patch.edits.map(p=>p.id)).size!==patch.edits.length)throw new Error("중복 문단 수정");
    const doc=parse(base.text),paragraphs=paragraphNodes(doc);
    for(const edit of patch.edits){
      const p=paragraphs.find(p=>p.id===edit.id);if(!p)throw new Error("없는 문단");
      Object.assign(p,edited(p,edit.source));
    }
    if(patch.title!==undefined)doc.metadata!.title=patch.title;
    const result=await save(this.config.canon,serialize(doc),base,{actor:"user",preserveExistingSizeErrors:true});
    if(!result.ok)throw new Error("저장할 수 없어요: "+JSON.stringify(result.conflicts));
    let warning="";
    try{
      const x=await this.inputs();
      const media=path.relative(path.dirname(this.config.layout),x.media).split(path.sep).join("/")+"/";
      const html=x.layout.replace(/<article[^>]*>[\s\S]*?<\/article>/,()=>renderHtml(x.doc,{media}));
      const temp=this.config.layout+"."+randomUUID()+".tmp";await writeFile(temp,html);await rename(temp,this.config.layout);
    }catch(e){warning="정본은 저장됐지만 미리보기 갱신 실패: "+String(e);}
    const document=await this.load();document.warnings!.push(...result.warnings,...(warning?[warning]:[]));
    return {document};
  }
  async request(value:unknown){
    const input=z.strictObject({revision:z.string(),bundleIds:z.array(z.string()).min(1).max(100)}).parse(value);
    const x=await this.inputs();
    if(input.revision!==x.base.fingerprint)throw new Error("정본이 바뀌었어요. 다시 불러와주세요.");
    if(input.bundleIds.some(id=>!x.doc.bundles.some(b=>b.id===id)))throw new Error("없는 묶음");
    if(!this.config.requests)throw new Error("검토 요청 폴더가 설정되지 않았어요.");
    await mkdir(this.config.requests,{recursive:true});
    const existing=await Promise.all((await readdir(this.config.requests)).filter(n=>/^[0-9a-f-]{36}\.json$/i.test(n)).map(async n=>JSON.parse(await readFile(path.join(this.config.requests!,n),"utf8"))));
    const source=legend()+"\n\n"+x.rules+"\n"+serialize(x.doc),annotations=await new AnnotationStore(this.config.canon).list();
    const guidance=(await Promise.all((this.config.reviewGuidance??[]).map(async file=>{
      if(!path.isAbsolute(file))throw new Error("검토 기준은 절대 경로로 지정해주세요.");
      return await readFile(await realpath(file),"utf8");
    }))).join("\n\n");
    if(guidance.length>60000)throw new Error("검토 기준이 너무 길어요. 관련 기준만 연결해주세요.");
    const same=existing.find(r=>["pending","running"].includes(r.status)&&JSON.stringify(r.bundleIds)===JSON.stringify(input.bundleIds)&&r.source===source&&(r.guidance??"")===guidance&&JSON.stringify(r.annotations??[])===JSON.stringify(annotations));
    if(same)return same;
    const id=randomUUID();
    const visualEvidence=this.capture?await this.capture(input.bundleIds,path.join(this.config.requests,"evidence",id),x.base.fingerprint):[];
    if(fingerprint(await readFile(this.config.canon,"utf8"))!==x.base.fingerprint)throw new Error("화면 준비 중 원고가 바뀌었어요. 다시 요청해주세요.");
    const request={guidance,visualEvidence,createdAt:new Date().toISOString(),id,kind:"blog.markup.review-request",status:"pending",bundleIds:input.bundleIds,basedOn:bundleHashes(x.doc),source:legend()+"\n\n"+x.rules+"\n"+serialize(x.doc),annotations:await new AnnotationStore(this.config.canon).list()};
    await writeFile(path.join(this.config.requests,request.id+".json"),JSON.stringify(request,null,2),{flag:"wx"});
    return request;
  }
}
