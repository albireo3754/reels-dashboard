import {test,expect} from "@playwright/test";
import {readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import {launchApp,makeProfile,closeApp,cleanProfile} from "./helpers";
import {closeEditorTab,openBlogEditor} from "./blog-editor-helpers";
import {markupFixture} from "../fixtures/markup-editor";

test("desktop sticker planning saves and reopens with clipboard handoff",async()=>{
  const profile=await makeProfile();let app;
  try{
    const config=await markupFixture(profile);
    await writeFile(path.join(profile,"blog-projects.json"),JSON.stringify({version:1,projects:[{id:"example",title:"Example project",config}]}));
    app=await launchApp(profile);
    // Verify the native clipboard bridge without replacing the user's clipboard.
    await app.evaluate(({clipboard})=>{clipboard.writeText=async(text:string)=>{(globalThis as any).stickerCopiedText=text;};});
    const main=await app.firstWindow();
    await main.getByRole("button",{name:"블로그",exact:true}).click();
    const editor=await openBlogEditor(app,main,"example");
    await editor.getByRole("button",{name:"스티커 (0)",exact:true}).click();
    await editor.getByRole("button",{name:"맛있다 스티커 자리 추가"}).click();
    const frame=editor.frameLocator('iframe[title="정본 본문 편집"]');
    await expect(frame.locator('[data-tid="P1"] + [data-sticker-id]')).toHaveCount(1);
    await editor.getByRole("button",{name:"배치 메모 복사"}).click();
    await expect(editor.getByText("현재 배치 메모를 복사했어요.",{exact:true})).toBeVisible();
    expect(await app.evaluate(()=>(globalThis as any).stickerCopiedText)).toContain("맛있다");
    await expect(editor.locator("#ce-save-status")).toContainText("✓ 저장 완료",{timeout:15000});
    await expect(editor.getByRole("button",{name:"정본 저장",exact:true})).toBeDisabled();
    expect(await readFile(config.canon,"utf8")).toContain('preset="yum"');
    await closeEditorTab(main,"Example project");
    const again=await openBlogEditor(app,main,"example");
    await expect(again.frameLocator('iframe[title="정본 본문 편집"]').locator('[data-tid="P1"] + [data-sticker-id]')).toHaveCount(1);
  }finally{await closeApp(app);await cleanProfile(profile);}
});
