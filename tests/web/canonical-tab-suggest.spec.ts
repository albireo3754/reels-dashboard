import {test,expect,type Page} from "@playwright/test";
import {createServer,type Server} from "node:http";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {markupFixture} from "../fixtures/markup-editor";
import {makeCanonicalFixture} from "../fixtures/canonical-content";
import {startCanonicalEditor} from "../../src/app/blog-editor/server";
import {parse} from "../../src/shared/blog-markup";
import {bundleHashes} from "../../src/shared/blog-markup-source";

// Synthetic manuscripts only. Real manuscripts are never opened by this spec.
// LAYER 1: Tab navigation over existing review proposals.
// LAYER 2: manual "✦ 추천 받기" ghost text served by a fake workflow backend.
const HEAD='---\ntitle: "Example article"\nmarkup: 1\nmedia: ./media/\nnotes: article.notes.md\nstyle: {bodyPx: 16, mobileBodyPx: 17}\n---\n\n<Bundle id="B1" name="First" question="why">\n<Photo file="photo.png" alt="Example photo"/>\n\n¶ P1\n⟦First⟧¹ line\n  ¹ 적갈 up19 · main\n\n¶ P2\nSecond line\n';
const P3="벤치에서 잠시 쉬었어요. 바람이 좋았어요.",P4="아메리카노는 맛있었어요. 케이크도 맛있었어요.",P5="오늘은 정말 좋았어요.",P7="커피를 마셨어요.",P8="마지막 문단이에요.";
const SOURCE=HEAD+`\n¶ P3\n${P3}\n\n¶ P4\n${P4}\n\n¶ P5\n${P5}\n\n¶ P6\n[old cafe](https://example.com) 근처에서 쉬었어요.\n\n¶ P7\n${P7}\n\n¶ P8\n${P8}\n</Bundle>\n`;
const P6_TEXT="old cafe 근처에서 쉬었어요.";
const text=(id:string,tid:string,before:string,after:string)=>({id,axis:"문장",severity:"권장",observation:`${id}: 문장을 다듬어요.`,proposal:{layer:"text",tid,before,after}});
const FINDINGS=[
 text("ending","P3","쉬었어요","쉬었다"),
 text("menuA","P4","아메리카노는 맛있었어요","아메리카노는 진했어요"),
 text("menuC","P4","케이크도","케이크까지"),
 text("today","P5","정말 좋았어요","아주 좋았어요"),
 text("label","P6","old","new"),
 text("coffee","P7","커피를 마셨어요","커피를 천천히 마셨어요"),
];
const REVIEW_UI=/data-review-ui|rv-(card|stack|diff|del|ins|eq|format|note|hint)|현재 유지|AI 제안|Tab 적용|추천 받기|추천 중/;

const iframe=(page:Page)=>page.locator('iframe[title="정본 본문 편집"]');
const frameOf=(page:Page)=>page.frameLocator('iframe[title="정본 본문 편집"]');

/** Focus a paragraph and put a collapsed caret at a plain-text offset (review UI nodes are skipped). */
async function caretTo(page:Page,tid:string,offset:number|"end"){
 await frameOf(page).locator(`[data-tid="${tid}"]`).click({position:{x:2,y:2}});
 await iframe(page).evaluate((el:HTMLIFrameElement,[tid,offset])=>{
  const d=el.contentDocument!,w=el.contentWindow!,p=d.querySelector<HTMLElement>(`[data-tid="${tid}"]`)!;
  p.focus();
  const walker=d.createTreeWalker(p,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement?.closest("[data-review-ui]")?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});
  const nodes:Text[]=[];for(let n=walker.nextNode();n;n=walker.nextNode())nodes.push(n as Text);
  const total=nodes.reduce((s,n)=>s+n.data.length,0),target=offset==="end"?total:Number(offset);
  let at=0,node:Text|undefined,pos=0;
  for(const n of nodes){if(target<=at+n.data.length){node=n;pos=target-at;break;}at+=n.data.length;}
  const r=d.createRange();
  if(node)r.setStart(node,pos);else r.setStart(p,p.childNodes.length);
  r.collapse(true);
  const s=w.getSelection()!;s.removeAllRanges();s.addRange(r);
 },[tid,offset] as const);
 // Let the frame observe selectionchange (it saves the caret for host-triggered actions).
 await page.waitForTimeout(60);
}
/** Where the caret is: focused paragraph and plain-text offset, ignoring review UI (ghost, hint, spinner). */
async function caret(page:Page){
 return iframe(page).evaluate((el:HTMLIFrameElement)=>{
  const d=el.contentDocument!,s=el.contentWindow!.getSelection();
  if(!s||!s.focusNode)return null;
  const p=(s.focusNode.nodeType===1?s.focusNode as Element:s.focusNode.parentElement)?.closest<HTMLElement>("[data-tid]");
  if(!p)return null;
  const r=d.createRange();r.setStart(p,0);r.setEnd(s.focusNode,s.focusOffset);
  const frag=r.cloneContents();frag.querySelectorAll("[data-review-ui]").forEach(n=>n.remove());
  return {tid:p.dataset.tid!,offset:(frag.textContent??"").length,focused:d.activeElement===p||p.contains(d.activeElement)};
 });
}
/** Paragraph text as the manuscript sees it (review UI removed). */
async function plain(page:Page,tid:string){
 return frameOf(page).locator(`[data-tid="${tid}"]`).evaluate(p=>{const c=p.cloneNode(true) as HTMLElement;c.querySelectorAll("[data-review-ui]").forEach(n=>n.remove());return c.textContent??"";});
}
/** Dispatch a synthetic keydown on the focused paragraph and report whether the editor consumed it. */
type KeyInit={key:string;code?:string;shiftKey?:boolean;altKey?:boolean;isComposing?:boolean;keyCode?:number};
async function keydown(page:Page,tid:string,init:KeyInit){
 return frameOf(page).locator(`[data-tid="${tid}"]`).evaluate((p,init)=>{
  const ev=new KeyboardEvent("keydown",{bubbles:true,cancelable:true,composed:true,...init});
  if(init.keyCode!==undefined)Object.defineProperty(ev,"keyCode",{get:()=>init.keyCode});
  p.dispatchEvent(ev);return ev.defaultPrevented;
 },init as KeyInit);
}
async function noOverflow(page:Page){
 const pageFits=await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
 const frameFits=await iframe(page).evaluate((el:HTMLIFrameElement)=>{
  const html=el.contentDocument!.documentElement;
  const ui=[...el.contentDocument!.querySelectorAll<HTMLElement>("[data-review-ui]")].filter(n=>n.getClientRects().length);
  return html.scrollWidth<=html.clientWidth+1&&ui.every(n=>{const r=n.getBoundingClientRect();return r.left>=-1&&r.right<=html.clientWidth+1;});
 });
 return pageFits&&frameFits;
}

test.describe("Tab over review proposals (layer 1)",()=>{
 test("caret hint, Tab apply/jump, Esc keep, Shift+Tab back, blocked skip, IME and no focus trap",async({page},info)=>{
  test.setTimeout(120_000);
  const root=await mkdtemp(path.join(os.tmpdir(),"tab-review-"));let server;
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  try{
   const config={...await markupFixture(root),review:path.join(root,"reviews.json")};
   await writeFile(config.canon,SOURCE);
   await writeFile(config.review,JSON.stringify({reviews:[{bundleId:"B1",summary:"합성 문장 제안",verdict:"needs-work",basedOn:bundleHashes(parse(SOURCE)).B1,findings:FINDINGS}]}));
   server=await startCanonicalEditor(config);
   await page.setViewportSize({width:1440,height:1000});
   await page.goto(server.url+"/?blogEditor=1");
   const frame=frameOf(page);
   const card=(id:string)=>frame.locator(`.rv-card[data-proposal="${id}"]`);
   const hint=frame.locator('[data-review-ui="hint"]');
   const save=page.getByRole("button",{name:"정본 저장",exact:true});
   const list=page.locator(".ce-proposal");
   await expect(card("ending")).toBeVisible();
   await expect(card("label").locator(".rv-reason-line")).toContainText("링크");

   // No proposal in P2: no hint. First Tab only jumps to the next proposal (Copilot NES style).
   await caretTo(page,"P2","end");
   await expect(hint).toHaveCount(0);
   await page.keyboard.press("Tab");
   await expect.poll(()=>caret(page)).toEqual({tid:"P3",offset:P3.indexOf("쉬었어요"),focused:true});
   expect(await plain(page,"P3")).toBe(P3);
   await expect(save).toBeDisabled();

   // Caret on a proposal: polite hint popover under the target with the compact diff and key help.
   await expect(hint).toBeVisible();
   await expect(hint).toHaveAttribute("role","status");
   await expect(hint).toHaveAttribute("aria-live","polite");
   await expect(hint).toContainText("Tab 적용");
   await expect(hint).toContainText("Esc 유지");
   await expect(hint).toContainText("어요");
   await expect(hint.getByRole("button",{name:"다시 검토"})).toHaveCount(1);
   expect(await frame.locator('[data-tid="P3"]').evaluate(p=>!p.querySelector("[data-review-ui]"))).toBe(true);
   const placement=await iframe(page).evaluate((el:HTMLIFrameElement)=>{
    const d=el.contentDocument!,h=d.querySelector<HTMLElement>('[data-review-ui="hint"]')!.getBoundingClientRect(),p=d.querySelector('[data-tid="P3"]')!.getBoundingClientRect();
    return {below:h.top>=p.top,near:h.top<=p.bottom+80,inside:h.left>=0&&h.right<=d.documentElement.clientWidth+1};
   });
   expect(placement).toEqual({below:true,near:true,inside:true});
   await page.screenshot({path:info.outputPath("tab-hint-desktop.png")});

   // Tab on an applicable proposal applies it through the normal path and moves to the next one.
   await page.keyboard.press("Tab");
   await expect.poll(()=>plain(page,"P3")).toBe("벤치에서 잠시 쉬었다. 바람이 좋았어요.");
   await expect(card("ending")).toHaveCount(0);
   await expect(save).toBeEnabled();
   expect(await readFile(config.canon,"utf8")).toBe(SOURCE);
   await expect.poll(()=>caret(page)).toEqual({tid:"P4",offset:0,focused:true});
   await expect(hint).toContainText("진했");

   // Esc keeps the current text (screen-only decision) and moves on.
   await page.keyboard.press("Escape");
   await expect(card("menuA")).toHaveCount(0);
   expect(await plain(page,"P4")).toBe(P4);
   await expect(list.filter({hasText:"아메리카노는 진했어요"})).toHaveAttribute("data-state","decided");
   await expect.poll(()=>caret(page)).toEqual({tid:"P4",offset:P4.indexOf("케이크도"),focused:true});

   // Shift+Tab walks back across paragraphs, skipping the blocked link proposal in P6.
   await caretTo(page,"P6","end");
   await page.keyboard.press("Shift+Tab");
   await expect.poll(()=>caret(page)).toEqual({tid:"P5",offset:P5.indexOf("정말"),focused:true});
   await page.keyboard.press("Shift+Tab");
   await expect.poll(()=>caret(page)).toEqual({tid:"P4",offset:P4.indexOf("케이크도"),focused:true});
   expect(await plain(page,"P4")).toBe(P4);
   expect(await plain(page,"P5")).toBe(P5);

   // Apply menuC, then today; the next jump skips the blocked P6 proposal and lands on P7.
   await page.keyboard.press("Tab");
   await expect.poll(()=>plain(page,"P4")).toBe("아메리카노는 맛있었어요. 케이크까지 맛있었어요.");
   await expect.poll(()=>caret(page)).toEqual({tid:"P5",offset:P5.indexOf("정말"),focused:true});
   await page.keyboard.press("Tab");
   await expect.poll(()=>plain(page,"P5")).toBe("오늘은 아주 좋았어요.");
   await expect.poll(()=>caret(page)).toEqual({tid:"P7",offset:0,focused:true});
   expect(await plain(page,"P6")).toBe(P6_TEXT);
   await expect(card("label").locator(".rv-reason-line")).toContainText("링크");
   await expect(card("label").getByRole("button",{name:"적용",exact:true})).toBeDisabled();

   // IME: a Tab keydown during composition (or keyCode 229) is ignored and not consumed.
   expect(await keydown(page,"P7",{key:"Tab",code:"Tab",isComposing:true})).toBe(false);
   expect(await keydown(page,"P7",{key:"Tab",code:"Tab",keyCode:229})).toBe(false);
   await page.waitForTimeout(200);
   expect(await plain(page,"P7")).toBe(P7);
   await expect(card("coffee")).toBeVisible();

   // Esc keeps the last proposal; with nothing ahead or behind, Tab/Shift+Tab are not trapped.
   await page.keyboard.press("Escape");
   await expect(card("coffee")).toHaveCount(0);
   expect(await plain(page,"P7")).toBe(P7);
   await caretTo(page,"P8","end");
   await expect(hint).toHaveCount(0);
   expect(await keydown(page,"P8",{key:"Tab",code:"Tab"})).toBe(false);
   expect(await keydown(page,"P8",{key:"Tab",code:"Tab",shiftKey:true})).toBe(false);
   // Esc with no active proposal keeps the default behaviour too.
   expect(await keydown(page,"P8",{key:"Escape",code:"Escape"})).toBe(false);
   expect(await plain(page,"P8")).toBe(P8);
   expect(await readFile(config.canon,"utf8")).toBe(SOURCE);

   // Save: applied text only; no hint/review UI in the source or the derived preview.
   await save.click();
   await expect(page.getByText("정본과 미리보기를 저장했어요.",{exact:false})).toBeVisible();
   const saved=await readFile(config.canon,"utf8");
   expect(saved).toContain("벤치에서 잠시 쉬었다. 바람이 좋았어요.");
   expect(saved).toContain("아메리카노는 맛있었어요. 케이크까지 맛있었어요.");
   expect(saved).toContain("오늘은 아주 좋았어요.");
   expect(saved).toContain(P7);
   expect(saved).not.toMatch(REVIEW_UI);
   expect(await readFile(config.layout,"utf8")).not.toMatch(REVIEW_UI);
   expect(errors).toEqual([]);
  }finally{await server?.close();await rm(root,{recursive:true,force:true});}
 });

 test("hint popover stays inside the paper on a 390px phone",async({page},info)=>{
  test.setTimeout(60_000);
  const root=await mkdtemp(path.join(os.tmpdir(),"tab-review-mobile-"));let server;
  try{
   const config={...await markupFixture(root),review:path.join(root,"reviews.json")};
   await writeFile(config.canon,SOURCE);
   await writeFile(config.review,JSON.stringify({reviews:[{bundleId:"B1",summary:"합성 문장 제안",verdict:"needs-work",basedOn:bundleHashes(parse(SOURCE)).B1,findings:FINDINGS}]}));
   server=await startCanonicalEditor(config);
   await page.setViewportSize({width:390,height:844});
   await page.goto(server.url+"/?blogEditor=1");
   const frame=frameOf(page);
   await expect(frame.locator('.rv-card[data-proposal="menuA"]')).toBeVisible();
   await caretTo(page,"P4",0);
   const hint=frame.locator('[data-review-ui="hint"]');
   await expect(hint).toBeVisible();
   await expect(hint).toContainText("Tab 적용");
   await expect.poll(()=>noOverflow(page)).toBe(true);
   await hint.scrollIntoViewIfNeeded();
   await page.screenshot({path:info.outputPath("tab-hint-mobile.png")});
   expect(await readFile(config.canon,"utf8")).toBe(SOURCE);
  }finally{await server?.close();await rm(root,{recursive:true,force:true});}
 });
});

/** Fake workflow backend for `suggest-inline` with a per-request delay and answer. */
async function fakeSuggestEngine(){
 const received:any[]=[];
 const state={next:{delay:200,suggestions:[] as string[]}};
 const server:Server=createServer(async(req,res)=>{
  let body="";for await(const c of req)body+=c;
  if(req.url!=="/api/workflows/suggest-inline"){res.writeHead(404,{"Content-Type":"application/json"});res.end('{"error":"Unknown workflow action"}');return;}
  const input=JSON.parse(body),plan=state.next;received.push(input);
  const started=Date.now();
  await new Promise(r=>setTimeout(r,plan.delay));
  if(res.destroyed)return;
  res.writeHead(200,{"Content-Type":"application/json"});
  // The real action returns cleaned strings; raw {text} is accepted by the editor too.
  res.end(JSON.stringify({id:input.id,suggestions:plan.suggestions,elapsedMs:Date.now()-started}));
 });
 await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
 return {url:"http://127.0.0.1:"+(server.address() as {port:number}).port,received,state,
  close:()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());})};
}
const SUGGEST_SOURCE=HEAD+"\n¶ P3\n벤치에서 잠시 쉬었어요.\n\n¶ P4\n커피를 마셨어요.\n</Bundle>\n";

test.describe("manual suggest with ghost text (layer 2)",()=>{
 test("spinner while waiting, gray ghost at caret, Tab/Esc/cycle/word accept, discard and cancel",async({page},info)=>{
  test.setTimeout(150_000);
  const root=await mkdtemp(path.join(os.tmpdir(),"tab-suggest-"));let server;
  const engine=await fakeSuggestEngine();
  const previousUrl=process.env.REELS_WORKFLOW_URL;process.env.REELS_WORKFLOW_URL=engine.url;
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  try{
   const config=await markupFixture(root);
   await writeFile(config.canon,SUGGEST_SOURCE);
   server=await startCanonicalEditor(config);
   await page.setViewportSize({width:1440,height:1000});
   await page.goto(server.url+"/?blogEditor=1");
   const frame=frameOf(page);
   const ghost=frame.locator('[data-review-ui="ghost"]');
   const spinner=frame.locator('[data-review-ui="spinner"]');
   const suggestButton=page.locator("button",{hasText:"추천 받기"});
   const pendingButton=page.locator("button",{hasText:"추천 중"});
   const save=page.getByRole("button",{name:"정본 저장",exact:true});
   const P3S="벤치에서 잠시 쉬었어요.";
   await expect(frame.locator('[data-tid="P3"]')).toHaveText(P3S);
   await expect(suggestButton).toBeEnabled();
   await expect(suggestButton).toHaveAttribute("aria-keyshortcuts","Alt+Backslash");

   // (1) Button click: spinner at the caret and on the button while the engine waits.
   engine.state.next={delay:1800,suggestions:[" 바람이 정말 좋았어요."," 햇살도 따뜻했어요."," 다음에 또 올게요."]};
   await caretTo(page,"P3","end");
   await suggestButton.click();
   await expect(pendingButton).toBeVisible();
   await expect(pendingButton).toContainText("Esc");
   await expect(spinner).toBeVisible();
   expect(await iframe(page).evaluate((el:HTMLIFrameElement)=>{
    const d=el.contentDocument!,s=d.querySelector('[data-review-ui="spinner"]')!.getBoundingClientRect(),p=d.querySelector('[data-tid="P3"]')!.getBoundingClientRect();
    return s.top+s.height/2>=p.top-30&&s.top+s.height/2<=p.bottom+30&&s.left>=p.left-30;
   })).toBe(true);
   await page.screenshot({path:info.outputPath("suggest-spinner-desktop.png")});

   // (2) Gray ghost text at the caret; not part of the manuscript, save stays disabled.
   await expect(ghost).toContainText("바람이 정말 좋았어요.");
   await expect(spinner).toHaveCount(0);
   await expect(suggestButton).toBeVisible();
   expect(engine.received[0].paragraphId).toBe("P3");
   expect(engine.received[0].before).toBe(P3S);
   expect(engine.received[0].after).toBe("");
   const ghostInfo=await iframe(page).evaluate((el:HTMLIFrameElement)=>{
    const d=el.contentDocument!,g=d.querySelector<HTMLElement>('[data-review-ui="ghost"]')!,p=g.closest<HTMLElement>("[data-tid]");
    const r=d.createRange();r.setStart(p!,0);r.setEndBefore(g);
    const frag=r.cloneContents();frag.querySelectorAll("[data-review-ui]").forEach(n=>n.remove());
    const cs=getComputedStyle(g);
    return {tid:p?.dataset.tid,prefix:frag.textContent,color:cs.color,pointer:cs.pointerEvents,editable:g.getAttribute("contenteditable"),hidden:g.getAttribute("aria-hidden")};
   });
   expect(ghostInfo).toEqual({tid:"P3",prefix:P3S,color:"rgb(154, 162, 156)",pointer:"none",editable:"false",hidden:"true"});
   expect(await plain(page,"P3")).toBe(P3S);
   await expect(save).toBeDisabled();
   // Screen readers hear the suggestion through a live region (host or frame).
   await expect.poll(()=>page.evaluate(()=>{
    const docs=[document,...[...document.querySelectorAll("iframe")].map(f=>f.contentDocument).filter(Boolean) as Document[]];
    return docs.some(d=>[...d.querySelectorAll("[aria-live]")].some(n=>n.textContent?.includes("바람이 정말 좋았어요.")));
   })).toBe(true);
   // The paragraph has the caret so the ghost keys work right after a button click.
   await expect.poll(async()=>(await caret(page))?.focused).toBe(true);
   await page.screenshot({path:info.outputPath("suggest-ghost-desktop.png")});

   // (3) Alt+] / Alt+[ cycle alternatives with a position indicator.
   await page.keyboard.press("Alt+BracketRight");
   await expect(ghost).toContainText("햇살도 따뜻했어요.");
   await expect.poll(()=>page.evaluate(()=>{
    const docs=[document,...[...document.querySelectorAll("iframe")].map(f=>f.contentDocument).filter(Boolean) as Document[]];
    return docs.some(d=>d.body.textContent?.includes("2/3"));
   })).toBe(true);
   await page.keyboard.press("Alt+BracketLeft");
   await expect(ghost).toContainText("바람이 정말 좋았어요.");
   expect(await plain(page,"P3")).toBe(P3S);

   // (4) Tab accepts: real text insertion through the normal change path.
   await page.keyboard.press("Tab");
   await expect(ghost).toHaveCount(0);
   await expect.poll(()=>plain(page,"P3")).toMatch(/^벤치에서 잠시 쉬었어요\.\s?바람이 정말 좋았어요\.$/);
   await expect(save).toBeEnabled();
   expect(await readFile(config.canon,"utf8")).toBe(SUGGEST_SOURCE);
   const accepted=await plain(page,"P3");
   // Manual only: typing never asks the engine.
   await page.keyboard.type(" ");
   await page.keyboard.press("Backspace");
   await page.waitForTimeout(700);
   expect(engine.received).toHaveLength(1);
   await expect.poll(async()=>(await plain(page,"P3")).replace(/\s/g," ")).toBe(accepted.replace(/\s/g," "));

   // (5) Alt+\ inside the frame asks again; Esc dismisses without touching the text.
   engine.state.next={delay:300,suggestions:[" 무시할 추천 문장이에요."]};
   await page.keyboard.press("Alt+Backslash");
   await expect(ghost).toContainText("무시할 추천 문장이에요.");
   expect(engine.received.at(-1).before.replace(/\s/g," ")).toBe(accepted.replace(/\s/g," "));
   await page.keyboard.press("Escape");
   await expect(ghost).toHaveCount(0);
   expect((await plain(page,"P3")).replace(/\s/g," ")).toBe(accepted.replace(/\s/g," "));

   // (6) Cmd/Ctrl+→ accepts one 어절 (with its following space) and keeps the rest as ghost.
   engine.state.next={delay:300,suggestions:[" 햇살도 따뜻했어요."]};
   await page.keyboard.press("Alt+Backslash");
   await expect(ghost).toContainText("햇살도 따뜻했어요.");
   await page.keyboard.press("ControlOrMeta+ArrowRight");
   await expect.poll(()=>plain(page,"P3")).toMatch(/햇살도\s$/);
   await expect(ghost).toContainText("따뜻했어요.");
   await expect(ghost).not.toContainText("햇살도");
   await page.keyboard.press("Escape");
   await expect(ghost).toHaveCount(0);
   const partial=await plain(page,"P3");
   expect(partial).not.toContain("따뜻했어요");

   // (7) Typing a character different from the ghost's first one dismisses it and types normally.
   engine.state.next={delay:300,suggestions:[" 다음에 또 올게요."]};
   await page.keyboard.press("Alt+Backslash");
   await expect(ghost).toContainText("다음에 또 올게요.");
   await page.keyboard.type("Z");
   await expect(ghost).toHaveCount(0);
   await expect.poll(async()=>(await plain(page,"P3")).replace(/\s/g," ")).toBe((partial+"Z").replace(/\s/g," "));

   // (8) Caret moved to another paragraph while waiting: result is discarded with a notice.
   engine.state.next={delay:1500,suggestions:[" 버려져야 하는 문장이에요."]};
   await page.keyboard.press("Alt+Backslash");
   await expect(spinner).toBeVisible();
   await caretTo(page,"P4","end");
   await expect(page.getByText("본문이 바뀌어 추천을 버렸어요. 다시 요청해주세요.",{exact:false})).toBeVisible({timeout:10_000});
   await expect(ghost).toHaveCount(0);
   await expect(spinner).toHaveCount(0);
   expect(await plain(page,"P4")).toBe("커피를 마셨어요.");

   // (9) Esc while waiting cancels: spinner removed, button idle, no late ghost.
   engine.state.next={delay:2500,suggestions:[" 늦게 도착한 문장이에요."]};
   await caretTo(page,"P4","end");
   await page.keyboard.press("Alt+Backslash");
   await expect(spinner).toBeVisible();
   await expect(pendingButton).toBeVisible();
   await page.keyboard.press("Escape");
   await expect(spinner).toHaveCount(0);
   await expect(suggestButton).toBeEnabled();
   await page.waitForTimeout(3000);
   await expect(ghost).toHaveCount(0);
   expect(await plain(page,"P4")).toBe("커피를 마셨어요.");

   // (10) An empty answer is reported, nothing is inserted.
   engine.state.next={delay:100,suggestions:[]};
   await caretTo(page,"P4","end");
   await page.keyboard.press("Alt+Backslash");
   await expect(page.getByText("이 위치에 추천할 문장이 없어요.",{exact:false})).toBeVisible();
   await expect(ghost).toHaveCount(0);

   // (11) Phone width: spinner and a long ghost stay inside the paper without horizontal scroll.
   await page.setViewportSize({width:390,height:844});
   engine.state.next={delay:1500,suggestions:[" 모바일에서도 회색 추천 문장이 종이 폭 안에서 자연스럽게 줄바꿈되는지 확인하는 긴 문장이에요."]};
   await caretTo(page,"P4","end");
   await page.keyboard.press("Alt+Backslash");
   await expect(spinner).toBeVisible();
   await expect.poll(()=>noOverflow(page)).toBe(true);
   await page.screenshot({path:info.outputPath("suggest-spinner-mobile.png")});
   await expect(ghost).toContainText("모바일에서도");
   await expect.poll(()=>noOverflow(page)).toBe(true);
   await page.screenshot({path:info.outputPath("suggest-ghost-mobile.png")});
   await page.keyboard.press("Escape");
   await expect(ghost).toHaveCount(0);
   await page.setViewportSize({width:1440,height:1000});

   // (12) Save: only accepted text reaches the canonical source and preview.
   await save.click();
   await expect(page.getByText("정본과 미리보기를 저장했어요.",{exact:false})).toBeVisible();
   const saved=await readFile(config.canon,"utf8");
   expect(saved).toContain("바람이 정말 좋았어요.");
   expect(saved).toContain("햇살도");
   expect(saved).toContain("Z");
   for(const rejected of ["따뜻했어요","무시할 추천","다음에 또 올게요","버려져야","늦게 도착한","모바일에서도"])expect(saved).not.toContain(rejected);
   expect(saved).not.toMatch(REVIEW_UI);
   const layout=await readFile(config.layout,"utf8");
   expect(layout).not.toMatch(REVIEW_UI);
   expect(layout).not.toContain("모바일에서도");
   expect(errors).toEqual([]);
  }finally{
   await server?.close();await engine.close();
   if(previousUrl===undefined)delete process.env.REELS_WORKFLOW_URL;else process.env.REELS_WORKFLOW_URL=previousUrl;
   await rm(root,{recursive:true,force:true});
  }
 });

 test("late answers are dropped after focus, selection or link-label moves; typing-through and host IME Esc",async({page})=>{
  test.setTimeout(120_000);
  const root=await mkdtemp(path.join(os.tmpdir(),"tab-suggest-fresh-"));let server;
  const engine=await fakeSuggestEngine();
  const previousUrl=process.env.REELS_WORKFLOW_URL;process.env.REELS_WORKFLOW_URL=engine.url;
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  const SOURCE5=HEAD+"\n¶ P3\n벤치에서 잠시 쉬었어요.\n\n¶ P4\n커피를 마셨어요.\n\n¶ P5\n[old cafe](https://example.com) 근처에서 쉬었어요.\n</Bundle>\n";
  try{
   const config=await markupFixture(root);
   await writeFile(config.canon,SOURCE5);
   server=await startCanonicalEditor(config);
   await page.setViewportSize({width:1440,height:1000});
   await page.goto(server.url+"/?blogEditor=1");
   const frame=frameOf(page);
   const ghost=frame.locator('[data-review-ui="ghost"]');
   const spinner=frame.locator('[data-review-ui="spinner"]');
   const pendingButton=page.locator("button",{hasText:"추천 중"});
   const stale=page.getByText("본문이 바뀌어 추천을 버렸어요. 다시 요청해주세요.",{exact:false});
   await expect(frame.locator('[data-tid="P5"]')).toContainText("old cafe");
   const activeTag=()=>iframe(page).evaluate((el:HTMLIFrameElement)=>{const a=el.contentDocument!.activeElement as HTMLElement|null;return a?.dataset.tid??a?.tagName??"";});
   const selection=()=>iframe(page).evaluate((el:HTMLIFrameElement)=>{const s=el.contentWindow!.getSelection()!;return {collapsed:s.isCollapsed,text:s.toString()};});

   // (a) Focus moves to another control inside the frame while waiting: cancelled at once, no focus steal.
   engine.state.next={delay:1200,suggestions:[" 포커스를 뺏으면 안 되는 문장이에요."]};
   await caretTo(page,"P3","end");
   await page.keyboard.press("Alt+Backslash");
   await expect(spinner).toBeVisible();
   await iframe(page).evaluate((el:HTMLIFrameElement)=>{const d=el.contentDocument!,b=d.createElement("button");b.id="probe-control";b.textContent="probe";d.body.append(b);b.focus();});
   await expect(stale).toBeVisible();
   await expect(spinner).toHaveCount(0);
   await page.waitForTimeout(1600);
   await expect(ghost).toHaveCount(0);
   expect(await activeTag()).toBe("BUTTON");
   await iframe(page).evaluate((el:HTMLIFrameElement)=>el.contentDocument!.getElementById("probe-control")?.remove());

   // (b) Focus leaves the paragraph without a new target (blur): the late answer is discarded, focus stays away.
   engine.state.next={delay:800,suggestions:[" 블러 뒤에 도착한 문장이에요."]};
   await caretTo(page,"P3","end");
   await page.keyboard.press("Alt+Backslash");
   await expect(spinner).toBeVisible();
   await frame.locator('[data-tid="P3"]').evaluate(p=>(p as HTMLElement).blur());
   await expect(spinner).toHaveCount(0,{timeout:10_000});
   await expect(pendingButton).toHaveCount(0);
   await expect(stale).toBeVisible();
   await expect(ghost).toHaveCount(0);
   expect(await activeTag()).toBe("BODY");
   expect(await plain(page,"P3")).toBe("벤치에서 잠시 쉬었어요.");

   // (c) A selection made while waiting (same end offset) discards the answer and keeps the selection.
   engine.state.next={delay:1200,suggestions:[" 선택을 지우면 안 되는 문장이에요."]};
   await caretTo(page,"P4","end");
   await page.keyboard.press("Alt+Backslash");
   await expect(spinner).toBeVisible();
   await page.keyboard.press("Shift+ArrowLeft");
   await page.keyboard.press("Shift+ArrowLeft");
   expect(await selection()).toEqual({collapsed:false,text:"요."});
   await expect(spinner).toHaveCount(0,{timeout:10_000});
   await expect(pendingButton).toHaveCount(0);
   await expect(stale).toBeVisible();
   await expect(ghost).toHaveCount(0);
   expect(await selection()).toEqual({collapsed:false,text:"요."});
   expect(await plain(page,"P4")).toBe("커피를 마셨어요.");

   // (d) Inside a link label the request is refused (no engine call); a caret moved into the label while waiting discards the answer.
   const before=engine.received.length;
   await caretTo(page,"P5",3);
   await page.keyboard.press("Alt+Backslash");
   await expect(page.getByText("링크 글자 안에서는 추천할 수 없어요.",{exact:false})).toBeVisible();
   await expect(spinner).toHaveCount(0);
   await page.waitForTimeout(300);
   expect(engine.received.length).toBe(before);
   engine.state.next={delay:1200,suggestions:["링크 앞에 들어가면 안 돼요 "]};
   await caretTo(page,"P5",0);
   await page.keyboard.press("Alt+Backslash");
   await expect(spinner).toBeVisible();
   await expect.poll(()=>engine.received.length).toBe(before+1);
   await caretTo(page,"P5",6);
   await expect(spinner).toHaveCount(0,{timeout:10_000});
   await expect(pendingButton).toHaveCount(0);
   await expect(stale).toBeVisible();
   await expect(ghost).toHaveCount(0);
   expect(await plain(page,"P5")).toBe("old cafe 근처에서 쉬었어요.");

   // (e) Typing the chosen suggestion to its last character finishes it; another candidate never takes over.
   engine.state.next={delay:200,suggestions:["Hi!","Hi! ok"]};
   await caretTo(page,"P3","end");
   await page.keyboard.press("Alt+Backslash");
   await expect(ghost).toHaveText(" Hi!");
   await page.keyboard.type(" Hi");
   await expect(ghost).toHaveText("!");
   await page.keyboard.type("!");
   await expect(ghost).toHaveCount(0);
   await expect.poll(()=>plain(page,"P3")).toBe("벤치에서 잠시 쉬었어요. Hi!");

   // (f) Esc that ends an IME composition in a host field does not cancel the pending request.
   engine.state.next={delay:1500,suggestions:[" IME 뒤에도 살아 있는 문장이에요."]};
   await caretTo(page,"P4","end");
   await page.keyboard.press("Alt+Backslash");
   await expect(pendingButton).toBeVisible();
   await page.evaluate(()=>{
    window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",isComposing:true,bubbles:true,cancelable:true}));
    const ev=new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true});Object.defineProperty(ev,"keyCode",{get:()=>229});window.dispatchEvent(ev);
   });
   await expect(pendingButton).toBeVisible();
   await expect(ghost).toContainText("IME 뒤에도 살아 있는 문장이에요.");
   await page.keyboard.press("Escape");
   await expect(ghost).toHaveCount(0);
   expect(await readFile(config.canon,"utf8")).toBe(SOURCE5);
   expect(errors).toEqual([]);
  }finally{
   await server?.close();await engine.close();
   if(previousUrl===undefined)delete process.env.REELS_WORKFLOW_URL;else process.env.REELS_WORKFLOW_URL=previousUrl;
   await rm(root,{recursive:true,force:true});
  }
 });

 test("legacy documents keep the suggest button disabled with an explanation",async({page})=>{
  const fixture=await makeCanonicalFixture();
  const server=await startCanonicalEditor(fixture.config);
  try{
   await page.goto(server.url+"/?blogEditor=1");
   await expect(page.frameLocator('iframe[title="정본 본문 편집"]').getByRole("textbox",{name:"T1 문단"})).toContainText("벤치에서");
   const button=page.locator("button",{hasText:"추천 받기"});
   await expect(button).toBeDisabled();
   await expect(button).toHaveAttribute("title",/.+/);
   expect(await readFile(fixture.config.canon,"utf8")).toBe(fixture.raw);
  }finally{await server.close();await rm(fixture.root,{recursive:true,force:true});}
 });
});
