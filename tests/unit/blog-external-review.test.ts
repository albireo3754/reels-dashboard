import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {markupFixture} from "../fixtures/markup-editor";
import {MarkupStore} from "../../src/app/blog-editor/markup-store";
import {prepareExternalReview,importExternalReview,reviewStatus} from "../../src/app/blog-editor/external-review";

const review=(requestId:string,visual="unverified")=>({requestId,reviews:[{
  bundleId:"B1",verdict:"needs-work",summary:"The second line ends flatly after the photo.",
  emphasisDecisions:[{tid:"P1",phrase:"First",role:"label",methods:["color"],action:"keep",reason:"Labels the bundle",alternatives:"Weight alone is weaker here",findingIds:[]}],
  visual:{status:visual,evidence:[],observation:"No screenshots supplied"},
  findings:[{id:"F1",axis:"말투",severity:"권장",observation:"Flat closing line",proposal:{layer:"text",tid:"P2",before:"Second line",after:"Second line, really"}}],
}]});

test("external executor: prepare -> validated import into the editor review file, once, without prose edits",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"external-review-"));
  try{
    const config={...await markupFixture(root),review:path.join(root,"reviews","review.json")};
    const canon=await readFile(config.canon,"utf8");
    await assert.rejects(prepareExternalReview(config,{mode:"changed"},path.join(root,"inside"),{forbiddenRoots:[root]}),/공개 저장소 밖/);
    const out=path.join(root,"..",path.basename(root)+"-packet");
    try{
      const prepared=await prepareExternalReview(config,{mode:"changed"},out);
      assert.deepEqual(prepared.bundleIds,["B1"]);
      const packet=JSON.parse(await readFile(path.join(out,"packet.json"),"utf8"));
      const bundle=JSON.parse(await readFile(path.join(out,"bundles","B1.json"),"utf8"));
      assert.equal(packet.input.id,prepared.requestId);
      assert.match(packet.input.source,/Keep facts\./);
      assert.doesNotMatch(packet.input.source,/Private history/);
      assert.deepEqual(bundle.paragraphs.map((p:any)=>p.tid),["P1","P2"]);
      assert.deepEqual(bundle.emphasisTargets.map((t:any)=>t.phrase),["First"]);
      assert.deepEqual(bundle.itemSchema.properties.emphasisDecisions.items.properties.tid.enum,["P1","P2"]);
      await assert.rejects(prepareExternalReview(config,{mode:"changed"},out),/EEXIST/);

      const bad=path.join(out,"bad.json");
      await writeFile(bad,JSON.stringify(review(prepared.requestId!,"pass")));
      await assert.rejects(importExternalReview(config,path.join(out,"packet.json"),bad,{provider:"test"}),/screenshots/);
      const good=path.join(out,"result.json");
      await writeFile(good,JSON.stringify(review(prepared.requestId!)));
      // A failed save (here: another writer holds the review lock) records failure and stays retryable.
      await mkdir(path.dirname(config.review),{recursive:true});await writeFile(config.review+".lock","");
      await assert.rejects(importExternalReview(config,path.join(out,"packet.json"),good,{provider:"Claude Code workflow"}),/EEXIST/);
      assert.equal(JSON.parse(await readFile(path.join(config.requests,prepared.requestId+".json"),"utf8")).status,"failed");
      await rm(config.review+".lock");
      const imported=await importExternalReview(config,path.join(out,"packet.json"),good,{provider:"Claude Code workflow",runId:"run-1"});
      assert.equal(imported.status,"completed");
      await assert.rejects(importExternalReview(config,path.join(out,"packet.json"),good,{provider:"Claude Code workflow"}),/이미 가져온/);

      const loaded=await new MarkupStore(config).load();
      assert.equal(loaded.reviews[0].provider,"Claude Code workflow");
      assert.equal(loaded.reviews[0].freshText,true);
      assert.equal(loaded.reviews[0].findings[0].status,"proposed");
      assert.equal(await readFile(config.canon,"utf8"),canon);
      const receipts=(await readdir(config.requests)).filter(n=>n.endsWith(".json"));
      assert.equal(JSON.parse(await readFile(path.join(config.requests,receipts[0]),"utf8")).status,"completed");

      let status=await reviewStatus(config);
      assert.equal(status.bundles[0].needsTextReview,false);
      assert.deepEqual(status.bundles[0].review?.openFindings,{필수:0,권장:1,관찰:0});
      assert.deepEqual((await prepareExternalReview(config,{mode:"changed"},out+"-2")).bundleIds,[]);

      await writeFile(config.canon,canon.replace("Second line","Changed line"));
      status=await reviewStatus(config);
      assert.equal(status.bundles[0].needsTextReview,true);
      const next=await prepareExternalReview(config,{mode:"changed"},out+"-3");
      assert.deepEqual(next.bundleIds,["B1"]);
      await rm(out+"-3",{recursive:true,force:true});
    }finally{await rm(out,{recursive:true,force:true});}
  }finally{await rm(root,{recursive:true,force:true});}
});
