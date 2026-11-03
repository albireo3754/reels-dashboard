import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parse, serialize, validate } from "../../src/shared/blog-markup";
import { renderHtml } from "../../src/shared/blog-markup-render";
import { replaceStickers, stickerPlan, stickerAnchors, stickerHtml } from "../../src/shared/blog-stickers";
import { protectedText, bundleHashes } from "../../src/shared/blog-markup-source";
import { MarkupStore } from "../../src/app/blog-editor/markup-store";
import { markupFixture } from "../fixtures/markup-editor";

const source='<Bundle id="B1" name="도입" question="방문 이유">\n<Title>제목</Title>\n<Photo file="food.jpg" alt="음식"/>\n\n¶ P1\n⟦맛있었어요⟧¹\n  ¹ 적갈 · 감상\n\n<Tags>#음식</Tags>\n</Bundle>\n';
test("sticker components preserve prose, format and stable gaps through round trip; invalidate layout reviews only",()=>{
  const doc=parse(source),text=protectedText(doc),hash=bundleHashes(doc).B1;
  assert.deepEqual(stickerAnchors(doc).map(a=>a.before),[1,2,3]);
  const placements=[{id:"s1",preset:"yum" as const,bundleId:"B1",before:3,note:'기본 "만족" <표정>'}];
  replaceStickers(doc,placements);
  const roundTrip=parse(serialize(doc));
  assert.deepEqual(stickerPlan(roundTrip),placements);
  assert.equal(protectedText(roundTrip),text);
  assert.equal(bundleHashes(roundTrip).B1.textHash,hash.textHash);
  assert.notEqual(bundleHashes(roundTrip).B1.fullHash,hash.fullHash);
  assert.deepEqual(validate(roundTrip).filter(i=>i.level==="error"),[]);
  const html=renderHtml(roundTrip,{},true);
  assert.match(html,/data-node-index="2"[^>]*class="paragraph"/);
  assert.match(html,/기본 &quot;만족&quot; &lt;표정&gt;/);
  assert.ok(!html.includes('<h1>'));
  assert.ok(html.indexOf('data-sticker-id="s1"')<html.indexOf('class="tags"'));
  replaceStickers(roundTrip,[]);
  assert.equal(serialize(roundTrip),serialize(parse(source)));
});
test("invalid, duplicate and non-body sticker positions are rejected without mutation",()=>{
  const doc=parse(source),original=serialize(doc),s={id:"s1",preset:"hello" as const,bundleId:"B1",before:2};
  for(const bad of [[{...s,before:999}],[{...s,bundleId:"missing"}],[{...s,before:0}],[{...s,before:4}],[s,{...s,id:"s2"}],[s,{...s,before:3}],[{...s,note:"x\ny"}]]){
    assert.throws(()=>replaceStickers(doc,bad));assert.equal(serialize(doc),original);
  }
  assert.ok(validate(parse(source.replace('<Photo file="food.jpg" alt="음식"/>','<Sticker preset="yum"/>'))).some(i=>i.level==="error"));
  assert.ok(!stickerHtml({...s,note:'<img src=x onerror="alert(1)">'}).includes('<img'));
});
test("store persists sticker-only changes, regenerates preview and preserves concurrent prose edits",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"sticker-store-"));
  try{
    const config=await markupFixture(root),store=new MarkupStore(config),initial=await store.load();
    const source=await readFile(config.canon,"utf8");
    await writeFile(config.canon,source.replace("Second line","Second line, externally edited"));
    const stickers=[{id:"s1",preset:"yum",bundleId:"B1",before:2,note:"기본 만족 표정"}];
    const saved=await store.save({revision:initial.revision,edits:[],stickers});
    assert.deepEqual(saved.document.stickers,stickers);
    assert.match(await readFile(config.canon,"utf8"),/externally edited/);
    assert.match(await readFile(config.layout,"utf8"),/blog-sticker-slot/);
    assert.match(await readFile(config.layout,"utf8"),/id="blog-sticker-theme"/);
    const reopened=new MarkupStore(config),d=await reopened.load();assert.deepEqual(d.stickers,stickers);
    const textSave=await reopened.save({revision:d.revision,edits:[{id:"P2",source:"Third line"}]});
    assert.deepEqual(textSave.document.stickers,stickers);
    await assert.rejects(reopened.save({revision:textSave.document.revision,edits:[],stickers:[{...stickers[0],preset:"unknown"}]}));
    const removed=await reopened.save({revision:textSave.document.revision,edits:[],stickers:[]});
    assert.deepEqual(removed.document.stickers,[]);
    assert.ok(!(await readFile(config.canon,"utf8")).includes('<Sticker'));
  }finally{await rm(root,{recursive:true,force:true});}
});
