import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {markupReviewInput,validateMarkupReview} from "../../src/shared/markup-review";
const source='---\nmarkup: 1\ntitle: example\n---\n<Bundle id="B1" name="label" question="q">\n¶ P1\n⟦Label⟧¹ text\n  ¹ 굵게 · disclosure\n</Bundle>\n';
function fixture(){
 const id=randomUUID();
 const input=markupReviewInput.parse({id,bundleIds:["B1"],source});
 const result={requestId:id,reviews:[{bundleId:"B1",verdict:"awaiting-visual",summary:"Text only",findings:[],emphasisDecisions:[{tid:"P1",phrase:"Label",role:"disclosure",methods:["weight"],action:"keep",reason:"Separates label from detail",alternatives:"Color may compete with amount",findingIds:[]}],visual:{status:"unverified",evidence:[],observation:"No images supplied"}}]};
 return {input,result};
}
test("text-only output cannot pass visual quality; existing marks require explicit role choices",()=>{
 const {input,result}=fixture();
 assert.doesNotThrow(()=>validateMarkupReview(result,input));
 result.reviews[0].verdict="passed";
 assert.throws(()=>validateMarkupReview(result,input),/Cannot pass|Unverified/);
 result.reviews[0].verdict="awaiting-visual";
 result.reviews[0].emphasisDecisions=[];
 assert.throws(()=>validateMarkupReview(result,input),/no role\/choice/);
});
test("visual pass requires all three supplied widths and evidence hashes",()=>{
 const {input,result}=fixture();
 input.visualEvidence=[360,390,430].map((width,i)=>({path:"/fixture/"+width+".png",width,bundleId:"B1",sha256:String(i+1).repeat(64),sourceFingerprint:"a".repeat(64)}));
 result.reviews[0].verdict="passed";result.reviews[0].visual={status:"pass",evidence:input.visualEvidence.map(e=>e.sha256) as never[],observation:"Label is distinct at each supplied width"};
 assert.doesNotThrow(()=>validateMarkupReview(result,input));
 result.reviews[0].visual.evidence.pop();
 assert.throws(()=>validateMarkupReview(result,input),/all requested widths/);
});
test("unresolved choices and uncovered fresh user annotations cannot be passed over",()=>{
 const {input,result}=fixture();
 input.annotations=[{paragraphId:"P1",quote:"text",fresh:true,note:"Consider emphasis"}];
 assert.throws(()=>validateMarkupReview(result,input),/annotation/);
 input.annotations=[];
 result.reviews[0].emphasisDecisions[0].action="change";
 assert.throws(()=>validateMarkupReview(result,input),/requires a proposal/);
});

test("labelled screenshot citations must match both the supplied width and hash",()=>{
 const {input,result}=fixture();
 input.visualEvidence=[360,390,430].map((width,i)=>({path:"/fixture/"+width+".png",width,bundleId:"B1",sha256:String(i+1).repeat(64),sourceFingerprint:"a".repeat(64)}));
 result.reviews[0].verdict="passed";
 result.reviews[0].visual={status:"pass",evidence:input.visualEvidence.map(e=>e.width+"px SHA256: "+e.sha256) as never[],observation:"Observed all widths"};
 assert.deepEqual(validateMarkupReview(result,input).reviews[0].visual.evidence,input.visualEvidence.map(e=>e.sha256));
 result.reviews[0].visual.evidence[0]=("430px SHA256: "+input.visualEvidence[0].sha256) as never;
 assert.throws(()=>validateMarkupReview(result,input),/label\/hash/);
});
