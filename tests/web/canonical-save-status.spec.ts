import {test,expect} from "@playwright/test";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {markupFixture} from "../fixtures/markup-editor";
import {startCanonicalEditor} from "../../src/app/blog-editor/server";

test("save status distinguishes dirty, saving, saved, auto-save and failed review; no reload step",async({page},info)=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"save-status-"));let server;
 try{
  const config=await markupFixture(root);server=await startCanonicalEditor(config);
  await page.goto(server.url+"/?blogEditor=1");
  const status=page.locator("#ce-save-status"),save=page.getByRole("button",{name:"정본 저장",exact:true});
  const frame=page.frameLocator('iframe[title="정본 본문 편집"]'),p=frame.locator('[data-tid="P2"]');
  await expect(status).toContainText("✓ 저장 완료");
  await expect(save).toBeDisabled();await expect(save).toHaveText("✓ 저장됨");
  await expect(status.locator("time")).toHaveAttribute("datetime",/\d{4}-/);
  await p.fill("Saved first");
  await expect(status).toContainText("저장 전 변경");
  await expect(save).toBeEnabled();
  await expect(page.getByRole("button",{name:"이 묶음 검토",exact:true})).toHaveText("저장 후 이 묶음 검토");
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  await page.route("**/api/blog/save",async route=>{await gate;await route.continue();});
  await save.click();
  await expect(status).toContainText("저장 중");
  await expect(save).toBeDisabled();
  release();
  await expect(status).toContainText("✓ 저장 완료");
  await expect(save).toHaveText("✓ 저장됨");
  const firstSaved=await readFile(config.canon,"utf8");expect(firstSaved).toContain("Saved first");
  await expect(page.getByRole("button",{name:"다시 불러오기",exact:true})).toHaveCount(0);
  await p.fill("Saved for review");
  await page.route("**/api/blog/review",route=>route.fulfill({status:200,contentType:"application/json",body:'{"id":"fixture"}'}));
  await page.getByRole("button",{name:"이 묶음 검토",exact:true}).click();
  await expect(status).toContainText("검토 전에 자동 저장했어요.");
  await expect(page.getByText("변경 내용을 먼저 저장하고 검토를 요청했어요. 따로 저장하지 않아도 됩니다.",{exact:true})).toBeVisible();
  await expect(save).toHaveText("✓ 저장됨");await expect(save).toBeDisabled();
  await page.screenshot({path:info.outputPath("save-status.png"),fullPage:true});
  await page.unroute("**/api/blog/review");
  await page.route("**/api/blog/review",route=>route.fulfill({status:409,contentType:"application/json",body:'{"error":"Fixture engine offline"}'}));
  await p.fill("Saved even if review fails");
  await page.getByRole("button",{name:"이 묶음 검토",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("저장은 완료됐지만 검토 요청에 실패");
  await expect(status).toContainText("✓ 저장 완료");
  expect(await readFile(config.canon,"utf8")).toContain("Saved even if review fails");
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});
test("save failure retains edits and never shows saved completion",async({page})=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"save-failure-"));let server;
 try{
  const config=await markupFixture(root);server=await startCanonicalEditor(config);
  const original=await readFile(config.canon,"utf8");
  await page.goto(server.url+"/?blogEditor=1");
  const p=page.frameLocator('iframe[title="정본 본문 편집"]').locator('[data-tid="P2"]');
  await p.fill("Still unsaved");
  await page.route("**/api/blog/save",route=>route.fulfill({status:409,contentType:"application/json",body:'{"error":"Fixture conflict"}'}));
  await page.getByRole("button",{name:"정본 저장",exact:true}).click();
  await expect(page.locator("#ce-save-status")).toContainText("저장 실패");
  await expect(page.getByRole("alert")).toContainText("편집 내용은 화면에 남아");
  await expect(p).toHaveText("Still unsaved");
  await expect(page.getByRole("button",{name:"정본 저장",exact:true})).toBeEnabled();
  expect(await readFile(config.canon,"utf8")).toBe(original);
  // Nobody presses anything: the retry lands it once saving works again.
  await page.unrouteAll({behavior:"ignoreErrors"});
  await expect(page.locator("#ce-save-status")).toContainText("✓ 저장 완료",{timeout:20000});
  expect(await readFile(config.canon,"utf8")).toContain("Still unsaved");
 }finally{await page.unrouteAll({behavior:"ignoreErrors"});await server?.close();await rm(root,{recursive:true,force:true});}
});
