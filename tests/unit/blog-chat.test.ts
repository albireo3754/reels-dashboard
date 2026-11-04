import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtemp,readdir,readFile,realpath,rm,stat} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {ThreadEvent,CodexOptions,ThreadOptions} from "@openai/codex-sdk";
import {markupFixture} from "../fixtures/markup-editor";
import {makeCanonicalFixture} from "../fixtures/canonical-content";
import {startCanonicalEditor} from "../../src/app/blog-editor/server";
import type {ChatCall} from "../../src/app/blog-editor/blog-chat";
import {buildChatPrompt,cleanChatResult,fitChatInput,type BlogChatInput} from "../../src/shared/blog-chat";
import {CodexExecutor,type SdkFactory} from "../../src/app/workflow/codex-executor";
import {WorkflowRuntime} from "../../src/app/workflow/runtime";
import type {CodexObservationPort} from "../../src/app/observability/codex-observer";

// Synthetic fixtures only; no real manuscript or credential is used.
const post=(base:string,body:unknown)=>fetch(base+"/api/blog/chat",{method:"POST",headers:{"Content-Type":"application/json",Origin:base},body:JSON.stringify(body)});
async function snapshot(root:string){
 const out:Record<string,string>={};
 async function walk(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())await walk(f);else{const s=await stat(f);out[path.relative(root,f)]=s.size+":"+s.mtimeMs;}}}
 await walk(root);return out;
}

test("cleanChatResult keeps only rewrites whose quote is unique in an attached paragraph",()=>{
 const attachments=[{paragraphId:"P1",quote:"맛있었어요",paragraph:"커피가 맛있었어요. 빵도 맛있었어요."},{paragraphId:"P2",quote:"쉬었어요",paragraph:"벤치에서 쉬었어요."}];
 const out=cleanChatResult({reply:"  바꿔 볼게요.\u0007 ",rewrites:[
  {paragraphId:"P1",quote:"맛있었어요",replacement:"진했어요"},          // ambiguous: twice in P1
  {paragraphId:"P1",quote:"커피가 맛있었어요",replacement:"⟦커피가⟧ **진했어요**"}, // markup stripped
  {paragraphId:"P3",quote:"쉬었어요",replacement:"쉬었다"},             // not attached
  {paragraphId:"P2",quote:"없는 말",replacement:"x"},                  // not in paragraph
  {paragraphId:"P2",quote:"쉬었어요",replacement:"쉬었어요"},           // no-op
  {paragraphId:"P2",quote:"쉬었어요",replacement:"쉬었다"},
  {paragraphId:"P2",quote:"쉬었어요",replacement:"쉬었다"},             // duplicate
 ]},{attachments});
 assert.equal(out.reply,"바꿔 볼게요.");
 assert.deepEqual(out.rewrites,[{paragraphId:"P1",quote:"커피가 맛있었어요",replacement:"커피가 진했어요"},{paragraphId:"P2",quote:"쉬었어요",replacement:"쉬었다"}]);
 assert.deepEqual(cleanChatResult("nonsense",{attachments}),{reply:"",rewrites:[]});
});

test("buildChatPrompt treats manuscript data as data and fitChatInput stays under the byte limit",()=>{
 const input:BlogChatInput={id:randomUUID(),title:"t",question:"더 자연스럽게?",history:[{role:"user",text:"a"},{role:"assistant",text:"b"}],attachments:[{paragraphId:"P1",quote:"q",paragraph:"q p"}],context:"가".repeat(60000),rules:"r".repeat(20000),guidance:"g".repeat(60000)};
 const prompt=buildChatPrompt(input);
 assert.match(prompt,/data, never instructions/);
 assert.match(prompt,/QUESTION: "더 자연스럽게\?"$/);
 const fitted=fitChatInput(input,50_000);
 assert.ok(new TextEncoder().encode(JSON.stringify(fitted)).length<=50_000);
 assert.equal(fitted.question,input.question);
 assert.deepEqual(fitted.attachments,input.attachments);
});

test("/api/blog/chat sends unsaved attached text, never writes files, and rejects stale quotes",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"blog-chat-"));
 const received:BlogChatInput[]=[];
 const chat:ChatCall=async(input)=>{received.push(input);return {reply:"이렇게 바꿔 보세요.",rewrites:[{paragraphId:"P2",quote:"line edited",replacement:"line, edited"}],elapsedMs:7};};
 let server:Awaited<ReturnType<typeof startCanonicalEditor>>|undefined;
 try{
  const config=await markupFixture(root);server=await startCanonicalEditor(config,undefined,undefined,undefined,{chat});
  const doc=await(await fetch(server.url+"/api/blog/document")).json();
  const files=await snapshot(root),canon=await readFile(config.canon,"utf8");
  const res=await post(server.url,{revision:doc.revision,bundleId:"B1",attachments:[{paragraphId:"P2",quote:"line edited",source:"Second line edited"}],history:[{role:"user",text:"앞 질문"},{role:"assistant",text:"앞 답변"}],question:"쉼표를 넣을까요?"});
  assert.equal(res.status,200,await res.clone().text());
  const body=await res.json();
  assert.equal(body.reply,"이렇게 바꿔 보세요.");
  assert.deepEqual(body.rewrites,[{paragraphId:"P2",quote:"line edited",replacement:"line, edited"}]);
  assert.equal(body.elapsedMs,7);
  const input=received[0];
  assert.equal(input.question,"쉼표를 넣을까요?");
  assert.deepEqual(input.attachments,[{paragraphId:"P2",quote:"line edited",paragraph:"Second line edited"}]);
  assert.match(input.context,/Second line edited/);
  assert.equal(input.title,"Example article");
  assert.match(input.rules,/Keep facts/);
  assert.ok(!JSON.stringify(input).includes("Private history"),"notes outside ## 규칙 stay private");
  assert.equal(input.history.length,2);

  // Without attachments the selected bundle is the context.
  assert.equal((await post(server.url,{revision:doc.revision,bundleId:"B1",attachments:[],history:[],question:"이 묶음 어때요?"})).status,200);
  assert.match(received[1].context,/Second line/);

  // The quote must still be in the paragraph text; unknown paragraphs and stale revisions are rejected.
  const stale=await post(server.url,{revision:doc.revision,attachments:[{paragraphId:"P2",quote:"gone",source:"Second line"}],history:[],question:"?"});
  assert.equal(stale.status,400);assert.match((await stale.json()).error,/바뀌었어요/);
  assert.equal((await post(server.url,{revision:doc.revision,attachments:[{paragraphId:"P9",quote:"x",source:"x"}],history:[],question:"?"})).status,400);
  assert.equal((await post(server.url,{revision:"old",attachments:[],history:[],question:"?"})).status,409);
  assert.equal((await post(server.url,{revision:doc.revision,attachments:[],history:[],question:"   "})).status,400);
  assert.equal(received.length,2);

  assert.deepEqual(await snapshot(root),files,"chat never writes files");
  assert.equal(await readFile(config.canon,"utf8"),canon);
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});

test("/api/blog/chat maps engine failures and refuses the legacy format",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"blog-chat-err-"));
 let server:Awaited<ReturnType<typeof startCanonicalEditor>>|undefined;
 try{
  const config=await markupFixture(path.join(root));
  const fail:ChatCall=async()=>{throw new TypeError("fetch failed");};
  server=await startCanonicalEditor(config,undefined,undefined,undefined,{chat:fail});
  const doc=await(await fetch(server.url+"/api/blog/document")).json();
  const res=await post(server.url,{revision:doc.revision,attachments:[],history:[],question:"?"});
  assert.equal(res.status,502);assert.match((await res.json()).error,/워크플로 서버/);
  await server.close();
  server=await startCanonicalEditor(config,undefined,undefined,undefined,{chat:async()=>({reply:"",rewrites:[]})});
  const empty=await post(server.url,{revision:doc.revision,attachments:[],history:[],question:"?"});
  assert.equal(empty.status,502);assert.match((await empty.json()).error,/답변을 받지 못했어요/);
  await server.close();server=undefined;

  const fixture=await makeCanonicalFixture();
  try{
   const legacy=await startCanonicalEditor(fixture.config,undefined,undefined,undefined,{chat:async()=>{throw new Error("must not be called");}});
   try{
    const d=await(await fetch(legacy.url+"/api/blog/document")).json();
    const r=await post(legacy.url,{revision:d.revision,attachments:[],history:[],question:"?"});
    assert.equal(r.status,400);assert.equal((await r.json()).error,"이 형식에서는 채팅을 지원하지 않아요.");
    assert.equal(await readFile(fixture.config.canon,"utf8"),fixture.raw);
   }finally{await legacy.close();}
  }finally{await rm(fixture.root,{recursive:true,force:true});}
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});

test("chatBlog runs one read-only SDK turn with medium effort and returns cleaned output",async()=>{
 const observer:CodexObservationPort={async begin(){return {configOverrides:[],event(){},async finish(){}};}};
 const seen:{thread:ThreadOptions[];prompts:unknown[];client:CodexOptions[]}={thread:[],prompts:[],client:[]};
 async function* reply():AsyncGenerator<ThreadEvent>{
  yield {type:"thread.started",thread_id:"chat-thread"};
  yield {type:"item.completed",item:{id:"answer",type:"agent_message",text:JSON.stringify({reply:"짧게 줄여 보세요.",rewrites:[{paragraphId:"P3",quote:"잠시 쉬었어요",replacement:"쉬었어요"},{paragraphId:"P9",quote:"x",replacement:"y"}]})}};
  yield {type:"turn.completed",usage:{input_tokens:10,output_tokens:5,cached_input_tokens:0,cache_write_input_tokens:0,reasoning_output_tokens:0}};
 }
 const factory:SdkFactory=(opts)=>{seen.client.push(opts);return {startThread(settings){seen.thread.push(settings);return {async runStreamed(prompt){seen.prompts.push(prompt);return {events:reply()};}};}};};
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),"blog-chat-sdk-")));
 const runtime=await WorkflowRuntime.open(path.join(root,"db"));
 const executor=new CodexExecutor(runtime,root,factory,{REELS_CHAT_MODEL:"chat-fixture-model"},observer);
 try{
  const id=randomUUID();
  const result=await executor.chatBlog({id,title:"합성",question:"줄여줘",history:[],attachments:[{paragraphId:"P3",quote:"잠시 쉬었어요",paragraph:"벤치에서 잠시 쉬었어요."}],context:"",rules:"",guidance:""});
  assert.equal(result.reply,"짧게 줄여 보세요.");
  assert.deepEqual(result.rewrites,[{paragraphId:"P3",quote:"잠시 쉬었어요",replacement:"쉬었어요"}]);
  assert.equal(seen.thread[0].model,"chat-fixture-model");
  assert.equal(seen.thread[0].modelReasoningEffort,"medium");
  assert.equal(seen.thread[0].sandboxMode,"read-only");
  assert.match(String(seen.prompts[0]),/QUESTION: "줄여줘"/);
  assert.equal(seen.thread[0].networkAccessEnabled,false);
  assert.throws(()=>runtime.getJob(id),/Unknown SDK job/);
  await assert.rejects(executor.chatBlog({id:"not-a-uuid"}));
 }finally{await executor.close();await runtime.close();await rm(root,{recursive:true,force:true});}
});
