import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { markupFixture } from "../fixtures/markup-editor";
import { startCanonicalEditor } from "../../src/app/blog-editor/server";
import { parse } from "../../src/shared/blog-markup";
import { stickerKey } from "../../src/shared/blog-stickers";
import { chooseEditorMenu, closeEditorMenu, openEditorMenu } from "./canonical-editor-helpers";

// Synthetic images only; the 1×1 fixture PNG stands in for analyzed frames.
const fields = (description: string, ocr: string[], faces = 0) => ({ description, tags: ["synthetic"], ocr, contextNotes: ["Writer's record"], uncertainties: ["Unclear sauce"], faceRegions: Array(faces).fill({ x: 0, y: 0, width: 1, height: 1 }) });
const photos = (text: string) => parse(text).bundles.flatMap(b => b.nodes).flatMap(n => n.kind === "component" && n.tag === "Photo" ? [n.attrs] : []);

test("search, inspect, place at a clicked gap, keep through a failed save, save and reopen",async({page},info)=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"photo-picker-"));let server;
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  try{
    const base=await markupFixture(root);
    const png=await readFile(path.join(base.media,"photo.png")),source=path.join(root,"frame.png");
    const other=Buffer.concat([png,Buffer.from("x")]),otherSource=path.join(root,"other.png");
    await writeFile(source,png);await writeFile(otherSource,other);
    const sha=(b:Buffer)=>createHash("sha256").update(b).digest("hex");
    const results=path.join(root,"results.json");
    await writeFile(results,JSON.stringify({images:[
      {id:"im-used",captureId:"A.MOV",path:source,kind:"video-frame",time:"0",sha256:sha(png),status:"resolved",fields:fields("Exterior sign.",["SINCE 1978"])},
      {id:"im-new",captureId:"B.MOV",path:otherSource,kind:"video-frame",time:"2.5",sha256:sha(other),status:"resolved",fields:fields("Red noodle bowl. Steam rises.",["MENU"],1)},
      ...Array.from({length:70},(_,i)=>({id:"im-x"+i,captureId:"C.MOV",path:otherSource,kind:"video-frame",time:String(i),sha256:sha(other),status:"resolved",fields:fields("Filler frame "+i+".",[])})),
    ]}));
    const config={...base,mediaEvidence:results};
    server=await startCanonicalEditor(config);
    await page.goto(server.url+"/?blogEditor=1");
    const frame=page.frameLocator('iframe[title="정본 본문 편집"]');
    await chooseEditorMenu(page,"사진 넣기 (0)");
    const panel=page.getByRole("region",{name:"사진 고르기"});
    await expect(panel.getByRole("status").first()).toContainText("72장 중 72장");
    await expect(panel.getByLabel("사진 검색")).toBeFocused();
    await expect(panel.getByRole("list",{name:"분석된 사진"}).locator("li")).toHaveCount(60);
    await panel.getByRole("button",{name:/더 보기/}).click();
    await expect(panel.getByRole("list",{name:"분석된 사진"}).locator("li")).toHaveCount(72);

    // Bytes already in the manuscript are marked under their evidence ID.
    await panel.getByLabel("촬영물").selectOption("A.MOV");
    await expect(panel.getByText("본문 사용")).toBeVisible();
    await panel.getByRole("button",{name:"A.MOV 0.0초 사진 보기"}).click();
    await expect(panel.getByRole("button",{name:"이 위치에 넣기"})).toBeDisabled();
    await panel.getByRole("button",{name:"← 목록으로"}).click();
    await panel.getByLabel("촬영물").selectOption("");

    await panel.getByLabel("사진 검색").fill("noodle menu");
    await expect(panel.getByRole("list",{name:"분석된 사진"}).locator("li")).toHaveCount(1);
    await panel.getByRole("button",{name:"B.MOV 2.5초 사진 보기"}).click();
    await expect(panel.getByText("얼굴 후보 1곳")).toBeVisible();
    await expect(panel.getByLabel("사진 설명")).toHaveValue("Red noodle bowl.");

    // The panel stays open while the writer clicks the manuscript to pick the gap.
    await frame.locator('[data-tid="P1"]').click();
    await expect(panel.getByLabel("사진 넣을 위치")).toHaveValue(stickerKey({bundleId:"B1",before:2}));
    await panel.getByLabel("사진 설명").fill('Bowl "close-up"');
    await panel.getByRole("button",{name:"이 위치에 넣기"}).click();
    await expect(frame.locator('[data-tid="P1"] + [data-pending-photo]')).toHaveCount(1);
    await expect(frame.locator("[data-pending-photo] img")).toHaveAttribute("alt",'Bowl "close-up"');
    await expect((await openEditorMenu(page)).getByRole("menuitem",{name:"사진 넣기 (1)",exact:true})).toBeVisible();
    await closeEditorMenu(page);
    await expect(panel.getByRole("heading",{name:"저장 전 사진 1장"})).toBeVisible();

    // Unsaved prose edits and the placement survive a failed save together.
    await frame.locator('[data-tid="P2"]').fill("Second line edited");
    await page.route("**/api/blog/save",r=>r.fulfill({status:409,contentType:"application/json",body:JSON.stringify({error:"test conflict"})}));
    await page.keyboard.press("ControlOrMeta+s");
    await expect(page.getByText(/저장하지 못했어요/)).toBeVisible();
    await expect(frame.locator("[data-pending-photo]")).toHaveCount(1);

    for(const width of [1440,390]){
      await page.setViewportSize({width,height:900});
      await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:info.outputPath(`photo-picker-${width}.png`)});
      await page.getByRole("button",{name:"정본 저장",exact:true}).click({trial:true,timeout:3000});
    }
    await page.setViewportSize({width:1440,height:900});

    // A real click: the open panel must not cover the save button it points to.
    await page.getByRole("button",{name:"정본 저장",exact:true}).click({timeout:3000});
    await page.unroute("**/api/blog/save");
    await page.keyboard.press("ControlOrMeta+s");
    await expect((await openEditorMenu(page)).getByRole("menuitem",{name:"사진 넣기 (0)",exact:true})).toBeVisible();
    await closeEditorMenu(page);
    await expect(frame.locator('[data-tid="P2"]')).toHaveText("Second line edited");
    await expect(frame.locator("[data-pending-photo]")).toHaveCount(0);
    await expect(frame.locator('[data-tid="P1"] + figure img')).toHaveAttribute("alt",'Bowl "close-up"');
    await expect.poll(()=>frame.locator('[data-tid="P1"] + figure img').evaluate((i:HTMLImageElement)=>i.complete&&i.naturalWidth>0)).toBe(true);
    expect(photos(await readFile(config.canon,"utf8")).some(a=>a.file==="im-new.png")).toBe(true);
    await expect(await readFile(path.join(config.media,"im-new.png"))).toEqual(other);

    await page.reload();
    await expect(frame.locator('[data-tid="P1"] + figure img')).toHaveCount(1);
    await chooseEditorMenu(page,"사진 넣기 (0)");
    await panel.getByLabel("사진 검색").fill("noodle");
    await expect(panel.getByText("본문 사용")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    expect(errors).toEqual([]);
  }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});

test("an unconnected project explains the setup and stays unchanged",async({page})=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"photo-picker-none-"));let server;
  try{
    const config=await markupFixture(root);const before=await readFile(config.canon,"utf8");
    server=await startCanonicalEditor(config);
    await page.goto(server.url+"/?blogEditor=1");
    await chooseEditorMenu(page,"사진 넣기 (0)");
    await expect(page.getByRole("region",{name:"사진 고르기"})).toContainText("mediaEvidence");
    await expect(page.getByRole("button",{name:"정본 저장",exact:true})).toBeDisabled();
    expect(await readFile(config.canon,"utf8")).toBe(before);
  }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});

test("a photo the server refuses is reported, retried on request, and a split before it does not move it",async({page})=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"photo-picker-held-"));let server;
  try{
    const base=await markupFixture(root);
    const source=path.join(root,"other.png"),other=Buffer.concat([await readFile(path.join(base.media,"photo.png")),Buffer.from("y")]);
    await writeFile(source,other);
    const results=path.join(root,"results.json");
    await writeFile(results,JSON.stringify({images:[{id:"im-new",captureId:"B.MOV",path:source,kind:"video-frame",time:"2.5",sha256:createHash("sha256").update(other).digest("hex"),status:"resolved",fields:fields("Red noodle bowl.",[])}]}));
    const config={...base,mediaEvidence:results};
    server=await startCanonicalEditor(config);
    await page.goto(server.url+"/?blogEditor=1");
    const frame=page.frameLocator('iframe[title="정본 본문 편집"]'),status=page.locator("#ce-save-status");
    let posts=0;page.on("request",r=>{if(r.url().endsWith("/api/blog/save"))posts++;});
    await chooseEditorMenu(page,"사진 넣기 (0)");
    const panel=page.getByRole("region",{name:"사진 고르기"});
    await panel.getByRole("button",{name:"B.MOV 2.5초 사진 보기"}).click();
    // The gap after P2, the end of the bundle.
    await panel.getByLabel("사진 넣을 위치").selectOption(stickerKey({bundleId:"B1",before:3}));
    await panel.getByRole("button",{name:"이 위치에 넣기"}).click();
    await expect(frame.locator("[data-pending-photo]")).toHaveCount(1);

    // A split saved during the undo window shifts the gaps; the photo stays after P2.
    const p1=frame.locator('[data-tid="P1"]');
    await p1.click();await page.keyboard.press("End");
    await page.keyboard.press("Enter");await page.keyboard.press("Enter");await page.keyboard.type("Middle");
    await expect.poll(async()=>readFile(config.canon,"utf8"),{timeout:10000}).toMatch(/¶ P3\nMiddle/);
    await expect(frame.locator('[data-tid="P2"] + [data-pending-photo]')).toHaveCount(1);

    await rename(source,source+".gone");
    await page.keyboard.press("ControlOrMeta+s");
    await expect(status).toContainText("일부 저장 안 됨",{timeout:10000});
    await expect(status).toContainText("사진 1장");
    await expect(page.locator(".ce-sync-note")).toContainText("사진 원본 파일을 찾지 못했어요");
    await expect(page.locator(".ce-sync-note")).not.toContainText(root);
    const after=posts;
    await page.waitForTimeout(3000);
    expect(posts).toBe(after);
    await expect(status).toContainText("일부 저장 안 됨");

    await rename(source+".gone",source);
    await page.keyboard.press("ControlOrMeta+s");
    await expect(status).toContainText("✓ 저장 완료",{timeout:10000});
    const text=await readFile(config.canon,"utf8");
    expect(text.indexOf("im-new.png")).toBeGreaterThan(text.indexOf("Second line"));
  }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});
