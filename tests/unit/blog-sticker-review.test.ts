import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,readFile,writeFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {markupFixture} from "../fixtures/markup-editor";
import {MarkupStore} from "../../src/app/blog-editor/markup-store";
import {parse,serialize} from "../../src/shared/blog-markup";
import {fingerprint,protectedText} from "../../src/shared/blog-markup-source";
import {stickerPlan,stickerAnchors} from "../../src/shared/blog-stickers";
import {checkStickerReview,finishStickerReview,applyStickerReview} from "../../src/app/blog-editor/sticker-review";

async function fixture(){
 const root=await mkdtemp(path.join(os.tmpdir(),"sticker-review-")),config=await markupFixture(root),dir=path.join(root,"packet");
 await mkdir(path.join(dir,"out"),{recursive:true});
 const store=new MarkupStore(config),initial=await store.load();
 await store.save({revision:initial.revision,edits:[],stickers:[{id:"s1",preset:"yum",bundleId:"B1",before:2}]});
 const x=await store.inputs(),bytes=Buffer.from("synthetic-evidence"),evidence:Array<{bundleId:string;width:number;path:string;sha256:string}>=[];
 for(const width of [360,390,430]){
  const file=path.join(dir,width+".png");await writeFile(file,bytes);
  evidence.push({bundleId:"B1",width,path:file,sha256:createHash("sha256").update(bytes).digest("hex")});
 }
 const packet={version:1 as const,kind:"blog.sticker-review" as const,projectId:"fixture",canon:config.canon,layout:config.layout,fingerprint:fingerprint(x.base.text),renderFingerprint:fingerprint(x.base.text+x.styles),bundles:x.doc.bundles.map(b=>({id:b.id,name:b.name,markup:serialize({version:1,bundles:[b]})})),placements:stickerPlan(x.doc),anchors:stickerAnchors(x.doc),scopeBundleIds:["B1"],evidence};
 await writeFile(path.join(dir,"packet.json"),JSON.stringify(packet));await writeFile(path.join(dir,"source.md"),x.base.text);
 const review=(role:"context"|"visual")=>({role,fingerprint:packet.fingerprint,decisions:[{bundleId:"B1",stickerId:"s1",decision:"keep",reason:"Meal description ends here.",evidence:role==="visual"?evidence.map(e=>e.path):["P1"]}],inspectedImages:role==="visual"?evidence.map(e=>e.path):[],limitations:[]});
 for(const role of ["context","visual"] as const)await writeFile(path.join(dir,"out",role+".json"),JSON.stringify(review(role)));
 return {root,config,dir,packet,review};
}
test("sticker review rejects missing decisions, invented IDs, missing image widths and stale fingerprints",async()=>{
 const f=await fixture();try{
  assert.equal(checkStickerReview(f.packet,f.review("visual"),"visual").decisions.length,1);
  assert.throws(()=>checkStickerReview(f.packet,{...f.review("context"),decisions:[]},"context"),/Missing existing/);
  assert.throws(()=>checkStickerReview(f.packet,{...f.review("context"),fingerprint:"old"},"context"),/fingerprint/);
  assert.throws(()=>checkStickerReview(f.packet,{...f.review("visual"),inspectedImages:[]},"visual"),/inspect/);
  assert.throws(()=>checkStickerReview({...f.packet,evidence:f.packet.evidence.slice(1)},f.review("visual"),"visual"),/width/);
  assert.throws(()=>checkStickerReview(f.packet,{...f.review("context"),decisions:[{...f.review("context").decisions[0],stickerId:"invented"}]},"context"),/Unknown/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test("finish distinguishes local layout pass from native sticker status and refuses changed evidence/source",async()=>{
 const f=await fixture();try{
  const result=await finishStickerReview(f.dir,f.config);assert.equal(result.passed,true);assert.equal(result.nativeStickerStatus,"unverified");
  const r=f.review("context");r.decisions[0].decision="unconfirmed";
  await writeFile(path.join(f.dir,"out/context.json"),JSON.stringify(r));assert.equal((await finishStickerReview(f.dir,f.config)).passed,false);
  await writeFile(f.packet.evidence[0].path,"changed");await assert.rejects(finishStickerReview(f.dir,f.config),/Screenshot bytes changed/);
  await writeFile(f.config.canon,(await readFile(f.config.canon,"utf8")).replace("Second line","User changed this"));
  await assert.rejects(finishStickerReview(f.dir,f.config),/Stale manuscript/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
test("applying placement decisions preserves prose and marks, records backup, invalidates prior review, and rejects text payloads",async()=>{
 const f=await fixture();try{
  const before=parse(await readFile(f.config.canon,"utf8")),plan={fingerprint:f.packet.fingerprint,placements:[{...f.packet.placements[0],before:3}],decisions:[{stickerId:"s1",decision:"move",reason:"Finish paragraph first"}]};
  await assert.rejects(applyStickerReview(f.dir,f.config,{...plan,text:"overwrite prose"}));
  const applied=await applyStickerReview(f.dir,f.config,plan);assert.equal(applied.changed,true);
  const after=parse(await readFile(f.config.canon,"utf8"));assert.equal(protectedText(before),protectedText(after));
  for(const b of [before,after])b.bundles.forEach(bundle=>{bundle.nodes=bundle.nodes.filter(n=>!(n.kind==="component"&&n.tag==="Sticker"));});
  assert.equal(serialize(before),serialize(after));
  assert.match(await readFile(path.join(f.dir,"canon-before-apply.md"),"utf8"),/<Sticker/);
  await assert.rejects(finishStickerReview(f.dir,f.config),/Stale manuscript/);
 }finally{await rm(f.root,{recursive:true,force:true});}
});
