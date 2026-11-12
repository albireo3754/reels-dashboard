import {test,expect} from '@playwright/test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {markupFixture} from '../fixtures/markup-editor';
import {launchApp,makeProfile,closeApp,cleanProfile} from './helpers';
import {closeEditorTab,editorIframe,openBlogEditor,windowCount} from './blog-editor-helpers';
import { writeBlogCards } from '../fixtures/blog-cards';

test('blog projects open isolated editors, reuse tabs and retain connections after restart',async({},testInfo)=>{
  const profile=await makeProfile();let app;
  try{
    const projects:Array<{id:string;title:string;config:Awaited<ReturnType<typeof markupFixture>>}>=[];
    for(const id of ['first','second']){
      const root=path.join(profile,id);await mkdir(root);
      const config=await markupFixture(root);
      projects.push({id,title:`${id} project`,config});
    }
    await writeBlogCards(profile, projects);
    const secondBefore=await readFile(projects[1].config.canon,'utf8');
    app=await launchApp(profile);
    let main=await app.firstWindow();
    await main.getByRole('button',{name:'블로그',exact:true}).click();
    const card=(id:string)=>main.getByRole('article',{name:`${id} project`,exact:true});
    await expect(card('first')).toBeVisible();await expect(card('second')).toBeVisible();
    await expect(main.getByRole('button',{name:'정본 스마트 에디터 열기',exact:true})).toHaveCount(0);
    await main.screenshot({path:testInfo.outputPath('blog-projects.png')});
    const windows=await windowCount(app);
    const first=await openBlogEditor(app,main,'first',card('first'));
    await expect(first.getByText('✓ 저장 완료',{exact:true})).toBeVisible();
    await main.getByRole('tab',{name:'프로젝트',exact:true}).click();
    await card('first').getByRole('button',{name:'프로젝트 열기',exact:true}).click();
    await expect(editorIframe(main,'first')).toBeVisible();
    await expect(main.locator('iframe.blog-editor-frame')).toHaveCount(1);
    const second=await openBlogEditor(app,main,'second',card('second'));
    await expect(second.getByText('✓ 저장 완료',{exact:true})).toBeVisible();
    expect(await windowCount(app)).toBe(windows);
    expect(new URL(second.url()).origin).not.toBe(new URL(first.url()).origin);
    // Tabs: the first project's editor is hidden behind the second until its tab is selected.
    await expect(editorIframe(main,'first')).toBeHidden();
    await main.getByRole('tab',{name:'first project',exact:true}).click();
    await first.frameLocator('iframe[title="정본 본문 편집"]').locator('[data-tid="P2"]').fill('Only first project changed');
    await expect(first.locator("#ce-save-status")).toContainText("✓ 저장 완료",{timeout:15000});
    await expect.poll(()=>readFile(projects[0].config.canon,'utf8')).toContain('Only first project changed');
    expect(await readFile(projects[1].config.canon,'utf8')).toBe(secondBefore);
    await main.getByRole('tab',{name:'second project',exact:true}).click();
    await expect(second.frameLocator('iframe[title="정본 본문 편집"]').locator('[data-tid="P2"]')).toHaveText('Second line');
    await closeEditorTab(main,'second project');
    await expect(main.evaluate(()=>window.reels!.blog!.openCanonical!('missing'))).rejects.toThrow();
    await closeApp(app);app=await launchApp(profile);main=await app.firstWindow();
    await main.getByRole('button',{name:'블로그',exact:true}).click();
    await expect(card('second')).toBeVisible();
    const reopened=await openBlogEditor(app,main,'first',card('first'));
    await expect(reopened.frameLocator('iframe[title="정본 본문 편집"]').locator('[data-tid="P2"]')).toHaveText('Only first project changed');
  }finally{await closeApp(app);await cleanProfile(profile);}
});

test('unconfigured blog shows an empty project list without opening a default manuscript',async()=>{
  const profile=await makeProfile();let app;
  try{
    app=await launchApp(profile);const main=await app.firstWindow();
    await main.getByRole('button',{name:'블로그',exact:true}).click();
    await expect(main.getByText('아직 연결된 블로그 프로젝트가 없어요.',{exact:true})).toBeVisible();
    await expect(main.getByRole('button',{name:'프로젝트 열기',exact:true})).toHaveCount(0);
    // A card whose manuscript cannot open is reported in the list, with its reason.
    const manuscript=path.join(profile,'no-media.md');await writeFile(manuscript,'---\nmarkup: 1\ntitle: x\n---\n');
    await writeFile(path.join(profile,'dashboard.json'),JSON.stringify({schemaVersion:1,updatedAt:new Date().toISOString(),projects:[{id:'broken',title:'Broken card',date:'2026-11-12',stage:'editing',nextAction:'',publicURL:'',shared:false,resources:[{role:'document',path:manuscript,label:'원고'}]}]}));
    await main.getByRole('button',{name:'프로젝트 새로고침',exact:true}).click();
    await expect(main.getByText('원고가 연결됐지만 목록에 넣지 못한 콘텐츠 1개')).toBeVisible();
    await expect(main.getByText(/Broken card/)).toBeVisible();
  }finally{await closeApp(app);await cleanProfile(profile);}
});
