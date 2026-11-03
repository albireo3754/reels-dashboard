import {randomUUID} from "node:crypto";
import {mkdir,readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {MarkupStore} from "./markup-store";
import type {EditorConfig} from "./store";
import {atomic,storeMarkupReviews} from "./review-store";
import {markupReviewInput,markupReviewResult,validateMarkupReview} from "../../shared/markup-review";
import {bundleHashes} from "../../shared/blog-markup-source";
import {parse,serialize,type MarkupBundle} from "../../shared/blog-markup";

/**
 * External executors (a Claude Code workflow, Codex subagents) run the same bundle review
 * contract as the in-app Codex SDK worker: identical input, identical validation, the same
 * review file. They only replace who produces the result. Screenshots are not captured here,
 * so these results stay visual "unverified" and can never pass the visual gate.
 */
export const PACKET_KIND="blog.markup.external-review-packet";
const hashes=z.record(z.string(),z.object({textHash:z.string(),fullHash:z.string()}));
const packetSchema=z.object({
  schemaVersion:z.literal(1),kind:z.literal(PACKET_KIND),canon:z.string(),fingerprint:z.string(),
  createdAt:z.string(),basedOn:hashes,input:markupReviewInput,
}).passthrough();
export type Selection={bundleIds:string[]}|{mode:"all"|"changed"};

const paragraphsOf=(b:MarkupBundle)=>b.nodes.flatMap(n=>n.kind==="paragraph"?[n]:n.children??[]);

/** Per-bundle review item schema with paragraph-ID enums, mirroring the in-app SDK schema tightening. */
function bundleItemSchema(tids:string[]){
  const schema:any=z.toJSONSchema(markupReviewResult);
  const item=schema.properties.reviews.items;
  item.properties.emphasisDecisions.items.properties.tid={type:"string",enum:tids};
  for(const alternative of item.properties.findings.items.properties.proposal.anyOf??[]){
    if(alternative.properties?.entry)alternative.properties.entry.properties.id={type:"string",enum:tids,description:"Exact EXISTING paragraph ID, never a new mark ID."};
    if(alternative.properties?.tid)alternative.properties.tid={type:"string",enum:tids};
  }
  item.properties.visual.properties.status={type:"string",enum:["unverified"],description:"No screenshots are supplied to external text review."};
  return item;
}

function insideAny(target:string,roots:string[]){
  return roots.some(root=>{const rel=path.relative(path.resolve(root),path.resolve(target));return rel===""||(!rel.startsWith("..")&&!path.isAbsolute(rel));});
}

export async function prepareExternalReview(config:EditorConfig,selection:Selection,outDir:string,opts:{forbiddenRoots?:string[]}={}){
  if(!config.review)throw new Error("검토 결과 파일(review)이 설정되지 않은 프로젝트예요.");
  if(insideAny(outDir,opts.forbiddenRoots??[]))throw new Error("검토 패킷은 공개 저장소 밖(콘텐츠 작업공간·개인 임시 폴더)에 만들어주세요.");
  const store=new MarkupStore(config),loaded=await store.load();
  let bundleIds:string[];
  if("bundleIds" in selection)bundleIds=selection.bundleIds;
  else if(selection.mode==="all")bundleIds=loaded.bundles.map(b=>b.id);
  else bundleIds=loaded.bundles.filter(b=>{const r=loaded.reviews.find((r:any)=>r.bundleId===b.id);return !r||!r.freshText;}).map(b=>b.id);
  if(!bundleIds.length)return {packetDir:null,requestId:null,bundleIds:[] as string[]};
  if(new Set(bundleIds).size!==bundleIds.length||bundleIds.length>100)throw new Error("묶음 선택이 올바르지 않아요.");
  const {x,source,guidance,annotations}=await store.reviewMaterials(bundleIds,loaded.revision);
  const input=markupReviewInput.parse({id:randomUUID(),bundleIds,source,guidance,annotations,visualEvidence:[]});
  const basedOn=bundleHashes(x.doc),all=x.doc.bundles;
  const bundles=bundleIds.map(id=>{
    const i=all.findIndex(b=>b.id===id),b=all[i],context=all.slice(Math.max(0,i-1),i+2);
    const ps=paragraphsOf(b);
    return {
      bundleId:id,name:b.name,question:b.question,position:`${i+1}/${all.length}`,
      previousBundleId:all[i-1]?.id??null,nextBundleId:all[i+1]?.id??null,
      markupWithNeighbours:serialize({version:1,bundles:context}),
      paragraphs:ps.map(p=>({tid:p.id,text:p.lines.join("\n")})),
      emphasisTargets:ps.flatMap(p=>p.marks.map(m=>({tid:p.id,phrase:p.lines[m.line].slice(m.start,m.end),style:m.style,role:m.role}))),
      annotations:(annotations as any[]).filter(a=>ps.some(p=>p.id===a.paragraphId)),
      itemSchema:bundleItemSchema(ps.map(p=>p.id)),
    };
  });
  await mkdir(path.join(outDir,"bundles"),{recursive:true});
  await mkdir(path.join(outDir,"out"),{recursive:true});
  const packet={schemaVersion:1 as const,kind:PACKET_KIND,canon:config.canon,fingerprint:x.base.fingerprint,createdAt:new Date().toISOString(),basedOn,input};
  await writeFile(path.join(outDir,"packet.json"),JSON.stringify(packet,null,2)+"\n",{flag:"wx"});
  await writeFile(path.join(outDir,"source.md"),source);
  await writeFile(path.join(outDir,"guidance.md"),guidance);
  for(const b of bundles)await writeFile(path.join(outDir,"bundles",b.bundleId+".json"),JSON.stringify(b,null,2)+"\n");
  return {packetDir:outDir,requestId:input.id,bundleIds};
}

export async function importExternalReview(config:EditorConfig,packetFile:string,resultFile:string,meta:{provider:string;runId?:string}){
  if(!config.review)throw new Error("검토 결과 파일(review)이 설정되지 않은 프로젝트예요.");
  const packet=packetSchema.parse(JSON.parse(await readFile(packetFile,"utf8")));
  if(path.resolve(packet.canon)!==path.resolve(config.canon))throw new Error("다른 원고에서 만든 검토 패킷이에요.");
  const input=packet.input;
  const result=validateMarkupReview(JSON.parse(await readFile(resultFile,"utf8")),input);
  for(const review of result.reviews)if(review.visual.status!=="unverified")throw new Error("외부 텍스트 검토는 화면을 확인했다고 기록할 수 없어요.");
  const receipt=config.requests?path.join(config.requests,input.id+".json"):undefined;
  const record:any={id:input.id,kind:"blog.markup.review-request",status:"importing",provider:meta.provider,runId:meta.runId,createdAt:packet.createdAt,bundleIds:input.bundleIds,basedOn:packet.basedOn,source:input.source,guidance:input.guidance,annotations:input.annotations,visualEvidence:[]};
  if(receipt){
    await mkdir(config.requests!,{recursive:true});
    // wx doubles as the idempotency guard: one packet can be imported once.
    try{await writeFile(receipt,JSON.stringify(record,null,2)+"\n",{flag:"wx"});}
    catch(e){
      if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;
      // Only a recorded failure may be retried; completed/stale/importing receipts mean the packet is taken.
      const previous=JSON.parse(await readFile(receipt,"utf8"));
      if(previous.status!=="failed")throw new Error("이미 가져온 검토 요청이에요: "+input.id);
      record.previousError=previous.error;await atomic(receipt,record);
    }
  }
  try{
    await mkdir(path.dirname(config.review),{recursive:true});
    await storeMarkupReviews(config.review,input,packet.basedOn,result,{generatedAt:new Date().toISOString(),provider:meta.provider,jobId:meta.runId});
    const current=bundleHashes(parse(await readFile(config.canon,"utf8")));
    record.status=input.bundleIds.some(id=>current[id]?.fullHash!==packet.basedOn[id]?.fullHash)?"stale":"completed";
    if(record.status==="stale")record.error="검토 중 본문·서식이 바뀌었어요. 결과는 이전 내용 기준입니다.";
    record.result=result;record.completedAt=new Date().toISOString();
  }catch(e){record.status="failed";record.error=e instanceof Error?e.message:String(e);throw e;}
  finally{record.updatedAt=new Date().toISOString();if(receipt)await atomic(receipt,record);}
  return {requestId:input.id,status:record.status as string,reviews:result.reviews.map(r=>({bundleId:r.bundleId,verdict:r.verdict,findings:r.findings.length}))};
}

/** Loop state per bundle: what the editor shows, plus whether the current text still needs a review round. */
export async function reviewStatus(config:EditorConfig){
  const doc=await new MarkupStore(config).load();
  return {
    canon:config.canon,revision:doc.revision,savedAt:doc.savedAt,
    bundles:doc.bundles.map(b=>{
      const r:any=doc.reviews.find((r:any)=>r.bundleId===b.id);
      if(!r)return {bundleId:b.id,name:b.name,review:null,needsTextReview:true};
      const open=r.findings.filter((f:any)=>f.status==="proposed");
      return {bundleId:b.id,name:b.name,needsTextReview:!r.freshText,review:{
        verdict:r.verdict,provider:r.provider??null,generatedAt:r.generatedAt??null,freshText:r.freshText,visualFresh:r.visualFresh,visual:r.visual?.status??null,
        openFindings:{필수:open.filter((f:any)=>f.severity==="필수").length,권장:open.filter((f:any)=>f.severity==="권장").length,관찰:open.filter((f:any)=>f.severity==="관찰").length},
      }};
    }),
  };
}
