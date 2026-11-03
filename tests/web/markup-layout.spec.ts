import {test,expect} from '@playwright/test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {markupFixture} from '../fixtures/markup-editor';
import {startCanonicalEditor} from '../../src/app/blog-editor/server';

test('linked layout CSS fits photos and collages without nested scroll or duplicate title',async({page},info)=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'markup-layout-'));let server;
  try{
    const config=await markupFixture(root);
    const source=(await readFile(config.canon,'utf8')).replace('<Photo file="photo.png" alt="Example photo"/>','<Title>Old duplicate title</Title>\n<Photo file="photo.svg" alt="Large photo"/>\n<Collage layout="2x1" files="photo.svg · photo.svg" alts="Left · Right"/>');
    await writeFile(config.canon,source);
    await writeFile(path.join(config.media,'photo.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#789987"/></svg>');
    await writeFile(path.join(root,'layout.css'),'body{margin:0}*{box-sizing:border-box}article{word-break:keep-all}h1{font:700 24px/1.5 sans-serif;margin:0}figure{margin:28px 0}img{display:block;width:100%;height:auto}.photo-grid4{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}');
    await writeFile(config.layout,'<!doctype html><html><head><link rel="stylesheet" href="layout.css"><style>article{color:rgb(48,48,46)}</style></head><body><main><article></article></main></body></html>');
    server=await startCanonicalEditor(config);
    await page.goto(server.url+'/?blogEditor=1');
    const frame=page.frameLocator('iframe[title="정본 본문 편집"]');
    await expect(frame.locator('h1')).toHaveCount(1);
    await expect(frame.locator('article')).toHaveCSS('color','rgb(48, 48, 46)');
    await expect(frame.locator('.photo-grid4')).toHaveCSS('display','grid');
    for(const [width,mode] of [[1440,'430'],[1440,'900'],[720,'430'],[390,'430']] as const){
      await page.setViewportSize({width,height:900});
      await page.getByLabel('본문 보기 폭',{exact:true}).selectOption(mode);
      await expect.poll(()=>page.locator('iframe').evaluate((el:HTMLIFrameElement)=>{
        const d=el.contentDocument!,html=d.documentElement;
        return [...d.images].every(i=>i.complete&&i.naturalWidth>0)&&html.scrollWidth<=html.clientWidth+1&&html.scrollHeight<=html.clientHeight+1;
      })).toBe(true);
      await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.screenshot({path:info.outputPath('linked-layout.png')});
    expect(await readFile(config.canon,'utf8')).toBe(source);
  }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});
