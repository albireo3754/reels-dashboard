import {test} from "node:test";
import assert from "node:assert/strict";
import {diffSegments,planInlineProposals,proposalSignature,type DiffSegment,type InlineProposal} from "../../src/shared/inline-review";
import type {CanonicalDocument,CanonicalFinding,CanonicalReview} from "../../src/shared/canonical-blog";

const join=(segments:DiffSegment[],keep:Array<DiffSegment["type"]>)=>segments.filter(s=>keep.includes(s.type)).map(s=>s.text).join("");
/** Every diff must reconstruct both sides exactly. */
function assertReconstructs(before:string,after:string,segments:DiffSegment[]){
 assert.equal(join(segments,["equal","del"]),before);
 assert.equal(join(segments,["equal","ins"]),after);
}

test("diffSegments marks only the changed Korean word ending",()=>{
 const segments=diffSegments("벤치에서 잠시 쉬었어요","벤치에서 잠시 쉬었다");
 assertReconstructs("벤치에서 잠시 쉬었어요","벤치에서 잠시 쉬었다",segments);
 assert.deepEqual(segments,[{type:"equal",text:"벤치에서 잠시 쉬었"},{type:"del",text:"어요"},{type:"ins",text:"다"}]);
});

test("diffSegments represents a pure insertion without deleting the original",()=>{
 const segments=diffSegments("Second line","✅ Second line");
 assertReconstructs("Second line","✅ Second line",segments);
 assert.deepEqual(segments,[{type:"ins",text:"✅ "},{type:"equal",text:"Second line"}]);
 assert.equal(segments.some(s=>s.type==="del"),false);
});

test("diffSegments represents a pure deletion and keeps whole words",()=>{
 const segments=diffSegments("아주 정말 좋았어요","아주 좋았어요");
 assertReconstructs("아주 정말 좋았어요","아주 좋았어요",segments);
 assert.equal(segments.some(s=>s.type==="ins"),false);
 assert.equal(join(segments,["del"]).trim(),"정말");
 assert.equal(diffSegments("same","same").every(s=>s.type==="equal"),true);
});

const P1="벤치에서 잠시 쉬었어요. 바람이 좋았어요.";
function review(findings:CanonicalFinding[],extra:Partial<CanonicalReview>={}):CanonicalReview{
 return {bundleId:"B1",summary:"synthetic",verdict:"needs-work",freshText:true,findings,...extra};
}
function markupDoc(findings:CanonicalFinding[],paragraphs=[{id:"P1",source:P1},{id:"P2",source:"Second line"}]){
 return {format:"markup" as const,paragraphs,reviews:[review(findings)]} satisfies Pick<CanonicalDocument,"format"|"paragraphs"|"reviews">;
}
const text=(id:string,tid:string,before:string,after:string):CanonicalFinding=>({id,axis:"문장",severity:"권장",observation:`${id} observation`,proposal:{layer:"text",tid,before,after}});
const byId=(items:InlineProposal[],id:string)=>{const item=items.find(i=>i.id===id);assert.ok(item,`missing ${id}`);return item;};

test("available text proposal carries plain offsets and absolute deleted ranges in the current source",()=>{
 const items=planInlineProposals({doc:markupDoc([text("ending","P1","쉬었어요","쉬었다")]),edits:{},decisions:{}});
 const item=byId(items,"ending"),start=P1.indexOf("쉬었어요");
 assert.equal(item.kind,"text");assert.equal(item.bundleId,"B1");assert.equal(item.paragraphId,"P1");
 assert.equal(item.state,"available");assert.equal(item.canApply,true);
 assert.equal(item.start,start);assert.equal(item.end,start+"쉬었어요".length);
 assert.equal(item.phrase,"쉬었어요");
 assert.equal(P1.slice(item.start,item.end),item.phrase);
 assert.deepEqual(item.deleted,[[start+2,start+4]]);
 assert.equal(P1.slice(...item.deleted![0]),"어요");
 assert.deepEqual(item.segments,diffSegments("쉬었어요","쉬었다"));
 assert.equal(item.before,"쉬었어요");assert.equal(item.after,"쉬었다");
 assert.equal(item.overlaps,undefined);
});

test("offsets follow unsaved edits instead of the stored paragraph source",()=>{
 const edited="오늘은 "+P1;
 const item=byId(planInlineProposals({doc:markupDoc([text("ending","P1","쉬었어요","쉬었다")]),edits:{P1:edited},decisions:{}}),"ending");
 assert.equal(item.start,edited.indexOf("쉬었어요"));
 assert.equal(edited.slice(item.start,item.end),"쉬었어요");
});

test("pure insertion keeps the target range but has no deleted range",()=>{
 const item=byId(planInlineProposals({doc:markupDoc([text("check","P2","Second line","✅ Second line")]),edits:{},decisions:{}}),"check");
 assert.equal(item.state,"available");assert.equal(item.start,0);assert.equal(item.end,11);
 assert.deepEqual(item.deleted,[]);
});

test("overlapping proposals in one paragraph are flagged; disjoint ones are not",()=>{
 const findings=[text("a","P1","잠시 쉬었어요","잠깐 쉬었어요"),text("b","P1","쉬었어요","쉬었다"),text("c","P1","바람이","바람도")];
 const items=planInlineProposals({doc:markupDoc(findings),edits:{},decisions:{}});
 assert.deepEqual(byId(items,"a").overlaps,["b"]);
 assert.deepEqual(byId(items,"b").overlaps,["a"]);
 assert.equal(byId(items,"c").overlaps,undefined);
 for(const id of ["a","b","c"])assert.equal(byId(items,id).canApply,true);
});

test("after applying one proposal the others in the paragraph are re-validated against the new source",()=>{
 const findings=[text("a","P1","잠시 쉬었어요","잠깐 쉬었어요"),text("b","P1","쉬었어요","쉬었다")];
 // Applying "a" keeps "쉬었어요" intact: b stays applicable at its shifted-but-valid offset.
 const afterA=P1.replace("잠시 쉬었어요","잠깐 쉬었어요");
 let items=planInlineProposals({doc:markupDoc(findings),edits:{P1:afterA},decisions:{}});
 assert.equal(byId(items,"a").state,"applied");assert.equal(byId(items,"a").canApply,false);
 assert.equal(byId(items,"a").start,undefined);
 const b=byId(items,"b");
 assert.equal(b.state,"available");assert.equal(b.canApply,true);
 assert.equal(afterA.slice(b.start,b.end),"쉬었어요");
 assert.equal(b.overlaps,undefined);
 // Applying "b" first removes a's target: a is locked with a reason and never located.
 const afterB=P1.replace("쉬었어요","쉬었다");
 items=planInlineProposals({doc:markupDoc(findings),edits:{P1:afterB},decisions:{}});
 assert.equal(byId(items,"b").state,"applied");
 const a=byId(items,"a");
 assert.equal(a.state,"changed");assert.equal(a.canApply,false);
 assert.equal(a.start,undefined);assert.equal(a.end,undefined);assert.equal(a.deleted,undefined);
 assert.ok(a.reason.length>0);
});

test("a target phrase that appears twice is ambiguous and never located",()=>{
 const doc=markupDoc([text("twice","P1","좋아요","좋았어요")],[{id:"P1",source:"좋아요. 정말 좋아요."}]);
 const item=byId(planInlineProposals({doc,edits:{},decisions:{}}),"twice");
 assert.equal(item.state,"ambiguous");assert.equal(item.canApply,false);
 assert.equal(item.start,undefined);assert.equal(item.deleted,undefined);
 assert.ok(item.reason.length>0);
});

test("a finding whose paragraph is missing stays in the plan without a body position",()=>{
 const item=byId(planInlineProposals({doc:markupDoc([text("ghost","P9","Second","Third")]),edits:{},decisions:{}}),"ghost");
 assert.equal(item.paragraphId,undefined);
 assert.equal(item.canApply,false);assert.equal(item.state,"unsupported");
 assert.equal(item.start,undefined);
});

test("findings without a text or emphasis proposal become notes",()=>{
 const findings:CanonicalFinding[]=[
  {id:"photo",axis:"사진",severity:"참고",observation:"photo.png 사진이 문단보다 먼저 나와야 해요."},
  {id:"layout",axis:"구성",observation:"사진 순서를 바꿔보세요.",proposal:{layer:"structure"}},
 ];
 const items=planInlineProposals({doc:markupDoc(findings),edits:{},decisions:{}});
 for(const id of ["photo","layout"]){
  const item=byId(items,id);
  assert.equal(item.kind,"note");assert.equal(item.state,"note");assert.equal(item.canApply,false);
  assert.equal(item.bundleId,"B1");assert.equal(item.start,undefined);
 }
 assert.equal(byId(items,"photo").observation,"photo.png 사진이 문단보다 먼저 나와야 해요.");
 assert.equal(byId(planInlineProposals({doc:markupDoc(findings),edits:{},decisions:{photo:"현재 유지"}}),"photo").state,"decided");
});

test("decided proposals are locked, keep the decision and are not decorated",()=>{
 const item=byId(planInlineProposals({doc:markupDoc([text("ending","P1","쉬었어요","쉬었다")]),edits:{},decisions:{ending:"현재 유지"}}),"ending");
 assert.equal(item.state,"decided");assert.equal(item.canApply,false);assert.equal(item.decision,"현재 유지");
 assert.equal(item.start,undefined);assert.equal(item.deleted,undefined);
});

test("withdrawn, rejected and obsolete findings are skipped",()=>{
 const findings=["withdrawn","rejected","obsolete","proposed"].map(status=>({...text(status,"P1","쉬었어요","쉬었다"),status}) as CanonicalFinding);
 assert.deepEqual(planInlineProposals({doc:markupDoc(findings),edits:{},decisions:{}}).map(i=>i.id),["proposed"]);
});

test("markup format proposal compares current and proposed runs with labels",()=>{
 const color:CanonicalFinding={id:"color",axis:"강조",severity:"권장",observation:"color word",sourceAtReview:"Second line",proposal:{layer:"emphasis",op:"add",entry:{id:"P2",phrase:"line",style:{color:"#0096dc"}}}};
 const item=byId(planInlineProposals({doc:markupDoc([color]),edits:{},decisions:{},baseSizes:{P2:17}}),"color");
 assert.equal(item.kind,"format");assert.equal(item.state,"available");assert.equal(item.canApply,true);
 assert.equal(item.phrase,"line");assert.equal(item.start,7);assert.equal(item.end,11);
 assert.ok(item.format);
 assert.equal(item.format.before.map(r=>r.text).join(""),"line");
 assert.equal(item.format.after.map(r=>r.text).join(""),"line");
 assert.equal(item.format.before[0].style.color,undefined);
 assert.equal(item.format.after[0].style.color,"#0096dc");
 assert.match(item.format.beforeLabel,/17px/);assert.match(item.format.beforeLabel,/기본색/);
 assert.match(item.format.afterLabel,/하늘색/);
 // A user restyle of the target locks the proposal (no position, no comparison).
 const locked=byId(planInlineProposals({doc:markupDoc([color]),edits:{P2:'Second <span style="color:#a64132">line</span>'},decisions:{}}),"color");
 assert.equal(locked.state,"changed");assert.equal(locked.canApply,false);
 assert.equal(locked.start,undefined);assert.equal(locked.format,undefined);
});

test("legacy format proposals keep the bundle freshness lock",()=>{
 const emphasis:CanonicalFinding={id:"f1",axis:"강조",severity:"권장",observation:"키워 주세요",proposal:{layer:"emphasis",op:"change",entry:{id:"T1",phrase:"잠시",style:{color:"rgb(166,65,50)",size:19,weight:700}}}};
 const legacy=(r:Partial<CanonicalReview>,f:CanonicalFinding=emphasis)=>({paragraphs:[{id:"T1",source:"벤치에서 ==잠시== 쉬었어요"}],reviews:[review([f],{bundleId:"G1",...r})]});
 const fresh=byId(planInlineProposals({doc:legacy({freshText:true}),edits:{},decisions:{}}),"f1");
 assert.equal(fresh.kind,"format");assert.equal(fresh.state,"available");assert.equal(fresh.canApply,true);
 assert.equal(fresh.start,"벤치에서 ".length);
 assert.ok(fresh.format);
 for(const [input,changed] of [[legacy({freshText:false}),[]],[legacy({freshText:true}),["G1"]],[legacy({freshText:true},{...emphasis,fresh:false}),[]]] as const){
  const item=byId(planInlineProposals({doc:input,edits:{},decisions:{},changed:[...changed]}),"f1");
  assert.equal(item.state,"changed");assert.equal(item.canApply,false);
  assert.equal(item.start,undefined);assert.equal(item.format,undefined);
  assert.ok(item.reason.length>0);
 }
});

test("diffSegments never splits an emoji or surrogate pair while refining a replaced word",()=>{
 for(const [before,after] of [["😀","😁"],["좋아요😀","좋아요😁"],["👍🏻 좋아","👍🏽 좋아"]]){
  const segments=diffSegments(before,after);
  assertReconstructs(before,after,segments);
  for(const s of segments)assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s.text),false,`${JSON.stringify(s)} split a surrogate pair`);
 }
 assert.deepEqual(diffSegments("😀","😁"),[{type:"del",text:"😀"},{type:"ins",text:"😁"}]);
});

test("targets inside a rendered link are never located; whole-link targets mark the full link",()=>{
 const source="[old cafe](https://example.com) 근처에서 쉬었어요";
 const doc=markupDoc([
  text("url","P1","example","newdomain"),
  text("label","P1","old cafe","new cafe"),
  text("whole","P1","[old cafe](https://example.com) 근처","[new cafe](https://example.com) 근처"),
  text("outside","P1","쉬었어요","쉬었다"),
 ],[{id:"P1",source}]);
 const items=planInlineProposals({doc,edits:{},decisions:{}});
 for(const id of ["url","label"]){
  const item=byId(items,id);
  assert.equal(item.canApply,false,`${id} must not be applicable`);
  assert.equal(item.state,"unsupported");
  assert.equal(item.start,undefined);assert.equal(item.deleted,undefined);
  assert.match(item.reason,/링크/);
 }
 const whole=byId(items,"whole"),link="[old cafe](https://example.com)";
 assert.equal(whole.canApply,true);assert.equal(whole.start,0);
 // The changed label lies inside the link chunk, so the deletion covers the whole link.
 assert.deepEqual(whole.deleted,[[0,link.length]]);
 const outside=byId(items,"outside");
 assert.equal(outside.canApply,true);assert.equal(source.slice(outside.start,outside.end),"쉬었어요");
});

test("proposal signatures change when a re-review reuses an id with different content",()=>{
 const first=text("f1","P1","쉬었어요","쉬었다"),second=text("f1","P1","쉬었어요","쉬었습니다");
 assert.notEqual(proposalSignature(first),proposalSignature(second));
 assert.equal(proposalSignature(first),proposalSignature({...first,observation:"다른 설명"}));
 const item=byId(planInlineProposals({doc:markupDoc([first]),edits:{},decisions:{}}),"f1");
 assert.equal(item.sig,proposalSignature(first));
});
