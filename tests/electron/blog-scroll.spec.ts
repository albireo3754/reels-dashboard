import {test,expect} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {markupFixture} from '../fixtures/markup-editor';
import {launchApp,makeProfile,closeApp,cleanProfile} from './helpers';

test('embedded manuscript has no scrollbar gutter, scrolls with the page and shrinks after editing',async({},info)=>{
  const root=await makeProfile();let app;
  try{
    const config=await markupFixture(root);
    await writeFile(config.layout,'<style>html{overflow-y:scroll;scrollbar-gutter:stable}body{margin:0}main{font:16px/1.8 sans-serif}p{margin:20px 0}img{width:100px}</style>');
    const longText='Long manuscript line with enough words to wrap in the mobile body. '.repeat(80);
    await writeFile(config.canon,(await readFile(config.canon,'utf8')).replace('Second line',longText));
    await writeFile(path.join(root,'blog-projects.json'),JSON.stringify({version:1,projects:[{id:'scroll',title:'Scroll test',config}]}));
    app=await launchApp(root);const main=await app.firstWindow();
    await main.getByRole('button',{name:'블로그',exact:true}).click();
    const opened=app.waitForEvent('window');await main.getByRole('button',{name:'프로젝트 열기',exact:true}).click();
    const editor=await opened,frame=editor.frameLocator('iframe');
    await expect(frame.locator('[data-tid="P2"]')).toContainText('Long manuscript');
    const metrics=()=>editor.locator('iframe').evaluate((el:HTMLIFrameElement)=>{
      const win=el.contentWindow!,html=el.contentDocument!.documentElement;
      return {gutter:win.innerWidth-html.clientWidth,x:win.scrollX,y:win.scrollY,height:el.clientHeight,contentHeight:html.scrollHeight};
    });
    await expect.poll(async()=>(await metrics()).gutter).toBe(0);
    await expect.poll(async()=>{const m=await metrics();return m.contentHeight<=m.height+1;}).toBe(true);
    const tall=(await metrics()).height;
    const box=(await editor.locator('iframe').boundingBox())!;
    await editor.mouse.move(box.x+80,box.y+100);await editor.mouse.wheel(0,500);
    await expect.poll(()=>editor.evaluate(()=>window.scrollY)).toBeGreaterThan(100);
    expect((await metrics()).y).toBe(0);
    await frame.locator('[data-tid="P2"]').fill('Short again');
    await expect.poll(async()=>(await metrics()).height).toBeLessThan(tall/2);
    await expect.poll(async()=>{const m=await metrics();return m.gutter===0&&m.y===0&&m.contentHeight<=m.height+1;}).toBe(true);
    await editor.screenshot({path:info.outputPath('single-scroll.png')});
    // Standalone preview retains its own scrolling; only embedded frames opt out.
    await editor.getByRole('button',{name:'정본 저장',exact:true}).click();
    await expect(editor.getByText('✓ 저장 완료',{exact:true})).toBeVisible();
    await editor.goto(new URL('/api/blog/frame',editor.url()).href);
    await expect.poll(()=>editor.evaluate(()=>getComputedStyle(document.documentElement).overflowY)).toBe('scroll');
  }finally{await closeApp(app);await cleanProfile(root);}
});
