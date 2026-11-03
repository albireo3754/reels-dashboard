import {readFile,writeFile,rename,unlink,open} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import type {z} from "zod";
import {paragraphSource} from "../../shared/review-applicability";
import {paragraphNodes} from "../../shared/blog-markup-source";
import {reviewDocument,type markupReviewInput,type MarkupReviewResult} from "../../shared/markup-review";

export async function atomic(file:string,value:unknown){
 const temp=file+"."+randomUUID()+".tmp";
 try{await writeFile(temp,JSON.stringify(value,null,2)+"\n",{flag:"wx"});await rename(temp,file);}
 finally{await unlink(temp).catch(e=>{if(e.code!=="ENOENT")throw e;});}
}

/** Replaces only the reviewed bundles in the editor's review file. Shared by the in-app SDK worker and external executors. */
export async function storeMarkupReviews(
 reviewFile:string,
 input:z.infer<typeof markupReviewInput>,
 basedOn:Record<string,unknown>,
 result:MarkupReviewResult,
 meta:{generatedAt:string;provider:string;jobId?:string},
){
 const reviewLock=await open(reviewFile+".lock","wx");
 try{
  let stored:any={schemaVersion:1,reviews:[]};
  try{stored=JSON.parse(await readFile(reviewFile,"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  const original=paragraphNodes(reviewDocument(input.source));
  const reviews=result.reviews.map(review=>({...review,basedOn:basedOn[review.bundleId],generatedAt:meta.generatedAt,requestId:input.id,provider:meta.provider,jobId:meta.jobId,visualSourceFingerprint:input.visualEvidence[0]?.sourceFingerprint,screenshots:input.visualEvidence.flatMap((e,index)=>e.bundleId===review.bundleId?[{width:e.width,index}]:[]),findings:review.findings.map(f=>{const p=original.find(p=>p.id===(f.proposal?.layer==="text"?f.proposal.tid:f.proposal?.layer==="emphasis"?f.proposal.entry.id:undefined));return {...f,status:"proposed",...(p?{sourceAtReview:paragraphSource(p)}:{})};})}));
  stored.reviews=[...(stored.reviews??[]).filter((review:any)=>!input.bundleIds.includes(review.bundleId)),...reviews];
  await atomic(reviewFile,stored);
 }finally{await reviewLock.close();await unlink(reviewFile+".lock");}
}
