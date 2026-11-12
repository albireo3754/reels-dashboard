import {test} from "node:test";
import assert from "node:assert/strict";
import {hasBodyMark,proposalChip,proposalSummary} from "../../src/features/canonical-blog/model/proposal-view";
import type {InlineProposal} from "../../src/shared/inline-review";
import type {CanonicalDocument} from "../../src/shared/canonical-blog";

const item=(over:Partial<InlineProposal>):InlineProposal=>({id:"F1",findingId:"F1",bundleId:"B1",kind:"text",observation:"obs",state:"available" as InlineProposal["state"],canApply:false,reason:"",sig:"s",...over});
const doc=(bundleIds:string[])=>({bundles:bundleIds.map(id=>({id}))}) as unknown as CanonicalDocument;

test("proposalChip covers every state branch",()=>{
 assert.deepStrictEqual(proposalChip(item({state:"decided",decision:"현재 유지"})),{label:"현재 유지",tone:"kept"});
 assert.deepStrictEqual(proposalChip(item({state:"decided",decision:"직접 수정"})),{label:"직접 수정",tone:"applied"});
 assert.deepStrictEqual(proposalChip(item({state:"decided"})),{label:"적용 · 저장 전",tone:"applied"});
 assert.deepStrictEqual(proposalChip(item({state:"applied"})),{label:"반영됨",tone:"applied"});
 assert.deepStrictEqual(proposalChip(item({state:"changed"})),{label:"본문 변경됨",tone:"blocked"});
 assert.deepStrictEqual(proposalChip(item({kind:"note",state:"note"})),{label:"의견",tone:"note"});
 assert.deepStrictEqual(proposalChip(item({canApply:true})),{label:"적용 가능",tone:"available"});
 assert.deepStrictEqual(proposalChip(item({canApply:false})),{label:"위치 확인 불가",tone:"blocked"});
});

test("proposalSummary clips text before/after at 40 characters and marks deletions",()=>{
 const forty="가".repeat(40),over=forty+"나";
 assert.equal(proposalSummary(item({kind:"text",before:forty,after:"b"})),forty+" → b");
 assert.equal(proposalSummary(item({kind:"text",before:over,after:over})),forty+"… → "+forty+"…");
 assert.equal(proposalSummary(item({kind:"text",before:"a"})),"a → (삭제)");
 assert.equal(proposalSummary(item({kind:"text",before:"a",after:""})),"a → (삭제)");
 assert.equal(proposalSummary(item({kind:"text"})),` → (삭제)`);
});

test("proposalSummary formats format proposals and clips notes to the first line at 80",()=>{
 assert.equal(proposalSummary(item({kind:"format",phrase:"강조"})),"“강조” 서식");
 assert.equal(proposalSummary(item({kind:"format"})),"“” 서식");
 assert.equal(proposalSummary(item({kind:"format",phrase:"x".repeat(41)})),"“"+"x".repeat(40)+"…” 서식");
 const eighty="y".repeat(80);
 assert.equal(proposalSummary(item({kind:"note",observation:eighty})),eighty);
 assert.equal(proposalSummary(item({kind:"note",observation:eighty+"z"})),eighty+"…");
 assert.equal(proposalSummary(item({kind:"note",observation:"first\nsecond"})),"first");
 assert.equal(proposalSummary(item({kind:"note",observation:""})),"");
});

test("hasBodyMark hides finished proposals and otherwise needs a paragraph or a known bundle",()=>{
 for(const state of ["applied","decided","changed"] as const)assert.equal(hasBodyMark(item({state,paragraphId:"P1"}),doc(["B1"])),false,state);
 assert.equal(hasBodyMark(item({kind:"text",paragraphId:"P1"}),doc([])),true);
 assert.equal(hasBodyMark(item({kind:"format"}),doc(["B1"])),false);
 assert.equal(hasBodyMark(item({kind:"note",state:"note",paragraphId:"P1"}),doc([])),true);
 assert.equal(hasBodyMark(item({kind:"note",state:"note"}),doc(["B1"])),true);
 assert.equal(hasBodyMark(item({kind:"note",state:"note"}),doc(["B2"])),false);
});
