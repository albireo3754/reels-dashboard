import {test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {buildSuggestPrompt,cleanSuggestions,inlineSuggestInput,inlineSuggestResult} from "../../src/shared/inline-suggest";

// Synthetic manuscript text only.
const input=(over:Record<string,unknown>={})=>({
 id:randomUUID(),
 paragraphId:"P3",
 title:"합성 산책 기록",
 before:"벤치에서 잠시 쉬었어요.",
 after:" 바람이 좋았어요. 그리고 돌아왔어요.",
 context:'<Bundle id="B1" name="산책" question="어디서 쉬었나">\n¶ P3\n벤치에서 잠시 쉬었어요. 바람이 좋았어요. 그리고 돌아왔어요.\n</Bundle>',
 rules:"## 규칙\n존댓말 어미를 유지한다.",
 guidance:"확인하지 않은 경험을 만들지 않는다.",
 ...over,
});
/**
 * cleanSuggestions may return strings or {text}. It may also fit the spacing to the
 * caret (one leading space after a finished sentence), so compare trimmed content.
 */
const texts=(list:unknown[])=>list.map(s=>(typeof s==="string"?s:(s as {text:string}).text).trim());
const clean=(suggestions:string[],over:Record<string,unknown>={})=>texts(cleanSuggestions({suggestions:suggestions.map(text=>({text}))} as never,inlineSuggestInput.parse(input(over)) as never) as unknown[]);

test("inlineSuggestInput enforces the documented size limits and a uuid id",()=>{
 assert.equal(inlineSuggestInput.safeParse(input()).success,true);
 assert.equal(inlineSuggestInput.safeParse(input({title:"가".repeat(300),before:"가".repeat(4000),after:"가".repeat(4000),context:"가".repeat(60000),rules:"가".repeat(20000),guidance:"가".repeat(60000)})).success,true);
 for(const [field,size] of [["title",301],["before",4001],["after",4001],["context",60001],["rules",20001],["guidance",60001]] as const)
  assert.equal(inlineSuggestInput.safeParse(input({[field]:"가".repeat(size)})).success,false,`${field} over ${size-1} must be rejected`);
 assert.equal(inlineSuggestInput.safeParse(input({id:"not-a-uuid"})).success,false);
 assert.equal(inlineSuggestInput.safeParse(input({paragraphId:undefined})).success,false);
});

test("inlineSuggestResult allows up to three 1..240 character suggestions",()=>{
 assert.equal(inlineSuggestResult.safeParse({suggestions:[]}).success,true);
 assert.equal(inlineSuggestResult.safeParse({suggestions:[{text:"가".repeat(240)},{text:"나"},{text:"다"}]}).success,true);
 assert.equal(inlineSuggestResult.safeParse({suggestions:[{text:"가"},{text:"나"},{text:"다"},{text:"라"}]}).success,false);
 assert.equal(inlineSuggestResult.safeParse({suggestions:[{text:""}]}).success,false);
 assert.equal(inlineSuggestResult.safeParse({suggestions:[{text:"가".repeat(241)}]}).success,false);
});

test("buildSuggestPrompt carries caret context, rules and guidance with plain one-sentence instructions",()=>{
 const value=inlineSuggestInput.parse(input());
 const prompt=buildSuggestPrompt(value);
 assert.equal(typeof prompt,"string");
 for(const part of [value.before,value.after.trim(),"존댓말 어미를 유지한다.",value.guidance,value.title])assert.ok(prompt.includes(part),`prompt must include ${part}`);
 assert.ok(prompt.includes("벤치에서 잠시 쉬었어요. 바람이 좋았어요. 그리고 돌아왔어요."),"neighbouring context is included");
 assert.match(prompt,/one sentence|한 문장/i);
 assert.match(prompt,/markup|마크업/i);
 assert.match(prompt,/plain text|일반 텍스트|평문/i);
 assert.match(prompt,/data|데이터/i);
 assert.match(prompt,/empty|빈 ?(목록|배열|리스트|결과)|"suggestions":\s*\[\]/i);
 assert.match(prompt,/repeat|반복|contradict|모순/i);
});

test("cleanSuggestions trims, removes duplicates, empty and markup-only results",()=>{
 assert.deepEqual(clean(["  햇살도 따뜻했어요.  ","햇살도 따뜻했어요."]),["햇살도 따뜻했어요."]);
 assert.deepEqual(clean(["   ","⟦⟧","**"]),[]);
 assert.deepEqual(clean(["⟦정말⟧ **좋은** 하루였어요."]),["정말 좋은 하루였어요."]);
 const tagged=clean(["<b>친구와</b> ==함께== 걸었어요. ¶"]);
 assert.ok(tagged.every(t=>!/[⟦⟧¶<>*=]/.test(t)),JSON.stringify(tagged));
});

test("cleanSuggestions keeps suggestions single-line and length-capped",()=>{
 const lines=clean(["첫 문장이에요.\n둘째 문장이에요."]);
 assert.equal(lines.length,1);
 assert.ok(!/[\r\n]/.test(lines[0]));
 assert.ok(lines[0].startsWith("첫 문장이에요."));
 const long=clean(["가".repeat(300)]);
 assert.ok(long.every(t=>t.length>0&&t.length<=240),String(long.map(t=>t.length)));
});

test("cleanSuggestions never adds more than one separating space",()=>{
 const raw=cleanSuggestions({suggestions:[{text:"   햇살도 따뜻했어요.   "}]},inlineSuggestInput.parse(input()));
 const list=(raw as unknown[]).map(s=>typeof s==="string"?s:(s as {text:string}).text);
 assert.equal(list.length,1);
 assert.match(list[0],/^ ?햇살도 따뜻했어요\. ?$/);
});

test("cleanSuggestions keeps the word break a mid-sentence continuation needs before AFTER",()=>{
 // Seen with the live engine: "빵을 사서 " between "들러 " and "집에…" must not become "사서집에".
 const over={before:"돌아오는 길에 빵집에 들러 ",after:"집에 와서 바로 먹었어요."};
 const once=cleanSuggestions({suggestions:[{text:"빵을 사서 "}]},inlineSuggestInput.parse(input(over)));
 assert.deepEqual(once,["빵을 사서 "]);
 assert.deepEqual(cleanSuggestions({suggestions:once},inlineSuggestInput.parse(input(over))),once);
 // Without a trailing space from the model, nothing is invented inside a word.
 assert.deepEqual(cleanSuggestions({suggestions:[{text:"빵을 사"}]},inlineSuggestInput.parse(input({before:"들러 ",after:"서 집에 왔어요."}))),["빵을 사"]);
});

test("cleanSuggestions drops text that only repeats what follows the caret and caps at three",()=>{
 assert.deepEqual(clean(["바람이 좋았어요.","새로 이어지는 문장이에요."]),["새로 이어지는 문장이에요."]);
 assert.deepEqual(clean(["바람이 좋았어요"]),[]);
 assert.deepEqual(clean(["하나예요.","둘이에요.","셋이에요.","넷이에요.","다섯이에요."]),["하나예요.","둘이에요.","셋이에요."]);
 // With nothing after the caret every distinct sentence survives.
 assert.deepEqual(clean(["바람이 좋았어요."],{after:""}),["바람이 좋았어요."]);
});
