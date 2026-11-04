import {test,expect,type Page} from "@playwright/test";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {markupFixture} from "../fixtures/markup-editor";
import {startCanonicalEditor} from "../../src/app/blog-editor/server";
import type {ChatCall} from "../../src/app/blog-editor/blog-chat";
import type {BlogChatInput} from "../../src/shared/blog-chat";

// Synthetic manuscript only; the chat engine is a fake passed to the editor server.
const P3="벤치에서 잠시 쉬었어요. 바람이 좋았어요.";
const SOURCE='---\ntitle: "Example article"\nmarkup: 1\nmedia: ./media/\nnotes: article.notes.md\nstyle: {bodyPx: 16, mobileBodyPx: 17}\n---\n\n<Bundle id="B1" name="First" question="why">\n<Photo file="photo.png" alt="Example photo"/>\n\n¶ P1\n⟦First⟧¹ line\n  ¹ 적갈 up19 · main\n\n¶ P2\nSecond line\n\n¶ P3\n'+P3+'\n</Bundle>\n';
const frameOf=(page:Page)=>page.frameLocator('iframe[title="정본 본문 편집"]');

/** Select a phrase inside a paragraph the way a drag would (selectionchange fires in the frame). */
async function selectPhrase(page:Page,tid:string,phrase:string){
 await frameOf(page).locator(`[data-tid="${tid}"]`).evaluate((el,phrase)=>{
  (el as HTMLElement).focus();
  const w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
  for(let n=w.nextNode();n;n=w.nextNode()){
   const at=n.textContent!.indexOf(phrase);
   if(at<0)continue;
   const r=document.createRange();r.setStart(n,at);r.setEnd(n,at+phrase.length);
   const s=getSelection()!;s.removeAllRanges();s.addRange(r);return;
  }
  throw new Error("phrase not found");
 },phrase);
}
async function plain(page:Page,tid:string){
 return frameOf(page).locator(`[data-tid="${tid}"]`).evaluate(p=>{const c=p.cloneNode(true) as HTMLElement;c.querySelectorAll("[data-review-ui]").forEach(n=>n.remove());return c.textContent??"";});
}

test("drag → 채팅에 추가 → ask → 본문에 반영 → save, and keep the answer as a memo",async({page})=>{
 test.setTimeout(60_000);
 const root=await mkdtemp(path.join(os.tmpdir(),"canonical-chat-"));
 const received:BlogChatInput[]=[];
 const chat:ChatCall=async(input)=>{
  received.push(input);
  if(received.length>1)return {reply:"지금 문장도 자연스러워요.",rewrites:[],elapsedMs:5};
  return {reply:"‘잠시’를 ‘한참’으로 바꾸면 쉬는 시간이 더 느껴져요.",rewrites:[{paragraphId:"P3",quote:"잠시 쉬었어요",replacement:"한참 쉬었어요"},{paragraphId:"P3",quote:"잠시",replacement:"오래"}],elapsedMs:5};
 };
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
 let server:Awaited<ReturnType<typeof startCanonicalEditor>>|undefined;
 try{
  const config=await markupFixture(root);
  await writeFile(config.canon,SOURCE);
  server=await startCanonicalEditor(config,undefined,undefined,undefined,{chat});
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(server.url+"/?blogEditor=1");
  const frame=frameOf(page);
  await expect(frame.locator('[data-tid="P3"]')).toContainText("잠시");

  await selectPhrase(page,"P3","잠시 쉬었어요");
  const attach=frame.getByRole("toolbar",{name:"구절 바로 편집"}).getByRole("button",{name:"채팅에 추가"});
  await expect(attach).toBeVisible();
  await attach.click();

  const panel=page.getByRole("region",{name:"구절 채팅"});
  await expect(panel.getByRole("list",{name:"첨부한 구절"})).toContainText("P3 · 잠시 쉬었어요");
  const box=panel.getByLabel("채팅 질문");
  await expect(box).toBeFocused();
  // The same phrase is attached once.
  await selectPhrase(page,"P3","잠시 쉬었어요");
  await attach.click();
  await expect(panel.getByRole("list",{name:"첨부한 구절"}).locator("li")).toHaveCount(1);

  await box.fill("더 자연스럽게 바꿔줄래요?");
  await box.press("Enter");
  await expect(panel.locator(".ce-chat-turn.is-assistant:not(.is-pending)")).toContainText("한참");
  expect(received).toHaveLength(1);
  expect(received[0].question).toBe("더 자연스럽게 바꿔줄래요?");
  expect(received[0].attachments).toEqual([{paragraphId:"P3",quote:"잠시 쉬었어요",paragraph:P3}]);
  // Sent attachments leave the composer; the question shows them.
  await expect(panel.getByRole("list",{name:"첨부한 구절"})).toHaveCount(0);
  await expect(panel.locator(".ce-chat-turn.is-user blockquote")).toContainText("잠시 쉬었어요");

  // The answer changes nothing until 본문에 반영.
  expect(await plain(page,"P3")).toBe(P3);
  const save=page.getByRole("button",{name:"정본 저장",exact:true});
  await expect(save).toBeDisabled();
  const rewrites=panel.locator(".ce-chat-rewrite");
  await expect(rewrites).toHaveCount(2);
  await rewrites.nth(0).getByRole("button",{name:"본문에 반영"}).click();
  await expect(rewrites.nth(0).getByRole("button",{name:"반영됨 · 저장 전"})).toBeDisabled();
  await expect.poll(()=>plain(page,"P3")).toBe("벤치에서 한참 쉬었어요. 바람이 좋았어요.");
  await expect(save).toBeEnabled();
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(async()=>(await readFile(config.canon,"utf8")).includes("벤치에서 한참 쉬었어요.")).toBe(true);
  const saved=await readFile(config.canon,"utf8");
  expect(saved).not.toMatch(/채팅|본문에 반영|data-review-ui/);

  // The other rewrite targeted text that is gone now: refused without touching the body.
  await rewrites.nth(1).getByRole("button",{name:"본문에 반영"}).click();
  await expect(rewrites.nth(1).getByRole("alert")).toContainText("구절이 본문에서 바뀌었어요");
  expect(await plain(page,"P3")).toBe("벤치에서 한참 쉬었어요. 바람이 좋았어요.");

  // A follow-up carries the history.
  await box.fill("다른 표현도 있어요?");
  await box.press("Enter");
  await expect(panel.locator(".ce-chat-turn.is-assistant:not(.is-pending)")).toHaveCount(2);
  expect(received[1].history.map(t=>t.role)).toEqual(["user","assistant"]);
  expect(received[1].attachments).toEqual([]);

  // Keep the first answer as a private memo on the attached phrase... but the phrase changed,
  // so the editor says so instead of saving a memo on text that no longer exists.
  await panel.locator(".ce-chat-turn.is-assistant:not(.is-pending)").first().getByRole("button",{name:"답변을 메모로 남기기"}).click();
  await expect(panel.locator(".ce-chat-error")).toContainText("메모로 남기지 못했어요");

  // A fresh question on the current text can be kept as a memo.
  await selectPhrase(page,"P3","바람이 좋았어요");
  await attach.click();
  await expect(panel.getByRole("list",{name:"첨부한 구절"})).toContainText("바람이 좋았어요");
  await box.fill("이 문장 괜찮아요?");
  await box.press("Enter");
  await expect(panel.locator(".ce-chat-turn.is-assistant:not(.is-pending)")).toHaveCount(3);
  await panel.locator(".ce-chat-turn.is-assistant:not(.is-pending)").nth(2).getByRole("button",{name:"답변을 메모로 남기기"}).click();
  await expect(panel.getByRole("button",{name:"메모로 남김"})).toBeDisabled();
  await expect(frame.locator("[data-annotation-badge]")).toContainText("메모 1");
  const notes=JSON.parse(await readFile(config.canon+".annotations.json","utf8"));
  expect(notes).toHaveLength(1);
  expect(notes[0].quote).toBe("바람이 좋았어요");
  expect(notes[0].note).toMatch(/^Q\. 이 문장 괜찮아요\?\nA\. /);
  expect(errors).toEqual([]);
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});

test("390px: attaching opens the panel without horizontal overflow; engine errors keep the question",async({page})=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"canonical-chat-m-"));
 const chat:ChatCall=async()=>{throw new TypeError("fetch failed");};
 let server:Awaited<ReturnType<typeof startCanonicalEditor>>|undefined;
 try{
  const config=await markupFixture(root);
  await writeFile(config.canon,SOURCE);
  server=await startCanonicalEditor(config,undefined,undefined,undefined,{chat});
  await page.setViewportSize({width:390,height:844});
  await page.goto(server.url+"/?blogEditor=1");
  const frame=frameOf(page);
  await expect(frame.locator('[data-tid="P3"]')).toContainText("잠시");
  await selectPhrase(page,"P3","바람이 좋았어요");
  await frame.getByRole("button",{name:"채팅에 추가"}).click();
  const panel=page.getByRole("region",{name:"구절 채팅"});
  await expect(panel).toBeVisible();
  await expect(panel.getByLabel("채팅 질문")).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await panel.getByLabel("채팅 질문").fill("괜찮아요?");
  await panel.getByRole("button",{name:"보내기"}).click();
  await expect(panel.locator(".ce-chat-error")).toContainText("워크플로 서버");
  await expect(panel.getByLabel("채팅 질문")).toHaveValue("괜찮아요?");
  await expect(panel.getByRole("list",{name:"첨부한 구절"})).toContainText("바람이 좋았어요");
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});
