import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import {chromium} from '@playwright/test';
const origin=process.env.PWA_TEST_ORIGIN??'http://127.0.0.1:5227';
assert.ok(['127.0.0.1','localhost'].includes(new URL(origin).hostname),'This fixture test must never target production');
const artifacts=path.resolve(process.env.PWA_ARTIFACT_DIR??'artifacts/pwa');await mkdir(artifacts,{recursive:true});
const manifest=JSON.parse(await readFile('public/manifest.webmanifest','utf8'));
assert.equal(manifest.display,'standalone');assert.equal(manifest.id,'/');assert.equal(manifest.start_url,'/');assert.equal(manifest.scope,'/');
for(const size of [192,512])assert.ok(manifest.icons.some(i=>i.sizes===`${size}x${size}`));
// A redirect/login/error must never enter the offline cache.
const source=await readFile('public/sw.js','utf8');
async function workerCase({redirected=false,body='<main data-briefing-offline>offline</main>'}={}){
 const handlers={};let puts=0;
 const response=new Response(body,{headers:{'content-type':'text/html'}});
 Object.defineProperty(response,'url',{value:origin+'/offline'});Object.defineProperty(response,'redirected',{value:redirected});
 const context={self:{location:{origin},addEventListener:(n,f)=>handlers[n]=f,skipWaiting:async()=>{},clients:{claim:async()=>{}}},URL,Response,fetch:async()=>response,caches:{open:async()=>({put:async()=>puts++}),keys:async()=>[],match:async()=>undefined,delete:async()=>true}};
 vm.runInNewContext(source,context);let install;
 handlers.install({waitUntil:p=>install=p});
 if(redirected||!body.includes('data-briefing-offline'))await assert.rejects(install);else await install;
 assert.equal(puts,redirected||!body.includes('data-briefing-offline')?0:1);
 for(const requestPath of ['/api/briefing','/api/media/test','/api/previews/test','/api/previews/test/media','/signin-with-chatgpt','/callback']){
  let intercepted=false;handlers.fetch({request:{url:origin+requestPath,method:'GET',mode:requestPath.startsWith('/api')?'cors':'navigate'},respondWith:()=>intercepted=true});assert.equal(intercepted,false);
 }
}
await workerCase();await workerCase({redirected:true});await workerCase({body:'<html>Sign in</html>'});
const browser=await chromium.launch({headless:true});
const fixture={source:{label:'테스트 Mac',lastSeen:new Date().toISOString(),sourceUpdatedAt:new Date().toISOString()},online:true,mediaEnabled:false,syncedAt:'2026-10-31T00:00:00.000Z',contents:[{id:'synthetic-content',title:'합성 여행 콘텐츠',date:'2026-10-30',date_basis:'capture',stage:'editing',next_action:'사진 선별',public_url:'',publishing_copy:null}],assets:[]};
async function makeContext(options={}){
 const context=await browser.newContext({viewport:{width:390,height:844},...options});let status=200;let calls=0;
 await context.route(origin+'/**',route=>route.continue({headers:{...route.request().headers(),'oai-authenticated-user-id':'local-qa','oai-authenticated-user-email':'qa@example.invalid'}}));
 await context.route('**/api/briefing',route=>{calls++;return route.fulfill({status,contentType:'application/json',headers:{'cache-control':'no-store'},body:JSON.stringify(status===200?fixture:{error:'unauthorized'})});});
 return {context,setStatus:v=>status=v,calls:()=>calls};
}
try{
 const ios=await makeContext({userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1',isMobile:true,hasTouch:true});
 await ios.context.addInitScript(()=>window.addEventListener('beforeinstallprompt',e=>e.stopImmediatePropagation()));
 const page=await ios.context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/');await page.getByRole('button',{name:'추가 방법',exact:true}).waitFor().catch(async e=>{console.error({url:page.url(),errors,body:(await page.locator('body').innerText()).slice(0,1000)});await page.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true});throw e;});
 assert.equal(await page.locator('link[rel="manifest"]').getAttribute('href'),'/manifest.webmanifest');
 assert.equal(await page.locator('meta[name="apple-mobile-web-app-capable"]').getAttribute('content'),'yes');
 assert.ok((await page.locator('meta[name="viewport"]').getAttribute('content')).includes('viewport-fit=cover'));
 await page.getByRole('button',{name:'추가 방법',exact:true}).click();await page.getByRole('heading',{name:'iPhone·iPad에 추가하기'}).waitFor();
 assert.ok(await page.getByText('웹 앱으로 열기',{exact:true}).isVisible());
 await page.getByRole('button',{name:'콘텐츠',exact:false}).first().click();await page.getByRole('heading',{name:'합성 여행 콘텐츠',exact:true}).waitFor();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 await page.screenshot({path:path.join(artifacts,'iphone-install.png'),fullPage:true});
 await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
 const keys=await page.evaluate(async()=>{const result=[];for(const name of await caches.keys()){if(name.startsWith('rosy-briefing-offline-'))result.push(...(await(await caches.open(name)).keys()).map(r=>new URL(r.url).pathname));}return result;});assert.deepEqual(keys,['/offline']);
 await ios.context.setOffline(true);await page.getByRole('alert').filter({hasText:'인터넷 연결이 끊겼어요'}).waitFor();
 assert.ok(await page.getByRole('heading',{name:'합성 여행 콘텐츠',exact:true}).isVisible());
 await page.reload();await page.getByRole('heading',{name:'연결을 확인해주세요'}).waitFor();assert.equal(await page.getByText('합성 여행 콘텐츠',{exact:true}).count(),0);
 await page.screenshot({path:path.join(artifacts,'offline.png'),fullPage:true});
 await ios.context.setOffline(false);await page.getByRole('link',{name:'다시 연결하기'}).click();await page.getByRole('button',{name:'진행 정보 새로고침'}).waitFor();
 await page.getByRole('button',{name:'콘텐츠',exact:false}).first().click();await page.getByRole('heading',{name:'합성 여행 콘텐츠',exact:true}).waitFor();
 ios.setStatus(401);await page.getByRole('button',{name:'진행 정보 새로고침'}).click();await page.getByRole('link',{name:'로그인 다시 확인'}).waitFor();assert.equal(await page.getByRole('heading',{name:'합성 여행 콘텐츠',exact:true}).count(),0);
 assert.deepEqual(errors,[]);await ios.context.close();
 const desktop=await makeContext();const p=await desktop.context.newPage();await p.goto(origin+'/');await p.getByRole('button',{name:'추가 방법',exact:true}).waitFor();
 await p.evaluate(()=>{const e=new Event('beforeinstallprompt',{cancelable:true});window.__installCalls=0;e.prompt=async()=>{window.__installCalls++};e.userChoice=Promise.resolve({outcome:'accepted'});window.dispatchEvent(e);});
 await p.getByRole('button',{name:'앱 설치',exact:true}).click();assert.equal(await p.evaluate(()=>window.__installCalls),1);
 await p.evaluate(()=>window.dispatchEvent(new Event('appinstalled')));await p.getByRole('region',{name:'홈 화면 앱'}).waitFor({state:'hidden'});await desktop.context.close();
 const standalone=await makeContext();await standalone.context.addInitScript(()=>{const real=window.matchMedia.bind(window);window.matchMedia=q=>{const m=real(q);if(q==='(display-mode: standalone)')Object.defineProperty(m,'matches',{value:true});return m;};});
 const sp=await standalone.context.newPage();await sp.goto(origin+'/');await sp.getByRole('button',{name:'진행 정보 새로고침'}).waitFor();await sp.waitForTimeout(200);assert.equal(await sp.getByRole('region',{name:'홈 화면 앱'}).count(),0);
 await sp.screenshot({path:path.join(artifacts,'standalone.png'),fullPage:true});await standalone.context.close();
 console.log('PWA checks passed: manifest/metadata, iPhone guide, install event, standalone visibility, offline reload, online recovery, auth denial and cache privacy.');
}finally{await browser.close();}
