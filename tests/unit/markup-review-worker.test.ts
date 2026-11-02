import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,readdir,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {markupFixture} from "../fixtures/markup-editor";
import {MarkupStore} from "../../src/app/blog-editor/markup-store";
import {MarkupReviewWorker} from "../../src/app/blog-editor/review-worker";
import {startWorkflowServer} from "../../src/app/workflow/server";
import {workflowRequest} from "../../src/app/workflow/client";
import type {SdkFactory} from "../../src/app/workflow/codex-executor";

test("request -> SDK job -> persisted review with provenance, idempotence and no prose edits",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"markup-review-"));let server;let calls=0;
 try{
  const config={...await markupFixture(root),review:path.join(root,"review.json")};
  const factory:SdkFactory=()=>({startThread:()=>({async runStreamed(prompt){
   calls++;
   const data=JSON.parse((typeof prompt==="string"?prompt:(prompt[0] as {text:string}).text).split("\nInput: ")[1].split("\nReturn resultJson")[0]);
   return {events:(async function*(){
    yield {type:"item.completed" as const,item:{id:"answer",type:"agent_message" as const,text:JSON.stringify({resultJson:JSON.stringify({requestId:data.id,reviews:[{bundleId:"B1",verdict:"awaiting-visual",summary:"The supplied text fits the bundle.",findings:[],emphasisDecisions:[{tid:"P1",phrase:"First",role:"label",methods:["color","size"],action:"keep",reason:"Identifies the label",alternatives:"No background needed",findingIds:[]}],visual:{status:"unverified",evidence:[],observation:"No screenshots"}}]})})}};
    yield {type:"turn.completed" as const,usage:{input_tokens:10,output_tokens:10,cached_input_tokens:0,cache_write_input_tokens:0,reasoning_output_tokens:0}};
   })()};
  }})});
  server=await startWorkflowServer({root:path.join(root,"runtime"),port:0,sdkFactory:factory,sdkEnv:{}});
  const call=(a:"review-markup"|"job",v:unknown)=>workflowRequest(a,v,server!.url);
  const store=new MarkupStore(config),worker=new MarkupReviewWorker(config,call);
  const doc=await store.load(),before=await readFile(config.canon,"utf8");
  const req=await store.request({revision:doc.revision,bundleIds:["B1"]});
  assert.equal((await store.request({revision:doc.revision,bundleIds:["B1"]})).id,req.id);
  for(let i=0;i<40;i++){await worker.tick();if((await worker.status())[0]?.status==="completed")break;await new Promise(r=>setTimeout(r,10));}
  assert.equal((await worker.status())[0].status,"completed");
  assert.equal(calls,1);
  const updated=await store.load();assert.equal(updated.reviews[0].generatedAt!==undefined,true);assert.equal(updated.reviews[0].provider,"Codex");
  assert.equal(updated.reviews[0].freshText,true);assert.equal(await readFile(config.canon,"utf8"),before);
  const again=await call("review-markup",{id:req.id,bundleIds:req.bundleIds,source:req.source,annotations:req.annotations});
  assert.equal(again.status,"completed");assert.equal(calls,1);
  await assert.rejects(call("review-markup",{id:req.id,bundleIds:req.bundleIds,source:req.source+"\n",annotations:req.annotations}),/different content/);
  const later=await store.request({revision:doc.revision,bundleIds:["B1"]});
  await writeFile(config.canon,before.replace("Second line","Changed line"));
  await worker.tick();
  assert.equal((await worker.status()).find(r=>r.id===later.id)?.status,"stale");
  assert.equal(calls,1);
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});
test("engine unavailable becomes a visible failed request rather than perpetual pending",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"markup-review-fail-"));
 try{
  const config={...await markupFixture(root),review:path.join(root,"review.json")};
  const store=new MarkupStore(config),doc=await store.load();
  await store.request({revision:doc.revision,bundleIds:["B1"]});
  const worker=new MarkupReviewWorker(config,async()=>{throw new Error("Connection refused");});
  await worker.tick();
  const status=(await worker.status())[0];assert.equal(status.status,"failed");assert.match(status.error!,/Connection refused/);
 }finally{await rm(root,{recursive:true,force:true});}
});
