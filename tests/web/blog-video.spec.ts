import { test, expect } from "@playwright/test";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import path from "node:path";
import os from "node:os";
import {markupFixture} from "../fixtures/markup-editor";
import {startCanonicalEditor} from "../../src/app/blog-editor/server";

test('video markup plays and seeks inside the real editor frame with responsive crop and preserved source', async({page}, info)=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'blog-video-ui-'));let server;
 try{
  const config=await markupFixture(root);
  await promisify(execFile)('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=160x240:rate=15','-t','2','-c:v','h264_videotoolbox','-pix_fmt','yuv420p','-b:v','200k',path.join(config.media,'cheers.mp4')]);
  const source=(await readFile(config.canon,'utf8')).replace('<Photo file="photo.png" alt="Example photo"/>','<Video file="cheers.mp4" alt="잔을 맞대는 순간" poster="photo.png" caption="새 출발에 건배" ratio="4:5" fit="cover" position="50% 60%" muted/>');
  await writeFile(config.canon,source);server=await startCanonicalEditor(config);
  await page.goto(server.url+'/?blogEditor=1');
  const frame=page.frameLocator('iframe');const video=frame.locator('video');await expect(video).toBeVisible();
  await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.readyState)).toBeGreaterThanOrEqual(1);
  expect(await video.evaluate((v:HTMLVideoElement)=>({duration:v.duration,controls:v.controls,autoplay:v.autoplay,muted:v.muted}))).toEqual({duration:2,controls:true,autoplay:false,muted:true});
  await video.evaluate((v:HTMLVideoElement)=>{v.currentTime=1;return v.play();});
  await expect.poll(()=>video.evaluate((v:HTMLVideoElement)=>v.currentTime)).toBeGreaterThan(1.15);
  await video.evaluate((v:HTMLVideoElement)=>v.pause());
  for(const width of [1280,390]){
   await page.setViewportSize({width,height:900});
   expect(await video.evaluate(v=>{const r=v.getBoundingClientRect();return Math.abs(r.width/r.height-.8)<.02&&getComputedStyle(v).objectFit==='cover'&&getComputedStyle(v).objectPosition==='50% 60%';})).toBe(true);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await page.screenshot({path:info.outputPath(`video-${width}.png`),fullPage:true});
  }
  expect(await readFile(config.canon,'utf8')).toBe(source);
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});
