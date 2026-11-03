import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtemp,realpath,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import type {CodexOptions,ThreadEvent,ThreadOptions} from "@openai/codex-sdk";
import {CodexExecutor,type SdkFactory} from "../../src/app/workflow/codex-executor";
import {WorkflowRuntime} from "../../src/app/workflow/runtime";
import {startWorkflowServer} from "../../src/app/workflow/server";
import {workflowRequest} from "../../src/app/workflow/client";
import type {CodexObservationPort} from "../../src/app/observability/codex-observer";

// Synthetic text only; no real manuscript or credential is used.
const observer:CodexObservationPort={async begin(){return {configOverrides:[],event(){},async finish(){}};}};
const input=(over:Record<string,unknown>={})=>({
 id:randomUUID(),paragraphId:"P3",title:"합성 산책 기록",
 before:"벤치에서 잠시 쉬었어요.",after:"",
 context:'<Bundle id="B1" name="산책" question="q">\n¶ P3\n벤치에서 잠시 쉬었어요.\n</Bundle>',
 rules:"## 규칙\n존댓말 유지",guidance:"사실만 쓴다",...over,
});
const answer={suggestions:[{text:"바람이 정말 좋았어요."},{text:"햇살도 따뜻했어요."}]};
/** Suggestions may be fitted with one leading space at the caret; compare the content. */
const texts=(list:unknown[])=>list.map(s=>(typeof s==="string"?s:(s as {text:string}).text).trim());
async function* reply(result:unknown):AsyncGenerator<ThreadEvent>{
 yield {type:"thread.started",thread_id:"suggest-thread"};
 yield {type:"item.completed",item:{id:"answer",type:"agent_message",text:JSON.stringify(result)}};
 yield {type:"turn.completed",usage:{input_tokens:10,output_tokens:5,cached_input_tokens:0,cache_write_input_tokens:0,reasoning_output_tokens:0}};
}
interface Seen{client:CodexOptions[];thread:ThreadOptions[];prompts:unknown[];schemas:unknown[]}
function recorder(events:(opts:CodexOptions,signal:AbortSignal)=>AsyncGenerator<ThreadEvent>):{factory:SdkFactory;seen:Seen}{
 const seen:Seen={client:[],thread:[],prompts:[],schemas:[]};
 const factory:SdkFactory=(opts)=>{
  seen.client.push(opts);
  return {startThread(settings){
   seen.thread.push(settings);
   return {async runStreamed(prompt,{outputSchema,signal}){seen.prompts.push(prompt);seen.schemas.push(outputSchema);return {events:events(opts,signal)};}};
  }};
 };
 return {factory,seen};
}
async function fixture(factory:SdkFactory,env:NodeJS.ProcessEnv={}){
 const root=await realpath(await mkdtemp(path.join(tmpdir(),"inline-suggest-sdk-")));
 const runtime=await WorkflowRuntime.open(path.join(root,"db"));
 const executor=new CodexExecutor(runtime,root,factory,env,observer);
 return {root,runtime,executor,async close(){await executor.close();await runtime.close();await rm(root,{recursive:true,force:true});}};
}
const waitForAbort=(signal:AbortSignal)=>new Promise<never>((_resolve,reject)=>{
 if(signal.aborted)reject(signal.reason);else signal.addEventListener("abort",()=>reject(signal.reason),{once:true});
});

test("suggestInline runs one read-only low-effort turn and returns suggestions without persisting a job",async()=>{
 const {factory,seen}=recorder(()=>reply(answer));
 const f=await fixture(factory,{REELS_SUGGEST_MODEL:"suggest-fixture-model",REELS_CODEX_MODEL:"review-fixture-model"});
 try{
  const value=input();
  const result=await f.executor.suggestInline(value);
  assert.deepEqual(texts(result.suggestions),["바람이 정말 좋았어요.","햇살도 따뜻했어요."]);
  assert.equal(typeof result.elapsedMs,"number");
  assert.ok(result.elapsedMs>=0);
  assert.equal(seen.thread.length,1);
  const thread=seen.thread[0];
  assert.equal(thread.sandboxMode,"read-only");
  assert.equal(thread.approvalPolicy,"never");
  assert.equal(thread.networkAccessEnabled,false);
  assert.equal(thread.webSearchMode,"disabled");
  assert.equal(thread.model,"suggest-fixture-model");
  assert.equal(thread.modelReasoningEffort,"low");
  assert.match(JSON.stringify(seen.schemas[0]),/suggestions/);
  const prompt=typeof seen.prompts[0]==="string"?seen.prompts[0]:JSON.stringify(seen.prompts[0]);
  assert.ok(prompt.includes(value.before));
  assert.ok(prompt.includes("존댓말 유지"));
  assert.ok(prompt.includes(value.guidance));
  // Saved login without keys, same environment isolation as other SDK work.
  assert.equal(seen.client[0].apiKey,undefined);
  assert.equal(seen.client[0].env?.CODEX_LOCAL_CHANNEL_DISABLED,"1");
  // Synchronous suggestion: no SQLite job, so nothing is listed or resumable later.
  assert.throws(()=>f.runtime.getJob(value.id),/Unknown SDK job/);
 }finally{await f.close();}
});

test("suggestInline model/effort env falls back to the review model and honours REELS_SUGGEST_REASONING_EFFORT",async()=>{
 const {factory,seen}=recorder(()=>reply(answer));
 const f=await fixture(factory,{REELS_CODEX_MODEL:"review-fixture-model",REELS_SUGGEST_REASONING_EFFORT:"minimal"});
 try{
  await f.executor.suggestInline(input());
  assert.equal(seen.thread[0].model,"review-fixture-model");
  assert.equal(seen.thread[0].modelReasoningEffort,"minimal");
 }finally{await f.close();}
});

test("suggestInline rejects invalid input before starting the SDK",async()=>{
 const {factory,seen}=recorder(()=>reply(answer));
 const f=await fixture(factory);
 try{
  await assert.rejects(f.executor.suggestInline(input({before:"가".repeat(4001)})));
  await assert.rejects(f.executor.suggestInline(input({id:"not-a-uuid"})));
  assert.equal(seen.thread.length,0);
 }finally{await f.close();}
});

test("suggestInline times out via REELS_SUGGEST_TIMEOUT_MS and surfaces an error",async()=>{
 let aborted=false;
 const {factory}=recorder((_opts,signal)=>(async function*():AsyncGenerator<ThreadEvent>{
  yield {type:"thread.started",thread_id:"slow-thread"};
  try{await waitForAbort(signal);}finally{aborted=signal.aborted;}
 })());
 // 1000 ms is the smallest accepted timeout; lower values fall back to the default.
 const f=await fixture(factory,{REELS_SUGGEST_TIMEOUT_MS:"1000"});
 try{
  const started=Date.now(),value=input();
  await assert.rejects(f.executor.suggestInline(value),/SUGGEST_TIMEOUT|초 안에|timeout/i);
  assert.ok(Date.now()-started<5000,"timeout must abort the turn promptly");
  assert.equal(aborted,true,"the SDK turn receives the abort signal");
  assert.throws(()=>f.runtime.getJob(value.id),/Unknown SDK job/);
 }finally{await f.close();}
});

test("suggestInline aborts the SDK turn when the caller cancels",async()=>{
 let aborted=false,started!:()=>void;
 const running=new Promise<void>(resolve=>{started=resolve;});
 const {factory}=recorder((_opts,signal)=>(async function*():AsyncGenerator<ThreadEvent>{
  yield {type:"thread.started",thread_id:"cancel-thread"};
  started();
  try{await waitForAbort(signal);}finally{aborted=signal.aborted;}
 })());
 const f=await fixture(factory);
 try{
  const controller=new AbortController(),value=input();
  const pending=f.executor.suggestInline(value,controller.signal);
  await running;
  controller.abort();
  await assert.rejects(pending,/SUGGEST_CANCELLED|취소|abort/i);
  assert.equal(aborted,true);
  assert.throws(()=>f.runtime.getJob(value.id),/Unknown SDK job/);
 }finally{await f.close();}
});

test("suggestInline falls back from an API-key quota failure to saved login once",async()=>{
 const {factory,seen}=recorder((opts)=>opts.apiKey?(async function*():AsyncGenerator<ThreadEvent>{yield {type:"turn.failed",error:{message:"429 insufficient_quota"}};})():reply(answer));
 const f=await fixture(factory,{OPENAI_API_KEY:"synthetic-secret",HOME:tmpdir()});
 try{
  const result=await f.executor.suggestInline(input());
  assert.deepEqual(texts(result.suggestions),["바람이 정말 좋았어요.","햇살도 따뜻했어요."]);
  assert.equal(seen.client[0].apiKey,"synthetic-secret");
  assert.equal(seen.client[1].apiKey,undefined);
  assert.ok(!JSON.stringify(result).includes("synthetic-secret"));
 }finally{await f.close();}
});

test("workflow HTTP action suggest-inline returns suggestions synchronously",async()=>{
 const root=await realpath(await mkdtemp(path.join(tmpdir(),"inline-suggest-http-")));
 const {factory}=recorder(()=>reply(answer));
 const server=await startWorkflowServer({root:path.join(root,"runtime"),port:0,sdkFactory:factory,sdkEnv:{}});
 try{
  const value=input();
  const result=await workflowRequest("suggest-inline",value,server.url);
  assert.deepEqual(texts(result.suggestions),["바람이 정말 좋았어요.","햇살도 따뜻했어요."]);
  assert.equal(typeof result.elapsedMs,"number");
  await assert.rejects(workflowRequest("suggest-inline",{...value,id:"bad"},server.url));
  // No job record: polling the id finds nothing.
  await assert.rejects(workflowRequest("job",{jobId:value.id},server.url));
 }finally{await server.close();await rm(root,{recursive:true,force:true});}
});
