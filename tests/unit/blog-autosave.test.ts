import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,readdir,writeFile,rm,utimes,unlink} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {markupFixture} from "../fixtures/markup-editor";
import {MarkupStore} from "../../src/app/blog-editor/markup-store";
import {startCanonicalEditor} from "../../src/app/blog-editor/server";
import {parse} from "../../src/shared/blog-markup";
import {paragraphNodes} from "../../src/shared/blog-markup-source";
import {load,save} from "../../src/shared/blog-markup-store";
import {editedParagraphs,safePlain,safeRuns} from "../../src/shared/blog-markup-edit";
import {createAutosave,type AutosaveState} from "../../src/features/canonical-blog/model/autosave";
import {movedGap} from "../../src/shared/blog-stickers";

async function withStore(run:(store:MarkupStore,config:Awaited<ReturnType<typeof markupFixture>>)=>Promise<void>){
 const root=await mkdtemp(path.join(os.tmpdir(),"blog-autosave-"));
 try{const config=await markupFixture(root);await run(new MarkupStore(config),config);}
 finally{await rm(root,{recursive:true,force:true});}
}
const paragraphs=async(file:string)=>paragraphNodes(parse(await readFile(file,"utf8")));
const history=(file:string)=>readdir(path.join(path.dirname(file),".history",path.basename(file)));

test("a blank line inside a paragraph splits it, keeps marks and takes a new unique id",()=>withStore(async(store,config)=>{
 const d=await store.load(),p1=d.paragraphs[0];
 const result=await store.save({revision:d.revision,edits:[{id:"P1",source:p1.source+"\n\n<span style=\"color:#a64132;font-weight:700\">Next</span> part\n \nThird"}]});
 assert.deepEqual(result.splits,{P1:["P1","P3","P4"]});
 const list=await paragraphs(config.canon);
 assert.deepEqual(list.map(p=>p.id),["P1","P3","P4","P2"]);
 assert.deepEqual(list[0].lines,["First line"]);assert.equal(list[0].marks[0].role,"main");
 assert.deepEqual(list[1].lines,["Next part"]);assert.equal(list[1].marks[0].style.color,"#a64132");assert.equal(list[1].marks[0].line,0);
 assert.deepEqual(list[2].lines,["Third"]);
}));
test("trailing blank lines are not a split and an emptied paragraph still saves",()=>withStore(async(store,config)=>{
 const d=await store.load();
 const result=await store.save({revision:d.revision,edits:[{id:"P2",source:"Second line\n\n"},{id:"P1",source:""}]});
 assert.deepEqual(result.splits,{});assert.deepEqual(result.skipped,[]);
 const list=await paragraphs(config.canon);
 assert.deepEqual(list.map(p=>[p.id,p.lines]),[["P1",[]],["P2",["Second line"]]]);
 assert.equal(result.document.paragraphs[0].source,"");
}));
test("typed characters the manuscript reserves are stored as look-alikes and never block a save",()=>withStore(async(store,config)=>{
 const d=await store.load();
 const typed="a < b > c\n<Bundle id=\"x\">\n</Bundle>\n¶ P1\n  ¹ fake note\n⟦open";
 const result=await store.save({revision:d.revision,edits:[{id:"P2",source:safePlain(typed)}]});
 assert.deepEqual(result.skipped,[]);
 const list=await paragraphs(config.canon);
 assert.deepEqual(list.map(p=>p.id),["P1","P2"]);
 assert.equal(list[1].lines[0],"a ＜ b ＞ c");assert.equal(list[1].lines.length,6);
 assert.deepEqual(safeRuns([{text:"\n\nx == y ** z\n\n",style:{}}]),[{text:"x ＝＝ y ＊＊ z",style:{}}]);
 assert.deepEqual(safeRuns([{text:"\n \n",style:{}}]),[]);
}));
test("a malformed paragraph is held back alone while the others save",()=>withStore(async(store,config)=>{
 const d=await store.load();
 const result=await store.save({revision:d.revision,edits:[{id:"P1",source:"**never closed"},{id:"P2",source:"Saved anyway"}]});
 assert.deepEqual(result.skipped.map(s=>s.id),["P1"]);
 assert.match(await readFile(config.canon,"utf8"),/Saved anyway/);
 assert.match(await readFile(config.canon,"utf8"),/First/);
}));
test("a base survives a restart: from the page's text, from .history, and without either",()=>withStore(async(store,config)=>{
 const d=await store.load();
 await writeFile(config.canon,(await readFile(config.canon,"utf8")).replace("Second line","Outside"));
 const first=await new MarkupStore(config).save({revision:d.revision,baseText:d.sourceText,edits:[{id:"P1",source:"Mine one"}]});
 assert.deepEqual(first.conflicts,[]);
 let text=await readFile(config.canon,"utf8");assert.match(text,/Mine one/);assert.match(text,/Outside/);
 const second=await store.load();
 await store.save({revision:second.revision,edits:[{id:"P1",source:"Mine two"}]});
 await writeFile(config.canon,(await readFile(config.canon,"utf8")).replace("Outside","Outside again"));
 const third=await new MarkupStore(config).save({revision:second.revision,edits:[{id:"P1",source:"Mine three"}]});
 assert.deepEqual(third.conflicts,[],"recovered from .history, so P1 merges cleanly over the older save");
 text=await readFile(config.canon,"utf8");assert.match(text,/Mine three/);assert.match(text,/Outside again/);
 const lost=await new MarkupStore(config).save({revision:"gone",edits:[{id:"P2",source:"Still lands"}]});
 assert.ok(lost.document.warnings?.some(w=>w.includes("저장 기준")));
 assert.match(await readFile(config.canon,"utf8"),/Still lands/);
}));
test("BUSY is waited out, surfaces only while the lock stays, and a crashed lock is taken over",()=>withStore(async(store,config)=>{
 const d=await store.load(),lock=config.canon+".lock";
 await writeFile(lock,"");
 const waited=store.save({revision:d.revision,edits:[{id:"P2",source:"After the lock"}]});
 setTimeout(()=>void unlink(lock),400);
 await waited;
 assert.match(await readFile(config.canon,"utf8"),/After the lock/);
 const now=await store.load();
 await writeFile(lock,"");
 await assert.rejects(store.save({revision:now.revision,edits:[{id:"P2",source:"Blocked"}]}),/BUSY/);
 const old=new Date(Date.now()-10*60_000);await utimes(lock,old,old);
 await store.save({revision:now.revision,edits:[{id:"P2",source:"Took over"}]});
 assert.match(await readFile(config.canon,"utf8"),/Took over/);
}));
test("merge paths: outside and page edits combine; a true conflict keeps the writer's text and a copy of theirs",()=>withStore(async(store,config)=>{
 const d=await store.load();
 await writeFile(config.canon,(await readFile(config.canon,"utf8")).replace("Second line","Theirs"));
 const clean=await store.save({revision:d.revision,edits:[{id:"P1",source:d.paragraphs[0].source+" mine"}]});
 assert.deepEqual(clean.conflicts,[]);
 assert.deepEqual((await paragraphs(config.canon)).map(p=>p.lines[0]),["First line mine","Theirs"]);
 const base=clean.document;
 await writeFile(config.canon,(await readFile(config.canon,"utf8")).replace("Theirs","Theirs again"));
 const clash=await store.save({revision:base.revision,edits:[{id:"P2",source:"Mine wins"}]});
 assert.deepEqual(clash.conflicts,[{id:"P2"}]);
 assert.equal((await paragraphs(config.canon))[1].lines[0],"Mine wins");
 const copies=(await history(config.canon)).filter(n=>n.startsWith("conflict-"));
 assert.equal(copies.length,1);
 assert.match(await readFile(path.join(path.dirname(config.canon),".history",path.basename(config.canon),copies[0]),"utf8"),/Theirs again/);
 // A later save is not blocked by the conflict.
 const after=await store.save({revision:clash.document.revision,edits:[{id:"P2",source:"Keeps going"}]});
 assert.deepEqual(after.conflicts,[]);
}));
test("a paragraph deleted outside comes back with the writer's edit, in place",()=>withStore(async(store,config)=>{
 const d=await store.load();
 await writeFile(config.canon,(await readFile(config.canon,"utf8")).replace("\n¶ P2\nSecond line\n","\n"));
 const result=await store.save({revision:d.revision,edits:[{id:"P2",source:"Rescued"}]});
 assert.deepEqual(result.conflicts,[{id:"P2"}]);
 assert.deepEqual((await paragraphs(config.canon)).map(p=>p.id),["P1","P2"]);
 assert.match(await readFile(config.canon,"utf8"),/Rescued/);
}));
test("an edit started from text the file has since replaced is a conflict, not a silent overwrite",()=>withStore(async(store,config)=>{
 const before=await store.load();
 await writeFile(config.canon,(await readFile(config.canon,"utf8")).replace("Second line","Agent text"));
 const after=await store.load();
 const result=await store.save({revision:after.revision,edits:[{id:"P2",source:"Second line typed",base:before.paragraphs[1].source}]});
 assert.deepEqual(result.conflicts,[{id:"P2"}]);
 assert.ok((await history(config.canon)).some(n=>n.startsWith("conflict-")));
}));
test("an agent's format save between page saves still passes TEXT_GUARD and merges",()=>withStore(async(store,config)=>{
 const d=await store.load(),agentBase=await load(config.canon);
 await store.save({revision:d.revision,edits:[{id:"P2",source:"Writer typed"}]});
 const agent=await save(config.canon,agentBase.text.replace("적갈","갈색"),agentBase,{actor:"agent"});
 assert.ok(agent.ok);
 const text=await readFile(config.canon,"utf8");assert.match(text,/갈색/);assert.match(text,/Writer typed/);
 const stale=await load(config.canon);
 await assert.rejects(save(config.canon,stale.text.replace("Writer typed","Agent words"),stale,{actor:"agent"}),/TEXT_GUARD/);
}));
test("frequent saves share one snapshot, while an outside version always gets its own",()=>withStore(async(store,config)=>{
 let d=await store.load();
 for(const text of ["one","two","three"])d=(await store.save({revision:d.revision,edits:[{id:"P2",source:text}]})).document;
 const count=async()=>(await history(config.canon)).filter(n=>/^\d+-/.test(n)).length;
 assert.equal(await count(),1);
 await writeFile(config.canon,(await readFile(config.canon,"utf8")).replace("First","Outside"));
 d=await store.load();
 await store.save({revision:d.revision,edits:[{id:"P2",source:"four"}]});
 assert.equal(await count(),2);
}));
test("the frame version ignores text, the page gets an article to patch, and the poll reports the revision",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"blog-autosave-http-"));let server;
 try{
  const config=await markupFixture(root);server=await startCanonicalEditor(config);
  const get=async(p:string)=>(await fetch(server!.url+p)).json();
  const d=await get("/api/blog/document");
  assert.match(d.articleHtml,/data-tid="P2"/);assert.match(d.articleHtml,/kind=photo/);assert.equal(typeof d.sourceText,"string");
  const saved=await(await fetch(server.url+"/api/blog/save",{method:"POST",headers:{"Content-Type":"application/json",Origin:server.url},body:JSON.stringify({revision:d.revision,edits:[{id:"P2",source:"Changed"}]})})).json();
  assert.equal(saved.document.frameVersion,d.frameVersion,"the first save adds the sticker theme to the layout, which must not reload the frame");
  assert.match(saved.document.articleHtml,/Changed/);
  await writeFile(config.canon,(await readFile(config.canon,"utf8")).replace("Changed","Outside"));
  const status=await get("/api/blog/review-status");
  assert.notEqual(status.revision,saved.document.revision);
  assert.equal(status.revision,(await get("/api/blog/document")).revision);
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});
test("editedParagraphs renumbers marks per part",()=>{
 const original={kind:"paragraph" as const,id:"P1",lines:["x"],marks:[],notes:[]};
 let n=5;
 const parts=editedParagraphs(original,'<span style="color:#a64132">a</span>\n\n<span style="color:#a64132">b</span> <span style="color:#0096dc">c</span>',()=>"P"+n++);
 assert.deepEqual(parts.map(p=>p.id),["P1","P5"]);
 assert.deepEqual(parts[1].marks.map(m=>[m.n,m.line,m.start]),[[1,0,0],[2,0,2]]);
});
const tick=(ms:number)=>new Promise(r=>setTimeout(r,ms));
test("autosave waits for quiet, keeps one save in flight and lets the latest state win",async()=>{
 const calls:number[]=[];let state=0,release:()=>void=()=>{};
 const saver=createAutosave({delay:20,save:async()=>{calls.push(state);await new Promise<void>(r=>release=r);}});
 state=1;saver.touch();await tick(10);state=2;saver.touch();await tick(10);
 assert.deepEqual(calls,[],"a new change restarts the quiet period");
 await tick(25);assert.deepEqual(calls,[2]);
 state=3;saver.touch();state=4;saver.touch();await tick(40);
 assert.deepEqual(calls,[2],"only one save at a time");
 release();await tick(40);assert.deepEqual(calls,[2,4]);
 release();await tick(5);saver.stop();
});
test("autosave retries with growing waits, stays explicit through retries, and flush resolves with the outcome",async()=>{
 const states:AutosaveState[]=[],forced:boolean[]=[];let fail=true;
 const saver=createAutosave({delay:5,maxBackoff:1500,save:async force=>{forced.push(force);if(fail)throw new Error("BUSY");},onState:s=>states.push(s)});
 try{
  assert.equal(await saver.flush(true),false);
  const failed=states.at(-1)!;assert.equal(failed.phase,"failed");assert.equal(failed.error,"BUSY");assert.equal(failed.retryInMs,1000);
  fail=false;await tick(1100);
  assert.deepEqual(forced,[true,true]);assert.equal(states.at(-1)!.phase,"idle");assert.equal(states.at(-1)!.failures,0);
  assert.equal(await saver.flush(),true);
  assert.deepEqual(forced,[true,true,false]);
 }finally{saver.stop();}
});
test("the same split arriving twice leaves one copy, at once, later and after a restart",()=>withStore(async(store,config)=>{
 const d=await store.load(),patch={revision:d.revision,baseText:d.sourceText,edits:[{id:"P2",source:"Alpha\n\nBeta"}]};
 const [one,two]=await Promise.all([store.save(patch),store.save(patch)]);
 assert.deepEqual(two.splits,one.splits);assert.deepEqual(two.conflicts,[]);
 const third=await store.save(patch),fourth=await new MarkupStore(config).save(patch);
 assert.deepEqual(third.splits,one.splits);assert.deepEqual(fourth.splits,one.splits);
 assert.deepEqual((await paragraphs(config.canon)).map(p=>p.lines.join("\n")),["First line","Alpha","Beta"]);
}));
test("typing on after a lost reply overwrites the earlier split instead of adding beside it",()=>withStore(async(store,config)=>{
 const d=await store.load(),base={revision:d.revision,baseText:d.sourceText};
 await store.save({...base,edits:[{id:"P2",source:"Alpha\n\nBeta"}]});
 await store.save({...base,edits:[{id:"P2",source:"Alpha\n\nBeta more"}]});
 assert.deepEqual((await paragraphs(config.canon)).map(p=>p.lines.join("\n")),["First line","Alpha","Beta more"]);
}));
test("a split of a paragraph with an old invalid size saves, and a failing new part only holds its own paragraph",()=>withStore(async(store,config)=>{
 await writeFile(config.canon,(await readFile(config.canon,"utf8")).replace("⟦First⟧¹ line\n  ¹ 적갈 up19 · main","Lead\n⟦First⟧¹ line\n  ¹ up20 · main"));
 const d=await store.load(),p1=d.paragraphs[0].source;
 const split=await store.save({revision:d.revision,edits:[{id:"P1",source:p1.replace("\n","\n\n")},{id:"P2",source:"Other saved"}]});
 assert.deepEqual(split.skipped,[]);
 assert.deepEqual((await paragraphs(config.canon)).map(p=>p.id),["P1","P3","P2"]);
 assert.match(await readFile(config.canon,"utf8"),/Other saved/);
 const next=await store.load();
 // A size the file never had, in the new part: that edit waits, the other one still saves.
 const bad=await store.save({revision:next.revision,edits:[{id:"P1",source:p1.replace("\n","\n\n").replace(">First<",">Fresh<")},{id:"P2",source:"Other again"}]});
 assert.deepEqual(bad.skipped.map(s=>[s.kind,s.id]),[["paragraph","P1"]]);
 assert.match(await readFile(config.canon,"utf8"),/Other again/);
}));
test("a line both sides did not touch merges inside the paragraph, and `written` says what the save understood",()=>withStore(async(store,config)=>{
 await writeFile(config.canon,(await readFile(config.canon,"utf8")).replace("Second line","L1\nL2"));
 const d=await store.load();
 await writeFile(config.canon,(await readFile(config.canon,"utf8")).replace("L2","L2 agent"));
 const moved=await store.load();
 const result=await store.save({revision:moved.revision,edits:[{id:"P2",source:"L1 mine\nL2",base:"L1\nL2"}]});
 assert.deepEqual(result.conflicts,[]);assert.equal(result.written.P2,"L1 mine\nL2");
 assert.deepEqual((await paragraphs(config.canon))[1].lines,["L1 mine","L2 agent"]);
 assert.notEqual(d.revision,result.document.revision);
}));
test("a focused title typed over an outside change is a conflict with a copy, and a long title says it was cut",()=>withStore(async(store,config)=>{
 await writeFile(config.canon,(await readFile(config.canon,"utf8")).replace("Example article","Agent title"));
 const d=await store.load();
 const result=await store.save({revision:d.revision,edits:[],title:"Example article!",titleBase:"Example article"});
 assert.deepEqual(result.conflicts,[{id:"$title"}]);
 assert.ok((await history(config.canon)).some(n=>n.startsWith("conflict-")));
 const long=await store.save({revision:result.document.revision,edits:[],title:"가".repeat(201)});
 assert.equal(long.document.title.length,200);assert.deepEqual(long.skipped.map(s=>s.kind),["title"]);
}));
test("deleting what another tool changed keeps the delete and reports it",()=>withStore(async(store,config)=>{
 const d=await store.load();
 await writeFile(config.canon,(await readFile(config.canon,"utf8")).replace("Second line","Second line AGENT"));
 const result=await store.save({revision:d.revision,edits:[],deleteParagraphs:["P2"]});
 assert.deepEqual(result.conflicts,[{id:"P2",kind:"delete"}]);
 assert.doesNotMatch(await readFile(config.canon,"utf8"),/AGENT/);
 assert.ok((await history(config.canon)).some(n=>n.startsWith("conflict-")));
}));
test("a paragraph brought back after an outside delete lands after its neighbour",()=>withStore(async(store,config)=>{
 await writeFile(config.canon,(await readFile(config.canon,"utf8")).replace("</Bundle>","\n¶ P9\nTail\n</Bundle>"));
 await writeFile(config.canon,(await readFile(config.canon,"utf8")).replace("\n¶ P2\nSecond line\n","\n"));
 const d=await store.load();
 const result=await store.save({revision:d.revision,edits:[{id:"P2",source:"Rescued",base:"Second line",after:"P1"}]});
 assert.deepEqual(result.conflicts,[{id:"P2"}]);
 assert.deepEqual((await paragraphs(config.canon)).map(p=>p.id),["P1","P2","P9"]);
}));
test("placements find their gap again after the nodes shift",()=>{
 const gap=(before:number,next?:string)=>({bundleId:"B1",before,label:"",next});
 const from=[gap(0,"Photo:a"),gap(1,"P1"),gap(2,"P2"),gap(3)],to=[gap(0,"Photo:a"),gap(1,"P1"),gap(2,"P5"),gap(3,"P2"),gap(4)];
 assert.equal(movedGap(from,to,{bundleId:"B1",before:3}),4);
 assert.equal(movedGap(from,to,{bundleId:"B1",before:2}),3);
 assert.equal(movedGap(from,[gap(0,"Photo:a"),gap(1)],{bundleId:"B1",before:2}),1);
 assert.equal(movedGap(from,to,{bundleId:"B2",before:2}),2);
});
