import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer,type Server} from "node:http";
import {mkdtemp,readdir,readFile,rm,stat} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {ThreadEvent} from "@openai/codex-sdk";
import {markupFixture} from "../fixtures/markup-editor";
import {makeCanonicalFixture} from "../fixtures/canonical-content";
import {startCanonicalEditor} from "../../src/app/blog-editor/server";
import {startWorkflowServer} from "../../src/app/workflow/server";
import type {SdkFactory} from "../../src/app/workflow/codex-executor";

// Synthetic fixtures only. Each node:test file runs in its own process, so
// REELS_WORKFLOW_URL is changed for this file only and restored afterwards.
interface Received{path:string;input:any}
/** Fake workflow server: records suggest-inline inputs and replies like the real action. */
async function fakeWorkflow(reply:(input:any)=>unknown){
 const received:Received[]=[];
 const server:Server=createServer(async(req,res)=>{
  let body="";for await(const c of req)body+=c;
  const input=body?JSON.parse(body):{};
  received.push({path:req.url??"",input});
  res.writeHead(req.url==="/api/workflows/suggest-inline"?200:404,{"Content-Type":"application/json"});
  res.end(JSON.stringify(req.url==="/api/workflows/suggest-inline"?reply(input):{error:"Unknown workflow action"}));
 });
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 return {url:"http://127.0.0.1:"+(server.address() as {port:number}).port,received,close:()=>new Promise<void>(r=>server.close(()=>r()))};
}
async function withWorkflowUrl<T>(url:string,run:()=>Promise<T>){
 const previous=process.env.REELS_WORKFLOW_URL;process.env.REELS_WORKFLOW_URL=url;
 try{return await run();}finally{if(previous===undefined)delete process.env.REELS_WORKFLOW_URL;else process.env.REELS_WORKFLOW_URL=previous;}
}
const post=(base:string,body:unknown)=>fetch(base+"/api/blog/suggest",{method:"POST",headers:{"Content-Type":"application/json",Origin:base},body:JSON.stringify(body)});
const texts=(list:unknown[])=>list.map(s=>(typeof s==="string"?s:(s as {text:string}).text).trim());
/** Every file below root with size+mtime, to prove a suggestion never writes anything. */
async function snapshot(root:string){
 const out:Record<string,string>={};
 async function walk(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())await walk(f);else{const s=await stat(f);out[path.relative(root,f)]=s.size+":"+s.mtimeMs;}}}
 await walk(root);return out;
}

test("/api/blog/suggest uses the unsaved paragraph and splits before/after at the plain-text caret",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"blog-suggest-"));
 const fake=await fakeWorkflow(()=>({suggestions:[" 추가 문장이에요."," 추가 문장이에요.","⟦강조⟧ 문장도 있어요."],elapsedMs:42}));
 let server:Awaited<ReturnType<typeof startCanonicalEditor>>|undefined;
 try{
  await withWorkflowUrl(fake.url,async()=>{
   const config=await markupFixture(root);server=await startCanonicalEditor(config);
   const doc=await(await fetch(server.url+"/api/blog/document")).json();
   const canonBefore=await readFile(config.canon,"utf8"),files=await snapshot(root);

   // Unsaved text of P2 is used, not the saved "Second line".
   const res=await post(server.url,{revision:doc.revision,paragraphId:"P2",source:"Second line edited",offset:6});
   assert.equal(res.status,200,await res.clone().text());
   const body=await res.json();
   assert.equal(typeof body.requestId,"string");
   assert.equal(typeof body.elapsedMs,"number");
   const list=texts(body.suggestions);
   assert.equal(list.length,2,JSON.stringify(body.suggestions));
   assert.equal(list[0],"추가 문장이에요.");
   assert.ok(list.every(t=>!/[⟦⟧]/.test(t)),"markup characters are stripped");
   assert.equal(fake.received.length,1);
   assert.equal(fake.received[0].path,"/api/workflows/suggest-inline");
   const input=fake.received[0].input;
   assert.equal(input.paragraphId,"P2");
   assert.equal(input.before,"Second");
   assert.equal(input.after," line edited");
   assert.equal(input.title,"Example article");
   assert.match(input.context,/Second line edited/);
   assert.match(input.rules,/Keep facts/);
   assert.ok(!JSON.stringify(input).includes("Private history"),"notes outside ## 규칙 stay private");
   assert.equal(input.id,body.requestId);

   // Offsets are plain-text offsets even when the source carries inline markup.
   const p1=doc.paragraphs.find((p:{id:string})=>p.id==="P1");
   const marked=await post(server.url,{revision:doc.revision,paragraphId:"P1",source:p1.source,offset:5});
   assert.equal(marked.status,200);
   assert.equal(fake.received[1].input.before,"First");
   assert.equal(fake.received[1].input.after," line");
   assert.ok(!/span|style=/.test(fake.received[1].input.before+fake.received[1].input.after),"before/after are plain text");

   // Never writes the manuscript, preview or any other file.
   assert.equal(await readFile(config.canon,"utf8"),canonBefore);
   assert.deepEqual(await snapshot(root),files);
  });
 }finally{await server?.close();await fake.close();await rm(root,{recursive:true,force:true});}
});

test("/api/blog/suggest rejects unknown paragraphs, out-of-range carets and stale revisions without calling the engine",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"blog-suggest-invalid-"));
 const fake=await fakeWorkflow(()=>({suggestions:[" 문장이에요."],elapsedMs:1}));
 let server:Awaited<ReturnType<typeof startCanonicalEditor>>|undefined;
 try{
  await withWorkflowUrl(fake.url,async()=>{
   const config=await markupFixture(root);server=await startCanonicalEditor(config);
   const doc=await(await fetch(server.url+"/api/blog/document")).json();
   const unknown=await post(server.url,{revision:doc.revision,paragraphId:"P99",source:"x",offset:0});
   assert.ok(unknown.status>=400&&unknown.status<500,String(unknown.status));
   assert.match((await unknown.json()).error,/문단/);
   const outside=await post(server.url,{revision:doc.revision,paragraphId:"P2",source:"Second line",offset:999});
   assert.ok(outside.status>=400&&outside.status<500,String(outside.status));
   const negative=await post(server.url,{revision:doc.revision,paragraphId:"P2",source:"Second line",offset:-1});
   assert.ok(negative.status>=400&&negative.status<500,String(negative.status));
   const stale=await post(server.url,{revision:"stale-revision",paragraphId:"P2",source:"Second line",offset:0});
   assert.ok(stale.status>=400&&stale.status<500,String(stale.status));
   // Cross-origin posts are refused like every other editor action.
   assert.equal((await fetch(server.url+"/api/blog/suggest",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).status,403);
   assert.equal(fake.received.length,0);
  });
 }finally{await server?.close();await fake.close();await rm(root,{recursive:true,force:true});}
});

test("/api/blog/suggest reports an unreachable engine with a clear Korean error",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"blog-suggest-down-"));
 // Reserve then free a loopback port so nothing listens there.
 const probe=createServer();await new Promise<void>(r=>probe.listen(0,"127.0.0.1",r));
 const port=(probe.address() as {port:number}).port;await new Promise<void>(r=>probe.close(()=>r()));
 let server:Awaited<ReturnType<typeof startCanonicalEditor>>|undefined;
 try{
  await withWorkflowUrl("http://127.0.0.1:"+port,async()=>{
   const config=await markupFixture(root);server=await startCanonicalEditor(config);
   const doc=await(await fetch(server.url+"/api/blog/document")).json();
   const res=await post(server.url,{revision:doc.revision,paragraphId:"P2",source:"Second line",offset:11});
   assert.equal(res.status,502);
   assert.equal((await res.json()).error,"추천 엔진에 연결하지 못했어요. 워크플로 서버가 실행 중인지 확인해주세요.");
  });
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});

test("/api/blog/suggest is markup-only: legacy documents get 400",async()=>{
 const fixture=await makeCanonicalFixture();
 const fake=await fakeWorkflow(()=>({suggestions:[" 문장이에요."],elapsedMs:1}));
 let server:Awaited<ReturnType<typeof startCanonicalEditor>>|undefined;
 try{
  await withWorkflowUrl(fake.url,async()=>{
   server=await startCanonicalEditor(fixture.config);
   const doc=await(await fetch(server.url+"/api/blog/document")).json();
   const res=await post(server.url,{revision:doc.revision,paragraphId:"T1",source:"벤치에서",offset:2});
   assert.equal(res.status,400);
   assert.equal((await res.json()).error,"이 형식에서는 추천을 지원하지 않아요.");
   assert.equal(fake.received.length,0);
   assert.equal(await readFile(fixture.config.canon,"utf8"),fixture.raw);
  });
 }finally{await server?.close();await fake.close();await rm(fixture.root,{recursive:true,force:true});}
});

test("/api/blog/suggest end-to-end through the real workflow action returns the engine's suggestions",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"blog-suggest-e2e-"));
 const prompts:string[]=[];
 const factory:SdkFactory=()=>({startThread:()=>({async runStreamed(prompt){
  prompts.push(typeof prompt==="string"?prompt:JSON.stringify(prompt));
  return {events:(async function*():AsyncGenerator<ThreadEvent>{
   yield {type:"item.completed",item:{id:"answer",type:"agent_message",text:JSON.stringify({suggestions:[{text:"바람도 시원했어요."},{text:"다음에 또 올게요."}]})}};
   yield {type:"turn.completed",usage:{input_tokens:1,output_tokens:1,cached_input_tokens:0,cache_write_input_tokens:0,reasoning_output_tokens:0}};
  })()};
 }})});
 const backend=await startWorkflowServer({root:path.join(root,"runtime"),port:0,sdkFactory:factory,sdkEnv:{}});
 let server:Awaited<ReturnType<typeof startCanonicalEditor>>|undefined;
 try{
  await withWorkflowUrl(backend.url,async()=>{
   const config=await markupFixture(path.join(root));server=await startCanonicalEditor(config);
   const doc=await(await fetch(server.url+"/api/blog/document")).json();
   const res=await post(server.url,{revision:doc.revision,paragraphId:"P2",source:"Second line.",offset:12});
   assert.equal(res.status,200,await res.clone().text());
   const body=await res.json();
   // The workflow action output must survive the editor's own cleaning step.
   assert.deepEqual(texts(body.suggestions),["바람도 시원했어요.","다음에 또 올게요."]);
   assert.equal(prompts.length,1);
   assert.ok(prompts[0].includes("Second line."));
  });
 }finally{await server?.close();await backend.close();await rm(root,{recursive:true,force:true});}
});
