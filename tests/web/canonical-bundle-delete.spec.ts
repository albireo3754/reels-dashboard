import {test,expect} from "@playwright/test";
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {markupFixture} from "../fixtures/markup-editor";
import {startCanonicalEditor} from "../../src/app/blog-editor/server";
import {closeEditorMenu,openEditorMenu} from "./canonical-editor-helpers";

async function threeBundles(root:string){
 const config=await markupFixture(root);
 const text=await readFile(config.canon,"utf8");
 await writeFile(config.canon,text+'\n<Bundle id="B2" name="Second" question="what">\n¶ P3\nMiddle bundle text\n</Bundle>\n\n<Bundle id="B3" name="Third" question="end">\n¶ P4\nLast bundle text\n</Bundle>\n');
 return config;
}
test("Cmd/Ctrl+S saves edits from inside the frame and from the host page",async({page})=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"bundle-save-"));let server;
 try{
  const config=await threeBundles(root);server=await startCanonicalEditor(config);
  await page.goto(server.url+"/?blogEditor=1");
  const status=page.locator("#ce-save-status"),frame=page.frameLocator('iframe[title="정본 본문 편집"]');
  await expect(status).toContainText("✓ 저장 완료");
  const p=frame.locator('[data-tid="P2"]');
  await p.fill("Saved with shortcut");
  await expect(status).toContainText("저장 전 변경");
  await p.press("ControlOrMeta+s");
  await expect(status).toContainText("✓ 저장 완료");
  expect(await readFile(config.canon,"utf8")).toContain("Saved with shortcut");
  await frame.locator('[data-tid="P3"]').fill("Host shortcut");
  // Focus leaves the frame for the host page (the quiet status line is plain host text).
  await page.locator("#ce-save-status").click();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(status).toContainText("✓ 저장 완료");
  expect(await readFile(config.canon,"utf8")).toContain("Host shortcut");
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.getByText("저장할 변경이 없어요.",{exact:true}).first()).toBeVisible();
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});
test("a picked bundle is deleted with Delete, can be undone, and is removed from the source only on save",async({page})=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"bundle-delete-"));let server;
 try{
  const config=await threeBundles(root);server=await startCanonicalEditor(config);
  await page.goto(server.url+"/?blogEditor=1");
  const status=page.locator("#ce-save-status"),frame=page.frameLocator('iframe[title="정본 본문 편집"]');
  const outline=page.getByRole("navigation",{name:"정본 묶음"});
  await expect(outline.getByRole("button")).toHaveCount(3);
  // Backspace inside text keeps editing text, never deletes the bundle.
  const p3=frame.locator('[data-tid="P3"]');
  await p3.click();await page.keyboard.press("End");await page.keyboard.press("Backspace");
  await expect(p3).not.toHaveText("Middle bundle text");await expect(p3).toHaveText(/^Middle b/);
  await expect(outline.getByRole("button")).toHaveCount(3);
  // Clicking the bundle label picks the bundle; Delete removes it from the screen.
  await frame.locator('.editor-bundle[data-bundle="B2"] .editor-bundle-label').click();
  await expect(frame.locator('.editor-bundle[data-bundle="B2"]')).toHaveClass(/picked/);
  await page.keyboard.press("Delete");
  await expect(frame.locator('.editor-bundle[data-bundle="B2"]')).toBeHidden();
  await expect(outline.getByRole("button")).toHaveCount(2);
  await expect(status).toContainText("저장 전 변경");
  expect(await readFile(config.canon,"utf8")).toContain('id="B2"');
  await page.getByRole("button",{name:"삭제 취소 (1)"}).click();
  await expect(frame.locator('.editor-bundle[data-bundle="B2"]')).toBeVisible();
  await expect(outline.getByRole("button")).toHaveCount(3);
  // Backspace on the picked bundle also deletes; Cmd/Ctrl+S persists it.
  await frame.locator('.editor-bundle[data-bundle="B2"] .editor-bundle-label').click();
  await page.keyboard.press("Backspace");
  await expect(frame.locator('.editor-bundle[data-bundle="B2"]')).toBeHidden();
  await page.keyboard.press("ControlOrMeta+s");
  await expect(status).toContainText("✓ 저장 완료");
  const saved=await readFile(config.canon,"utf8");
  expect(saved).not.toContain('id="B2"');expect(saved).toContain('id="B1"');expect(saved).toContain('id="B3"');
  await expect(outline.getByRole("button")).toHaveCount(2);
  // Outline item + Delete, and the last bundle is protected.
  await outline.getByRole("button",{name:/Third/}).focus();
  await page.keyboard.press("Delete");
  await expect(outline.getByRole("button")).toHaveCount(1);
  await page.getByRole("button",{name:"정본 저장",exact:true}).click();
  await expect(status).toContainText("✓ 저장 완료");
  const menu=await openEditorMenu(page);
  await expect(menu.getByRole("menuitem",{name:"묶음 삭제",exact:true})).toBeDisabled();
  await closeEditorMenu(page);
  await frame.locator('.editor-bundle[data-bundle="B1"] .editor-bundle-label').click();
  await page.keyboard.press("Delete");
  await expect(page.getByRole("alert")).toContainText("마지막 묶음은 지울 수 없어요.");
  expect(await readFile(config.canon,"utf8")).toContain('id="B1"');
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});
test("Backspace in an emptied paragraph removes it; emptying a bundle's last paragraph removes the bundle",async({page})=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"para-delete-"));let server;
 try{
  const config=await markupFixture(root);
  const text=await readFile(config.canon,"utf8");
  await writeFile(config.canon,text+'\n<Bundle id="B2" name="Second" question="what">\n¶ P3\nKeep this text\n\n¶ P5\nxy\n</Bundle>\n\n<Bundle id="B3" name="Third" question="end">\n¶ P4\nz\n</Bundle>\n');
  server=await startCanonicalEditor(config);
  await page.goto(server.url+"/?blogEditor=1");
  const status=page.locator("#ce-save-status"),frame=page.frameLocator('iframe[title="정본 본문 편집"]');
  const outline=page.getByRole("navigation",{name:"정본 묶음"});
  await expect(outline.getByRole("button")).toHaveCount(3);
  // Deleting the text keeps the paragraph; one more Backspace on the empty paragraph removes it.
  const p5=frame.locator('[data-tid="P5"]');
  const toEnd=(l:typeof p5)=>l.evaluate((el:HTMLElement)=>{const r=document.createRange();r.selectNodeContents(el);r.collapse(false);const s=getSelection()!;s.removeAllRanges();s.addRange(r);});
  await p5.click();await toEnd(p5);
  await page.keyboard.press("Backspace");await page.keyboard.press("Backspace");
  await expect(p5).toBeVisible();await expect(p5).toHaveText("");
  await page.keyboard.press("Backspace");
  await expect(p5).toBeHidden();
  await expect(outline.getByRole("button")).toHaveCount(3);
  // The caret moved to the end of the previous paragraph; typing continues there.
  await page.keyboard.type("!");
  await expect(frame.locator('[data-tid="P3"]')).toHaveText("Keep this text!");
  await expect(status).toContainText("저장 전 변경");
  expect(await readFile(config.canon,"utf8")).toContain("¶ P5");
  // Undo restores it on screen.
  await page.getByRole("button",{name:"삭제 취소 (1)"}).click();
  await expect(p5).toBeVisible();
  await p5.click();await page.keyboard.press("Backspace");
  await expect(p5).toBeHidden();
  // The only paragraph of B3: emptying it and pressing Backspace removes the bundle.
  const p4=frame.locator('[data-tid="P4"]');
  await p4.click();await toEnd(p4);await page.keyboard.press("Backspace");
  await expect(p4).toHaveText("");await page.keyboard.press("Backspace");
  await expect(frame.locator('.editor-bundle[data-bundle="B3"]')).toBeHidden();
  await expect(outline.getByRole("button")).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+s");
  await expect(status).toContainText("✓ 저장 완료");
  const saved=await readFile(config.canon,"utf8");
  expect(saved).not.toContain("¶ P5");expect(saved).not.toContain('id="B3"');
  expect(saved).toContain("Keep this text!");expect(saved).toContain('id="B2"');
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});
