import { writeJsonAtomic } from "../../shared/lib/fs";
import {paragraphSource} from "../../shared/review-applicability";
import {reviewDocument} from "../../shared/markup-review";
import {paragraphNodes} from "../../shared/blog-markup-source";
import {readFile,readdir,open,unlink,mkdir,stat} from "node:fs/promises";
import path from "node:path";
import {workflowRequest} from "../workflow/client";
import {markupReviewInput,validateMarkupReview} from "../../shared/markup-review";
import {parse} from "../../shared/blog-markup";
import {bundleHashes} from "../../shared/blog-markup-source";
import type {EditorConfig} from "./store";
import type {SdkJob} from "../../shared/workflow";
type Call=(action:"review-markup"|"job",input:unknown)=>Promise<any>;
const atomic=(file:string,value:unknown)=>writeJsonAtomic(file,value);
export class MarkupReviewWorker{
 private timer?:ReturnType<typeof setInterval>;
 private running?:Promise<void>;
 private error?:string;
 constructor(private config:EditorConfig,private call:Call=workflowRequest){}
 start(){this.timer=setInterval(()=>void this.tick(),1500);this.timer.unref();void this.tick();}
 async close(){if(this.timer)clearInterval(this.timer);await this.running;}
 async tick(){
  if(this.running)return this.running;
  this.running=this.process().then(()=>{this.error=undefined;}).catch(e=>{this.error=e instanceof Error?e.message:String(e);}).finally(()=>{this.running=undefined;});
  return this.running;
 }
 private async records(){
  if(!this.config.requests)return [];
  await mkdir(this.config.requests,{recursive:true});
  const files=(await readdir(this.config.requests)).filter(n=>/^[0-9a-f-]{36}\.json$/i.test(n));
  return Promise.all(files.map(async name=>{const file=path.join(this.config.requests!,name);return {file,request:JSON.parse(await readFile(file,"utf8")),mtime:(await stat(file)).mtimeMs};}));
 }
 async status(){
  if(this.error)return [{id:"worker-error",bundleIds:[],status:"failed",error:this.error}];
  return (await this.records()).sort((a,b)=>b.mtime-a.mtime).slice(0,50).map(({request:r})=>({id:r.id,bundleIds:r.bundleIds,status:r.status,error:r.error,updatedAt:r.updatedAt,jobId:r.jobId}));
 }
 private async process(){
  if(!this.config.requests)return;
  await mkdir(this.config.requests,{recursive:true});
  const lockPath=path.join(this.config.requests,".markup-worker.lock");
  let lock;
  try{lock=await open(lockPath,"wx");await lock.writeFile(String(process.pid));}
  catch(e){
    if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;
    const owner=Number(await readFile(lockPath,"utf8"));
    if(!Number.isInteger(owner)||owner<1)throw new Error("검토 잠금 파일을 확인해주세요.");
    try{process.kill(owner,0);}catch(err){if((err as NodeJS.ErrnoException).code==="ESRCH")await unlink(lockPath);else throw err;}
    return;
  }
  try{
   const records=(await this.records()).sort((a,b)=>a.mtime-b.mtime);
   for(const {file,request:r} of records){
    if(!["pending","running"].includes(r.status))continue;
    try{
      if(!this.config.review)throw new Error("검토 결과 파일이 설정되지 않았어요.");
      const input=markupReviewInput.parse({id:r.id,bundleIds:r.bundleIds,source:r.source,guidance:r.guidance??"",annotations:r.annotations??[],visualEvidence:r.visualEvidence??[]});
      if(r.status==="pending"){
        const current=bundleHashes(parse(await readFile(this.config.canon,"utf8")));
        if(input.bundleIds.some(id=>current[id]?.fullHash!==r.basedOn?.[id]?.fullHash)){
          r.status="stale";r.error="요청 후 본문·서식이 바뀌었어요. 최신 상태에서 다시 검토해주세요.";
        }else{
          const job:SdkJob=await this.call("review-markup",input);
          r.jobId=job.id;r.status="running";r.startedAt=job.createdAt;
        }
        r.updatedAt=new Date().toISOString();await atomic(file,r);
      }
      if(r.status!=="running")continue;
      const job:SdkJob=await this.call("job",{jobId:r.jobId});
      r.message=job.events.at(-1)?.message;
      if(job.status==="running")continue;
      if(job.status!=="completed"){r.status=job.status;r.error=job.error??"검토가 완료되지 않았어요.";}
      else{
        const result=validateMarkupReview(job.result,input);
        const reviewLock=await open(this.config.review+".lock","wx");
        try{
          let stored:any={schemaVersion:1,reviews:[]};
          try{stored=JSON.parse(await readFile(this.config.review,"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
          const generatedAt=job.updatedAt;
          const original=paragraphNodes(reviewDocument(input.source));
          const reviews=result.reviews.map(review=>({...review,basedOn:r.basedOn[review.bundleId],generatedAt,requestId:r.id,provider:"Codex",jobId:job.id,visualSourceFingerprint:input.visualEvidence[0]?.sourceFingerprint,screenshots:input.visualEvidence.flatMap((e,index)=>e.bundleId===review.bundleId?[{width:e.width,index}]:[]),findings:review.findings.map(f=>{const p=original.find(p=>p.id===(f.proposal?.layer==="text"?f.proposal.tid:f.proposal?.layer==="emphasis"?f.proposal.entry.id:undefined));return {...f,status:"proposed",...(p?{sourceAtReview:paragraphSource(p)}:{})};})}));
          stored.reviews=[...(stored.reviews??[]).filter((review:any)=>!input.bundleIds.includes(review.bundleId)),...reviews];
          await atomic(this.config.review,stored);
        }finally{await reviewLock.close();await unlink(this.config.review+".lock");}
        const current=bundleHashes(parse(await readFile(this.config.canon,"utf8")));
        r.status=input.bundleIds.some(id=>current[id]?.fullHash!==r.basedOn[id]?.fullHash)?"stale":"completed";
        r.result=result;r.completedAt=new Date().toISOString();
        if(r.status==="stale")r.error="검토 중 본문·서식이 바뀌었어요. 결과는 이전 내용 기준입니다.";
      }
    }catch(e){r.status="failed";r.error=e instanceof Error?e.message:String(e);}
    r.updatedAt=new Date().toISOString();await atomic(file,r);
   }
  }finally{await lock.close();await unlink(lockPath);}
 }
}
