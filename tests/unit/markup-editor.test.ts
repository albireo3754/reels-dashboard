import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {markupFixture} from "../fixtures/markup-editor";
import {MarkupStore} from "../../src/app/blog-editor/markup-store";
import {parse} from "../../src/shared/blog-markup";
import {paragraphNodes} from "../../src/shared/blog-markup-source";
import {startCanonicalEditor} from "../../src/app/blog-editor/server";

test("markup editor saves AST, preserves mark roles, merges outside edits and settles a conflict for the writer",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"markup-editor-"));
  try{
    const config=await markupFixture(root),store=new MarkupStore(config);
    const d=await store.load();assert.equal(d.format,"markup");assert.equal(d.paragraphs.length,2);
    const frame=await store.frame();assert.match(frame,/data-tid="P1"/);assert.match(frame,/kind=photo/);
    assert.equal(await store.asset("photo","photo.png"),path.join(config.media,"photo.png"));
    await assert.rejects(store.asset("photo","../article.md"),/자산/);
    await writeFile(config.canon,(await readFile(config.canon,"utf8")).replace("Second line","External line"));
    const result=await store.save({revision:d.revision,edits:[{id:"P1",source:d.paragraphs[0].source+" edited"}]});
    const doc=parse(await readFile(config.canon,"utf8")),p=paragraphNodes(doc)[0];
    assert.equal(p.marks[0].role,"main");assert.equal(p.marks[0].style.sizeRole,"up");
    assert.match(result.document.paragraphs[1].source,/External/);
    assert.match(await readFile(config.layout,"utf8"),/edited/);
    const base=await store.load();
    await writeFile(config.canon,(await readFile(config.canon,"utf8")).replace("External line","Concurrent"));
    const settled=await store.save({revision:base.revision,edits:[{id:"P2",source:"Mine"}]});
    assert.deepEqual(settled.conflicts,[{id:"P2"}]);
    assert.match(await readFile(config.canon,"utf8"),/Mine/);
    const current=await store.load();
    const request=await store.request({revision:current.revision,bundleIds:["B1"]});
    assert.match(request.source,/<Bundle/);assert.match(request.source,/Keep facts/);assert.ok(!request.source.includes("Private history"));
    const refused=await store.save({revision:current.revision,edits:[{id:"P1",source:'<span style="font-size:20px">Invalid</span>'},{id:"P2",source:"Still saved"}]});
    assert.deepEqual(refused.skipped.map(s=>s.id),["P1"]);
    assert.match(await readFile(config.canon,"utf8"),/Still saved/);assert.doesNotMatch(await readFile(config.canon,"utf8"),/Invalid/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test("markup HTTP serves editable frame and enforces origin on saves",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"markup-http-"));let server;
  try{
    const config=await markupFixture(root);server=await startCanonicalEditor(config);
    assert.equal((await fetch(server.url+"/api/blog/document")).status,200);
    const frame=await fetch(server.url+"/api/blog/frame");assert.equal(frame.status,200);assert.match(await frame.text(),/data-tid="P2"/);
    assert.equal((await fetch(server.url+"/api/blog/save",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).status,403);
    const d=await(await fetch(server.url+"/api/blog/document")).json();
    const saved=await fetch(server.url+"/api/blog/save",{method:"POST",headers:{"Content-Type":"application/json",Origin:server.url},body:JSON.stringify({revision:d.revision,edits:[{id:"P2",source:"From HTTP"}]})});
    assert.equal(saved.status,200);assert.match(await readFile(config.canon,"utf8"),/From HTTP/);
  }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});
