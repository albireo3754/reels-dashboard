import {test,expect,type Page} from "@playwright/test";
import {mkdtemp,readFile,readdir,writeFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {markupFixture} from "../fixtures/markup-editor";
import {startCanonicalEditor} from "../../src/app/blog-editor/server";
import {chooseEditorMenu,closeEditorMenu,openEditorMenu} from "./canonical-editor-helpers";
import {parse} from "../../src/shared/blog-markup";
import {bundleHashes} from "../../src/shared/blog-markup-source";

async function open(page:Page,extra="",prepare?:(config:Awaited<ReturnType<typeof markupFixture>>)=>Promise<object>){
 const root=await mkdtemp(path.join(os.tmpdir(),"autosave-web-"));
 const config=await markupFixture(root);
 if(extra)await writeFile(config.canon,await readFile(config.canon,"utf8")+extra);
 const server=await startCanonicalEditor({...config,...await prepare?.(config)});
 await page.goto(server.url+"/?blogEditor=1");
 const frame=page.frameLocator('iframe[title="정본 본문 편집"]'),status=page.locator("#ce-save-status");
 await expect(frame.locator('[data-tid="P2"]')).toBeVisible();
 // Survives only as long as the frame document does, so it proves nothing reloaded.
 await frame.locator("body").evaluate(()=>{(window as any).__sameFrame=true;});
 return {config,server,frame,status,
  file:()=>readFile(config.canon,"utf8"),
  outside:async(from:string,to:string)=>writeFile(config.canon,(await readFile(config.canon,"utf8")).replace(from,to)),
  sameFrame:()=>frame.locator("body").evaluate(()=>(window as any).__sameFrame===true),
  close:async()=>{await page.unrouteAll({behavior:"ignoreErrors"});await server.close();await rm(root,{recursive:true,force:true});}};
}
const end=(l:ReturnType<ReturnType<Page["frameLocator"]>["locator"]>)=>l.evaluate((el:HTMLElement)=>{const r=document.createRange();r.selectNodeContents(el);r.collapse(false);const s=getSelection()!;s.removeAllRanges();s.addRange(r);});
const DONE={timeout:10000};
const start=(l:ReturnType<ReturnType<Page["frameLocator"]>["locator"]>)=>l.evaluate((el:HTMLElement)=>{const r=document.createRange();r.selectNodeContents(el);r.collapse(true);const s=getSelection()!;s.removeAllRanges();s.addRange(r);});
/** Holds every save until `release` runs. */
async function hold(page:Page){
 let release=()=>{};const gate=new Promise<void>(r=>release=r);
 await page.route("**/api/blog/save",async r=>{await gate;await r.continue();});
 return ()=>release();
}
const copies=async(canon:string)=>(await readdir(path.join(path.dirname(canon),".history",path.basename(canon))).catch(()=>[] as string[])).filter(n=>n.startsWith("conflict-")).length;

test("typing a blank line saves by itself: the paragraph splits, the caret stays, no button or reload",async({page})=>{
 const s=await open(page);
 try{
  const p2=s.frame.locator('[data-tid="P2"]');
  await p2.click();await end(p2);
  await page.keyboard.type(" more");
  await page.keyboard.press("Enter");await page.keyboard.press("Enter");
  await page.keyboard.type("New part");
  await expect(s.frame.locator('[data-tid="P3"]')).toHaveText("New part",DONE);
  await expect(p2).toHaveText("Second line more");
  await expect.poll(s.file,DONE).toMatch(/¶ P2\nSecond line more\n\n¶ P3\nNew part/);
  await expect(s.status).toContainText("✓ 저장 완료",DONE);
  // The caret moved with its text, so typing simply continues.
  await page.keyboard.type("!");
  await expect(s.frame.locator('[data-tid="P3"]')).toHaveText("New part!");
  await expect.poll(s.file,DONE).toMatch(/¶ P3\nNew part!/);
  expect(await s.sameFrame()).toBe(true);
  await expect(page.getByRole("button",{name:"다시 불러오기"})).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
 }finally{await s.close();}
});
test("typing < > and an emptied paragraph never fail the save",async({page})=>{
 const s=await open(page);
 try{
  const p2=s.frame.locator('[data-tid="P2"]');
  await p2.click();await end(p2);
  await page.keyboard.type(" <b>a == b");
  await expect.poll(s.file,DONE).toContain("Second line ＜b＞a ＝＝ b");
  await page.keyboard.press("ControlOrMeta+a");await page.keyboard.press("Backspace");
  await expect.poll(s.file,DONE).toMatch(/¶ P2\n(\n|<\/Bundle>)/);
  await expect(page.locator(".ce-feedback [role=alert]")).toHaveCount(0);
  await page.keyboard.type("Back again");
  await expect.poll(s.file,DONE).toContain("Back again");
  expect(await s.sameFrame()).toBe(true);
 }finally{await s.close();}
});
test("an outside change appears with no reload, in place, while caret and unsaved text stay",async({page})=>{
 const s=await open(page);
 try{
  await s.outside("⟦First⟧","⟦Outside⟧");
  await expect(s.frame.locator('[data-tid="P1"]')).toContainText("Outside",DONE);
  await expect(s.status).toContainText("✓ 저장 완료");
  const p2=s.frame.locator('[data-tid="P2"]');
  await p2.click();await end(p2);
  await page.keyboard.type(" typing");
  await s.outside("⟦Outside⟧","⟦Outside two⟧");
  await expect(s.frame.locator('[data-tid="P1"]')).toContainText("Outside two",DONE);
  await page.keyboard.type(" on");
  await expect(p2).toHaveText("Second line typing on");
  await expect.poll(s.file,DONE).toContain("Second line typing on");
  expect(await s.file()).toContain("Outside two");
  expect(await s.sameFrame()).toBe(true);
 }finally{await s.close();}
});
test("the paragraph in focus is not overwritten; it takes the new text when focus leaves",async({page})=>{
 const s=await open(page);
 try{
  const p2=s.frame.locator('[data-tid="P2"]');
  await p2.click();
  await s.outside("Second line","Agent rewrite");
  await s.outside("⟦First⟧","⟦Outside⟧");
  await expect(s.frame.locator('[data-tid="P1"]')).toContainText("Outside",DONE);
  await expect(p2).toHaveText("Second line");
  await s.frame.locator('[data-tid="P1"]').click();
  await expect(p2).toHaveText("Agent rewrite");
  expect(await s.sameFrame()).toBe(true);
 }finally{await s.close();}
});
test("a true conflict keeps the writer's text, says so quietly and never blocks later saves",async({page})=>{
 const s=await open(page);
 try{
  // Holding the first save keeps this edit local while the file moves underneath it.
  let release=()=>{};const gate=new Promise<void>(r=>release=r);
  await page.route("**/api/blog/save",async r=>{await gate;await r.continue();});
  const p2=s.frame.locator('[data-tid="P2"]');
  await p2.click();await end(p2);
  await page.keyboard.type(" mine");
  await expect(s.status).toContainText("저장 중",DONE);
  await s.outside("Second line","Their line");
  release();
  await expect(page.locator(".ce-sync-note")).toContainText("P2",DONE);
  await expect(page.locator(".ce-sync-note")).toContainText(".history");
  await expect(p2).toHaveText("Second line mine");
  await expect.poll(s.file,DONE).toContain("Second line mine");
  await page.unrouteAll();
  await page.keyboard.type(" and more");
  await expect.poll(s.file,DONE).toContain("Second line mine and more");
  await expect(s.status).toContainText("✓ 저장 완료",DONE);
 }finally{await s.close();}
});
test("a failed save retries by itself and keeps the edit, and a busy lock only delays it",async({page})=>{
 const s=await open(page);
 try{
  await page.route("**/api/blog/save",r=>r.fulfill({status:409,contentType:"application/json",body:'{"error":"BUSY"}'}));
  const p2=s.frame.locator('[data-tid="P2"]');
  await p2.click();await end(p2);
  await page.keyboard.type(" retried");
  await expect(s.status).toContainText("저장 실패",DONE);
  await expect(page.getByRole("alert")).toContainText("다른 도구가 저장하는 중");
  await page.keyboard.type(" twice");
  await page.unrouteAll();
  await expect(s.status).toContainText("✓ 저장 완료",{timeout:20000});
  expect(await s.file()).toContain("Second line retried twice");
  await expect(p2).toHaveText("Second line retried twice");
 }finally{await s.close();}
});
test("delete stays undoable for a few seconds, then saves by itself while typing keeps saving",async({page})=>{
 const s=await open(page,'\n<Bundle id="B2" name="Second" question="what">\n¶ P3\nMiddle\n</Bundle>\n\n<Bundle id="B3" name="Third" question="end">\n¶ P4\nLast\n</Bundle>\n');
 try{
  const outline=page.getByRole("navigation",{name:"정본 묶음"});
  await outline.getByRole("button",{name:/Second/}).click();
  await chooseEditorMenu(page,"묶음 삭제");
  await expect(s.frame.locator('.editor-bundle[data-bundle="B2"]')).toBeHidden();
  const p2=s.frame.locator('[data-tid="P2"]');
  await p2.click();await end(p2);await page.keyboard.type(" typed");
  await expect.poll(s.file,DONE).toContain("Second line typed");
  expect(await s.file()).toContain('id="B2"');
  await page.getByRole("button",{name:"삭제 취소 (1)"}).click();
  await expect(s.frame.locator('.editor-bundle[data-bundle="B2"]')).toBeVisible();
  await outline.getByRole("button",{name:/Third/}).click();
  await chooseEditorMenu(page,"묶음 삭제");
  await expect.poll(s.file,{timeout:15000}).not.toContain('id="B3"');
  await expect(s.status).toContainText("✓ 저장 완료",DONE);
  await expect(page.getByRole("button",{name:/삭제 취소/})).toHaveCount(0);
  expect(await s.file()).toContain('id="B2"');
  expect(await s.sameFrame()).toBe(true);
 }finally{await s.close();}
});
test("taking typing back while its save is on the way wins over that save",async({page})=>{
 const s=await open(page);
 try{
  const release=await hold(page);
  const p2=s.frame.locator('[data-tid="P2"]');
  await p2.click();await end(p2);
  await page.keyboard.type("X");
  await expect(s.status).toContainText("저장 중",DONE);
  await page.keyboard.press("Backspace");
  release();
  await expect.poll(async()=>(await s.file()).includes("Second lineX"),DONE).toBe(false);
  await expect(s.status).toContainText("✓ 저장 완료",DONE);
  await page.locator(".ce-save-status").click();
  await s.frame.locator('[data-tid="P1"]').click();
  await expect(p2).toHaveText("Second line");
 }finally{await s.close();}
});
test("a delete already on its way cannot be cancelled, so nothing claims it was",async({page})=>{
 const s=await open(page,'\n<Bundle id="B2" name="Second" question="what">\n¶ P3\nMiddle\n</Bundle>\n');
 try{
  const release=await hold(page);
  await page.getByRole("navigation",{name:"정본 묶음"}).getByRole("button",{name:/Second/}).click();
  await chooseEditorMenu(page,"묶음 삭제");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByRole("button",{name:/삭제 취소/})).toBeDisabled(DONE);
  release();
  await expect.poll(s.file,DONE).not.toContain('id="B2"');
  await expect(page.getByRole("button",{name:/삭제 취소/})).toHaveCount(0,DONE);
 }finally{await s.close();}
});
test("a delete the server refuses comes back instead of repeating",async({page})=>{
 const s=await open(page,'\n<Bundle id="B2" name="Second" question="what">\n¶ P3\nMiddle\n</Bundle>\n');
 try{
  let posts=0;page.on("request",r=>{if(r.url().endsWith("/api/blog/save"))posts++;});
  await page.getByRole("navigation",{name:"정본 묶음"}).getByRole("button",{name:/Second/}).click();
  await chooseEditorMenu(page,"묶음 삭제");
  await writeFile(s.config.canon,(await s.file()).replace(/<Bundle id="B1"[\s\S]*?<\/Bundle>\n/,""));
  await expect(page.locator(".ce-sync-note")).toContainText("모두 지울 수는 없어요",{timeout:15000});
  await expect(s.frame.locator('.editor-bundle[data-bundle="B2"]')).toBeVisible();
  await expect(page.getByRole("button",{name:/삭제 취소/})).toHaveCount(0);
  const after=posts;
  await page.waitForTimeout(1500);
  expect(posts).toBe(after);
 }finally{await s.close();}
});
test("an outside delete of the paragraph in focus keeps it open, and typing brings it back in place",async({page})=>{
 const s=await open(page);
 try{
  await writeFile(s.config.canon,(await s.file()).replace("</Bundle>","\n¶ P3\nThird line\n</Bundle>"));
  await expect(s.frame.locator('[data-tid="P3"]')).toHaveText("Third line",DONE);
  const p2=s.frame.locator('[data-tid="P2"]');
  await p2.click();await end(p2);
  await s.outside("¶ P2\nSecond line\n\n","");
  await expect.poll(s.file,DONE).not.toContain("Second line");
  await page.waitForTimeout(2500);
  await expect(p2).toBeFocused();
  await page.keyboard.type(" typed");
  await expect.poll(s.file,DONE).toMatch(/¶ P2\nSecond line typed\n\n¶ P3/);
  await expect(page.locator(".ce-sync-note")).toContainText("P2",DONE);
  await expect(s.status).toContainText("✓ 저장 완료",DONE);
 }finally{await s.close();}
});
test("an outside delete of the paragraph in focus takes effect once focus leaves, if nothing was typed",async({page})=>{
 const s=await open(page);
 try{
  const p2=s.frame.locator('[data-tid="P2"]');
  await p2.click();await end(p2);
  await s.outside("\n¶ P2\nSecond line\n","\n");
  await page.waitForTimeout(2500);
  await expect(p2).toBeFocused();
  await s.frame.locator('[data-tid="P1"]').click();
  await expect(p2).toHaveCount(0,DONE);
  expect(await s.sameFrame()).toBe(true);
 }finally{await s.close();}
});
test("a look-alike swap of the writer's own text is not a conflict",async({page})=>{
 const s=await open(page);
 try{
  const p2=s.frame.locator('[data-tid="P2"]');
  await p2.click();await end(p2);
  await page.keyboard.type(" a<b");
  await expect.poll(s.file,DONE).toContain("a＜b");
  await expect(s.status).toContainText("✓ 저장 완료",DONE);
  await page.keyboard.type("more");
  await expect.poll(s.file,DONE).toContain("a＜bmore");
  await expect(page.locator(".ce-sync-note")).toHaveCount(0);
  expect(await copies(s.config.canon)).toBe(0);
 }finally{await s.close();}
});
test("typing over an outside title change is a real conflict: noticed and kept",async({page})=>{
 const s=await open(page);
 try{
  const title=s.frame.locator('[data-tid="$title"]');
  await title.click();await end(title);
  await s.outside("Example article","Agent title");
  await page.waitForTimeout(2500);
  await page.keyboard.type("!");
  await expect.poll(s.file,DONE).toContain("Example article!");
  await expect(page.locator(".ce-sync-note")).toContainText("제목",DONE);
  expect(await copies(s.config.canon)).toBe(1);
 }finally{await s.close();}
});
test("an emptied title says what it waits for and does not promise a save",async({page})=>{
 const s=await open(page);
 try{
  const title=s.frame.locator('[data-tid="$title"]');
  await title.click();
  await page.keyboard.press("ControlOrMeta+a");await page.keyboard.press("Backspace");
  await expect(s.status).toContainText("제목 비어 있음",DONE);
  await expect(s.status).toContainText("제목을 입력하면 저장돼요");
  await page.keyboard.type("Back");
  await expect.poll(s.file,DONE).toContain('title: "Back"');
 }finally{await s.close();}
});
test("newer typing stands on the text it came from: an outside line edit in the same paragraph survives",async({page})=>{
 const s=await open(page);
 try{
  await s.outside("Second line","L1\nL2");
  const p2=s.frame.locator('[data-tid="P2"]');
  await expect(p2).toContainText("L2",DONE);
  await expect(s.status).toContainText("✓ 저장 완료",DONE);
  const release=await hold(page);
  await p2.click();await start(p2);
  await page.keyboard.type("a");
  await expect(s.status).toContainText("저장 중",DONE);
  await s.outside("L2","L2 agent");
  await page.keyboard.type("b");
  release();
  await expect.poll(s.file,DONE).toMatch(/¶ P2\nabL1\nL2 agent/);
  await page.unrouteAll();
 }finally{await s.close();}
});
test("a selection survives the split it sits in",async({page})=>{
 const s=await open(page);
 try{
  const release=await hold(page);
  const p2=s.frame.locator('[data-tid="P2"]');
  await p2.click();await end(p2);
  await page.keyboard.press("Enter");await page.keyboard.press("Enter");
  await page.keyboard.type("Beta");
  await expect(s.status).toContainText("저장 중",DONE);
  for(let i=0;i<4;i++)await page.keyboard.press("Shift+ArrowLeft");
  release();
  await expect(s.frame.locator('[data-tid="P3"]')).toHaveText("Beta",DONE);
  expect(await s.frame.locator("body").evaluate(()=>getSelection()!.toString())).toBe("Beta");
  await page.keyboard.type("Gamma");
  await expect(s.frame.locator('[data-tid="P3"]')).toHaveText("Gamma");
  await expect.poll(s.file,DONE).toMatch(/¶ P3\nGamma/);
 }finally{await s.close();}
});
test("a frame reload puts an unsaved title back",async({page})=>{
 const s=await open(page);
 try{
  const release=await hold(page);
  const title=s.frame.locator('[data-tid="$title"]');
  await title.click();await end(title);
  await page.keyboard.type("A");
  await expect(s.status).toContainText("저장 중",DONE);
  await page.keyboard.type("B");
  await writeFile(s.config.layout,(await readFile(s.config.layout,"utf8")).replace("article{font:16px","article{font:17px"));
  release();
  await expect.poll(s.sameFrame,DONE).toBe(false);
  await expect(title).toHaveText("Example articleAB",DONE);
  await expect.poll(s.file,DONE).toContain("Example articleAB");
 }finally{await s.close();}
});
test("a proposal applied from the body counts as a change, and the old text waiting behind the caret stays gone",async({page})=>{
 const s=await open(page,"",async config=>{
  const review=path.join(path.dirname(config.canon),"reviews.json");
  await writeFile(review,JSON.stringify({reviews:[{bundleId:"B1",summary:"s",verdict:"needs-work",basedOn:bundleHashes(parse(await readFile(config.canon,"utf8"))).B1,
   findings:[{id:"f1",axis:"문장",severity:"권장",observation:"다듬어요.",proposal:{layer:"text",tid:"P2",before:"Second",after:"Other"}}]}]}));
  return {review};
 });
 try{
  const p2=s.frame.locator('[data-tid="P2"]');
  await p2.click();await end(p2);
  // The file moves while the caret is here: that text waits for focus to leave.
  await s.outside("Second line","Second line.");
  await page.waitForTimeout(2500);
  await s.frame.locator('[data-review-ui="ins"][data-pid="f1"]').first().click();
  await s.frame.locator('[data-review-ui="hint"]').getByRole("button",{name:"적용"}).click();
  await expect.poll(s.file,DONE).toContain("Other line.");
  await expect(s.status).toContainText("✓ 저장 완료",DONE);
  await expect((await openEditorMenu(page)).getByRole("menuitem",{name:/변경분 검토 \(1\)/})).toBeVisible();
  await closeEditorMenu(page);
  await s.frame.locator('[data-tid="P1"]').click();
  await page.waitForTimeout(300);
  await expect(p2).toContainText("Other line.");
  await expect(page.locator(".ce-sync-note")).toHaveCount(0);
 }finally{await s.close();}
});
test("a sync note stays in sight while the body is scrolled",async({page})=>{
 const s=await open(page,`\n<Bundle id="B2" name="Second" question="what">\n${Array.from({length:60},(_,i)=>`¶ P${i+10}\nFiller line ${i}\n`).join("\n")}</Bundle>\n`);
 try{
  await page.setViewportSize({width:360,height:700});
  const release=await hold(page);
  const last=s.frame.locator('[data-tid="P69"]');
  await last.click();await end(last);
  await page.keyboard.type(" mine");
  await expect(s.status).toContainText("저장 중",DONE);
  await s.outside("Filler line 59","Their line");
  release();
  const note=page.locator(".ce-sync-note");
  await expect(note).toContainText("P69",DONE);
  await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));
  const box=await note.evaluate(el=>{
   const r=el.getBoundingClientRect(),toolbar=document.querySelector(".ce-header")!.getBoundingClientRect();
   return {top:r.top,bottom:r.bottom,chrome:toolbar.bottom,height:innerHeight};
  });
  expect(box.top).toBeGreaterThanOrEqual(box.chrome-1);
  expect(box.bottom).toBeLessThanOrEqual(box.height);
 }finally{await s.close();}
});
