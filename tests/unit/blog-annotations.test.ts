import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {markupFixture} from "../fixtures/markup-editor";
import {AnnotationStore} from "../../src/app/blog-editor/annotations";
import {MarkupStore} from "../../src/app/blog-editor/markup-store";

test("private quote annotations persist, check independently and detect changed wording",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"annotations-"));
 try{
  const config=await markupFixture(root),store=new AnnotationStore(config.canon),before=await readFile(config.canon,"utf8");
  const input={action:"add",id:randomUUID(),paragraphId:"P1",quote:"First",context:"First line",note:"Use a warmer color",checked:false};
  const added=await store.update(input);assert.equal(added[0].fresh,true);
  assert.equal((await store.update(input)).length,1);
  const checked=await store.update({action:"check",id:input.id,checked:true});assert.equal(checked[0].checked,true);
  assert.equal(await readFile(config.canon,"utf8"),before);
  assert.equal((await new AnnotationStore(config.canon).list())[0].note,input.note);
  await writeFile(config.canon,before.replace("⟦First⟧","⟦Changed⟧"));
  assert.equal((await store.list())[0].fresh,false);
  await assert.rejects(store.update({...input,id:randomUUID(),quote:"not in context"}),/구절/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test("user can recolor around existing unsupported sizes but cannot introduce new invalid sizes",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"annotations-size-"));
 try{
  const config=await markupFixture(root);
  await writeFile(config.canon,(await readFile(config.canon,"utf8")).replace("up19","up20"));
  const store=new MarkupStore(config),base=await store.load();
  const saved=await store.save({revision:base.revision,edits:[{id:"P2",source:'<span style="color:#a64132">Second</span> line'}]});
  assert.match(await readFile(config.canon,"utf8"),/up20/);
  assert.ok(saved.document.warnings?.some(s=>s.includes("20px")));
  await assert.rejects(store.save({revision:saved.document.revision,edits:[{id:"P2",source:'<span style="font-size:22px">Second</span> line'}]}),/validation/);
 }finally{await rm(root,{recursive:true,force:true});}
});
