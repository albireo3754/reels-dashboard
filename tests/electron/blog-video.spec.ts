import {test,expect} from '@playwright/test';
import {writeFile,readFile,symlink,realpath} from 'node:fs/promises';
import path from 'node:path';
import {launchApp,makeProfile,closeApp,cleanProfile} from './helpers';
import {openBlogEditor,editorIframe} from './blog-editor-helpers';
import {markupFixture} from '../fixtures/markup-editor';
import { writeBlogCards } from '../fixtures/blog-cards';

test('real local video decodes, plays and seeks in the desktop markup editor',async({},info)=>{
 test.skip(!process.env.REELS_BLOG_VIDEO_SOURCE,'Explicit local video opt-in');
 const profile=await makeProfile();let app;
 try{
  const source=await realpath(process.env.REELS_BLOG_VIDEO_SOURCE!);const config=await markupFixture(profile);
  await symlink(source,path.join(config.media,'cheers.MOV'));
  const input=(await readFile(config.canon,'utf8')).replace('<Photo file="photo.png" alt="Example photo"/>','<Video file="cheers.MOV" alt="건배 영상" ratio="4:5" fit="cover" position="50% 60%" muted/>');
  await writeFile(config.canon,input);
  await writeBlogCards(profile, [{id:'video-fixture',title:'Video fixture',config}]);
  app=await launchApp(profile);const main=await app.firstWindow();await main.getByRole('button',{name:'블로그',exact:true}).click();
  const editor=await openBlogEditor(app,main,'video-fixture');const frame=editor.frameLocator('iframe[title="정본 본문 편집"]');const video=frame.locator('video');
  await expect(video).toBeVisible();await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>({ready:v.readyState,error:v.error?.message??null})),{timeout:20000}).toMatchObject({error:null});
  await video.evaluate((v:HTMLVideoElement)=>v.play());await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.currentTime),{timeout:15000}).toBeGreaterThan(.2);
  await video.evaluate((v:HTMLVideoElement)=>{v.pause();v.currentTime=3;});await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.readyState)).toBeGreaterThanOrEqual(2);
  const metadata=await video.evaluate((v:HTMLVideoElement)=>({width:v.videoWidth,height:v.videoHeight,duration:v.duration,time:v.currentTime,fit:getComputedStyle(v).objectFit,position:getComputedStyle(v).objectPosition}));
  expect(metadata.width).toBeGreaterThan(0);expect(metadata.duration).toBeGreaterThan(3);expect(metadata.time).toBeCloseTo(3,1);expect(metadata.fit).toBe('cover');
  await editorIframe(main,'video-fixture').screenshot({path:info.outputPath('real-video.png')});
  await writeFile(info.outputPath('playback.json'),JSON.stringify(metadata,null,2));expect(await readFile(config.canon,'utf8')).toBe(input);
 }finally{await closeApp(app);await cleanProfile(profile);}
});

test('private article renders and plays at blog review widths without changing the manuscript',async()=>{
 test.skip(!process.env.REELS_BLOG_ARTICLE_CONFIG,'Explicit private article opt-in');
 const profile=await makeProfile();let app;let server;
 try{
  const config=JSON.parse(await readFile(process.env.REELS_BLOG_ARTICLE_CONFIG!,'utf8'));
  const original=await readFile(config.canon,'utf8'), output=process.env.REELS_BLOG_ARTICLE_EVIDENCE!;
  if(!output)throw new Error('Private evidence output directory is required');
  await (await import('node:fs/promises')).mkdir(output,{recursive:true});
  const {startCanonicalEditor}=await import('../../src/app/blog-editor/server');
  server=await startCanonicalEditor(config);
  app=await launchApp(profile);
  // The exact production frame in an isolated hidden Electron window. Avoid an
  // outer editor iframe's resize/scroll feedback when capturing an entire article.
  const next=app.waitForEvent('window');
  await app.evaluate(async({BrowserWindow},url)=>{
    const preview=new BrowserWindow({show:false,width:900,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false}});
    await preview.loadURL(url);
  },server.url+'/api/blog/frame');
  const page=await next;const video=page.locator('video[aria-label*="맥주잔"]');
  for(const item of await page.locator('video').all()) {
   const status=await item.evaluate((v:HTMLVideoElement)=>({src:v.currentSrc,error:v.error?.message??null,ready:v.readyState}));
   await item.evaluate((v:HTMLVideoElement)=>v.play()).catch(e=>{throw new Error(JSON.stringify(status)+' '+String(e));});
   await expect.poll(()=>item.evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(.15);
   await item.evaluate((v:HTMLVideoElement)=>{v.pause();v.currentTime=Math.min(3,v.duration*.6);});
  }
  for(const width of [360,390,430,900]){
   await page.setViewportSize({width,height:900});
   await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode()));});
   const result=await page.locator('article').evaluate(el=>({width:el.getBoundingClientRect().width,scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,images:[...document.images].map(i=>({ok:i.complete&&i.naturalWidth>0})),font:getComputedStyle(el).fontFamily,video:{width:document.querySelector('video')!.videoWidth,height:document.querySelector('video')!.videoHeight,time:document.querySelector('video')!.currentTime,error:document.querySelector('video')!.error?.message??null}}));
   expect(result.images.every(i=>i.ok)).toBe(true);expect(result.scroll).toBeLessThanOrEqual(result.client+1);expect(result.video.error).toBeNull();expect(result.video.width).toBeGreaterThan(0);
   await page.screenshot({path:path.join(output,`article-${width}.png`),fullPage:true});
   await video.screenshot({path:path.join(output,`cheers-${width}.png`)});
   await writeFile(path.join(output,`inspection-${width}.json`),JSON.stringify(result,null,2));
  }
  expect(await readFile(config.canon,'utf8')).toBe(original);
 }finally{await closeApp(app);await server?.close();await cleanProfile(profile);}
});
