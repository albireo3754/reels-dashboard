import {test,expect} from '@playwright/test';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {markupFixture} from '../fixtures/markup-editor';
import {launchApp,makeProfile,closeApp,cleanProfile} from './helpers';

test('blog projects open isolated editors, reuse windows and retain connections after restart',async({},testInfo)=>{
  const profile=await makeProfile();let app;
  try{
    const projects:Array<{id:string;title:string;config:Awaited<ReturnType<typeof markupFixture>>}>=[];
    for(const id of ['first','second']){
      const root=path.join(profile,id);await mkdir(root);
      const config=await markupFixture(root);
      projects.push({id,title:`${id} project`,config});
    }
    await writeFile(path.join(profile,'blog-projects.json'),JSON.stringify({version:1,projects}));
    const secondBefore=await readFile(projects[1].config.canon,'utf8');
    app=await launchApp(profile);
    let main=await app.firstWindow();
    await main.getByRole('button',{name:'블로그',exact:true}).click();
    const card=(id:string)=>main.getByRole('article',{name:`${id} project`,exact:true});
    await expect(card('first')).toBeVisible();await expect(card('second')).toBeVisible();
    await expect(main.getByRole('button',{name:'정본 스마트 에디터 열기',exact:true})).toHaveCount(0);
    await main.screenshot({path:testInfo.outputPath('blog-projects.png')});
    let opened=app.waitForEvent('window');
    await card('first').getByRole('button',{name:'프로젝트 열기',exact:true}).click();
    const first=await opened;
    await expect(first.getByText('✓ 저장 완료',{exact:true})).toBeVisible();
    const windows=app.windows().length;
    await card('first').getByRole('button',{name:'프로젝트 열기',exact:true}).click();
    expect(app.windows()).toHaveLength(windows);
    opened=app.waitForEvent('window');
    await card('second').getByRole('button',{name:'프로젝트 열기',exact:true}).click();
    const second=await opened;
    await expect(second.getByText('✓ 저장 완료',{exact:true})).toBeVisible();
    expect(new URL(second.url()).origin).not.toBe(new URL(first.url()).origin);
    await first.frameLocator('iframe[title="정본 본문 편집"]').locator('[data-tid="P2"]').fill('Only first project changed');
    await first.getByRole('button',{name:'정본 저장',exact:true}).click();
    await expect.poll(()=>readFile(projects[0].config.canon,'utf8')).toContain('Only first project changed');
    expect(await readFile(projects[1].config.canon,'utf8')).toBe(secondBefore);
    await expect(second.frameLocator('iframe[title="정본 본문 편집"]').locator('[data-tid="P2"]')).toHaveText('Second line');
    await expect(main.evaluate(()=>window.reels!.blog!.openCanonical!('missing'))).rejects.toThrow();
    await closeApp(app);app=await launchApp(profile);main=await app.firstWindow();
    await main.getByRole('button',{name:'블로그',exact:true}).click();
    await expect(card('second')).toBeVisible();
    opened=app.waitForEvent('window');
    await card('first').getByRole('button',{name:'프로젝트 열기',exact:true}).click();
    await expect((await opened).frameLocator('iframe[title="정본 본문 편집"]').locator('[data-tid="P2"]')).toHaveText('Only first project changed');
  }finally{await closeApp(app);await cleanProfile(profile);}
});

test('unconfigured blog shows an empty project list without opening a default manuscript',async()=>{
  const profile=await makeProfile();let app;
  try{
    app=await launchApp(profile);const main=await app.firstWindow();
    await main.getByRole('button',{name:'블로그',exact:true}).click();
    await expect(main.getByText('아직 연결된 블로그 프로젝트가 없어요.',{exact:true})).toBeVisible();
    await expect(main.getByRole('button',{name:'프로젝트 열기',exact:true})).toHaveCount(0);
  }finally{await closeApp(app);await cleanProfile(profile);}
});
