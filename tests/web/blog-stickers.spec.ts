import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { markupFixture } from "../fixtures/markup-editor";
import { startCanonicalEditor } from "../../src/app/blog-editor/server";
import { parse } from "../../src/shared/blog-markup";
import { stickerPlan, stickerKey } from "../../src/shared/blog-stickers";
import { chooseEditorMenu } from "./canonical-editor-helpers";

test("place, move, save and reopen native sticker slots alongside unsaved prose at desktop and mobile widths",async({page,context},info)=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"sticker-ui-"));let server;
  try{
    const config=await markupFixture(root);
    await writeFile(config.canon,(await readFile(config.canon,"utf8")).replace('<Photo','<Title>Hidden source title</Title>\n<Photo'));
    server=await startCanonicalEditor(config);
    await context.grantPermissions(['clipboard-read','clipboard-write'],{origin:server.url});
    await page.goto(server.url+'/?blogEditor=1');
    const frame=page.frameLocator('iframe[title="정본 본문 편집"]');
    await chooseEditorMenu(page,'스티커 (0)');
    await frame.locator('[data-tid="P1"]').click();
    await expect(page.getByLabel('새 스티커 위치')).toHaveValue(stickerKey({bundleId:'B1',before:3}));
    await page.getByRole('button',{name:'맛있다 스티커 자리 추가'}).click();
    await expect(frame.locator('[data-sticker-id]')).toHaveCount(1);
    await expect(frame.locator('[data-tid="P1"] + [data-sticker-id]')).toHaveCount(1);
    await expect(page.getByRole('button',{name:'추천 스티커 자리 추가'})).toBeDisabled();
    // A failed save must retain both text and sticker planning in the current frame.
    await page.route('**/api/blog/save',r=>r.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'test conflict'})}));
    await frame.locator('[data-tid="P2"]').fill('Second line edited');
    await page.getByLabel('스티커 1 선택 메모').fill('기본 만족 표정');
    await page.getByLabel('스티커 1 위치',{exact:true}).selectOption(stickerKey({bundleId:'B1',before:2}));
    await expect(frame.locator('.photo-block + [data-sticker-id]')).toHaveCount(1);
    await expect(frame.locator('[data-tid="P2"]')).toHaveText('Second line edited');
    await page.getByRole('button',{name:'배치 메모 복사'}).click();
    expect(await page.evaluate(()=>navigator.clipboard.readText())).toContain('기본 만족 표정');
    await expect(page.getByText(/저장하지 못했어요/)).toBeVisible();
    await expect(frame.locator('[data-sticker-id]')).toContainText('기본 만족 표정');
    await page.unroute('**/api/blog/save');
    await page.getByRole('button',{name:'정본 저장',exact:true}).click();
    await expect(page.getByRole('button',{name:'정본 저장',exact:true})).toBeDisabled();
    expect(stickerPlan(parse(await readFile(config.canon,'utf8')))[0].before).toBe(2);
    await page.reload();
    await expect(frame.locator('.photo-block + [data-sticker-id]')).toHaveCount(1);
    await expect(frame.locator('[data-tid="P2"]')).toHaveText('Second line edited');
    await chooseEditorMenu(page,'스티커 (1)');
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:1000});
      await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await expect.poll(()=>page.locator('iframe').evaluate((el:HTMLIFrameElement)=>el.contentDocument!.documentElement.scrollWidth<=el.contentDocument!.documentElement.clientWidth)).toBe(true);
      await page.screenshot({path:info.outputPath(`stickers-${width}.png`),fullPage:true});
    }
    await page.getByLabel('스티커 1 삭제',{exact:true}).click();
    await expect(frame.locator('[data-sticker-id]')).toHaveCount(0);
    await expect.poll(async()=>stickerPlan(parse(await readFile(config.canon,'utf8'))),{timeout:10000}).toEqual([]);
    await page.reload();await expect(frame.locator('[data-sticker-id]')).toHaveCount(0);
  }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});
