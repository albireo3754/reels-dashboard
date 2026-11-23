// Local-only browser check for 지시하기 (mobile instructions). Never targets production.
// Needs a local dev server with INSTRUCTIONS_ENABLED=true in .dev.vars (any signed-in site user may instruct):
//   npm run dev -- --port 5227   then   npm run test:instructions-ui
// The local Sites mock signs the browser in as local_seedy; Node calls use the same mock cookie.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
const origin=process.env.MONITOR_TEST_ORIGIN??'http://127.0.0.1:5227';
assert.ok(['127.0.0.1','localhost'].includes(new URL(origin).hostname),'Local fixtures only');
const shots=path.resolve(process.env.INSTRUCTIONS_ARTIFACT_DIR??'artifacts/instructions');await mkdir(shots,{recursive:true});
const secret=/^BRIDGE_SECRET=(.*)$/m.exec(await readFile('.dev.vars','utf8'))?.[1]?.replace(/^["']|["']$/g,'');
assert.ok(secret);
const bridgeHeaders={'content-type':'application/json','x-reels-bridge-key':secret};
const ownerHeaders={cookie:'__sites_local_auth=1','content-type':'application/json',origin,'sec-fetch-site':'same-origin'};
const bridge=(route,body)=>fetch(origin+route,{method:route.endsWith('snapshot')?'PUT':'POST',headers:bridgeHeaders,body:body===undefined?undefined:JSON.stringify(body)});
const owner=(route,body)=>fetch(origin+route,{method:body===undefined?'GET':'POST',headers:ownerHeaders,body:body===undefined?undefined:JSON.stringify(body)});
const list=async()=>{const r=await owner('/api/instructions');assert.equal(r.status,200,'local signed-in user must reach the instructions API');return r.json();};
const heartbeat=(ready=true,reason)=>bridge('/api/bridge/heartbeat',{instructions:{ready,...(reason?{reason}:{})}});
const claim=async()=>(await (await bridge('/api/bridge/instructions/claim',{capacity:1})).json()).items;
const setStatus=async(id,body)=>{const r=await bridge('/api/bridge/instructions/'+id+'/status',body);assert.equal(r.status,200,await r.text());};
const at='2026-11-21T09:00:00.000Z';
const week={from:'2026-11-15',to:'2026-11-22',totals:{target:1,done:0,remaining:1},channels:[{channel:'naver-clip',label:'클립',target:1,published:0,scheduled:0,remaining:1,candidates:[]}]};
async function ingest(label='지시 검증'){
 const r=await bridge('/api/bridge/snapshot',{sourceId:'primary-mac',sourceLabel:label,sourceRevision:'instr-ui-'+Date.now()+Math.random(),sourceUpdatedAt:at,
  contents:[{id:'pending',title:'합성 레몬젤리 릴스',date:'2026-11-20',dateBasis:'record',stage:'review',nextAction:'검토',publicURL:'',kind:'content',priority:1,state:'review',publications:[]},{id:'로지-블로그',title:'합성 블로그 글',date:'2026-11-19',dateBasis:'record',stage:'editing',nextAction:'편집',publicURL:''}],assets:[],
  monitor:{generatedAt:at,thisWeek:week,nextWeek:{...week,from:'2026-11-22',to:'2026-11-29'},queue:{until:'2026-12-01',channels:[]},autopilot:{enabled:true,paused:false,notice:null,status:'리뷰 대기 1',today:{title:'합성 레몬젤리 릴스',target:'project:pending',why:['리뷰 대기'],decision:'결정',doneWhen:'완료',outcome:null,changeCount:0}}}});
 assert.equal(r.status,200);
}
// Leave nothing occupying the queue or the single active slot from earlier runs.
async function reset(){
 for(const it of (await list()).items){
  if(it.status==='queued')assert.equal((await owner('/api/instructions/'+it.id+'/cancel',{})).status,200);
  if(it.status==='claimed')await setStatus(it.id,{status:'failed',errorCode:'BRIDGE_DISABLED'});
  if(it.status==='running')await setStatus(it.id,{status:'done',summary:'정리'});
 }
}
const browser=await chromium.launch({headless:true});const errors=[];const checks=[];const files=[];
const shot=async(target,name,opts={})=>{const file=path.join(shots,name);await target.screenshot({path:file,...opts});files.push(name);};
async function open(width){
 const context=await browser.newContext({viewport:{width,height:width<600?844:900}});
 const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/');await page.getByRole('heading',{name:'작업 지시',exact:true}).waitFor();
 await page.locator('.instructions-panel .instruct-button').waitFor();await page.waitForFunction(()=>!document.querySelector('.instructions-panel .instruct-button')?.hasAttribute('disabled'));
 return {context,page,panel:page.locator('.instructions-panel')};
}
const noOverflow=page=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1);
const refreshAll=async page=>{const b=page.waitForResponse(r=>r.url().endsWith('/api/briefing'));const i=page.waitForResponse(r=>r.url().endsWith('/api/instructions')&&r.request().method()==='GET');await page.evaluate(()=>{window.dispatchEvent(new Event('pageshow'));document.dispatchEvent(new Event('visibilitychange'));});await Promise.all([b,i]);};
try{
 await ingest();await heartbeat(true);await reset();
 for(const width of [390,1280]){
  const {context,page,panel}=await open(width);
  // First screen: 지시하기 is reachable without scrolling; the copy action is collapsed under the today card.
  const box=await panel.locator('.instruct-button').boundingBox();assert.ok(box&&box.y+box.height<=page.viewportSize().height,'지시하기 within the first viewport');
  assert.equal(await page.locator('.today-panel .paseo-direct').evaluate(d=>d.open),false);
  assert.equal(await page.getByRole('button',{name:'Paseo에 붙여 넣을 요청 복사'}).isVisible(),false);
  assert.ok(await page.getByRole('button',{name:'이 항목으로 지시'}).isVisible());
  await shot(page,width+'-first-screen.png');
  await shot(page.locator('.today-panel'),width+'-today-card.png');
  // Compose → preview → confirm → listed.
  const text=width+'px: 이 worktree의 git status를 요약해 보고해 줘\n두 번째 줄';
  await panel.locator('.instruct-button').click();
  const dialog=page.getByRole('dialog',{name:'지시하기'});await dialog.waitFor();
  await dialog.getByLabel('무엇을 할까요?').fill(text);
  await dialog.getByLabel('대상').selectOption('project:pending');await dialog.getByLabel('끝 수준').selectOption('draft');
  await shot(dialog,width+'-compose.png');
  await dialog.getByRole('button',{name:'미리보기'}).click();
  await dialog.getByRole('heading',{name:'이대로 보낼까요?'}).waitFor();
  assert.equal(await dialog.locator('.instruction-preview-text').textContent(),text);
  assert.ok(await dialog.getByText('오늘 볼 항목 · 합성 레몬젤리 릴스').isVisible());assert.ok(await dialog.getByText('초안',{exact:true}).isVisible());
  await shot(dialog,width+'-preview.png');
  // Auto refresh while previewing (briefing + instructions, with new briefing data) keeps the preview.
  await ingest('지시 검증 갱신');await refreshAll(page);
  assert.equal(await dialog.locator('.instruction-preview-text').textContent(),text);
  // Double tap on 보내기: the request is held for a moment; only one POST leaves and one row is created.
  let posts=0;await page.route(origin+'/api/instructions',async route=>{if(route.request().method()==='POST'){posts++;await new Promise(r=>setTimeout(r,800));}await route.continue();});
  const beforeIds=new Set((await list()).items.map(i=>i.id));
  const send=dialog.getByRole('button',{name:'보내기'});await send.click();await send.evaluate(b=>b.click()).catch(()=>{});await page.getByRole('button',{name:'보내는 중…'}).click({force:true,timeout:500}).catch(()=>{});
  await panel.getByText('보냈어요.',{exact:false}).waitFor();await page.unroute(origin+'/api/instructions');
  assert.equal(posts,1,'one POST for a double tap');
  const fresh=(await list()).items.filter(i=>!beforeIds.has(i.id));assert.equal(fresh.length,1,'exactly one new row');const created=fresh[0];
  assert.deepEqual([created.text,created.target,created.end_level,created.status],[text.trim(),'project:pending','draft','queued']);
  assert.equal(await dialog.count(),0);
  const item=panel.locator('.instruction-item').first();
  assert.equal(await item.locator('.instruction-text').textContent(),text.trim());
  assert.match(await item.locator('.instruction-badge').textContent(),/^Mac 대기 중\(/);
  await shot(panel,width+'-list-queued.png');
  // Draft survives the 30-second refresh in the edit step too, and reopening keeps it.
  await panel.locator('.instruct-button').click();await dialog.getByLabel('무엇을 할까요?').fill('작성 중인 지시');
  if(width===390){const n=page.waitForResponse(r=>r.url().endsWith('/api/instructions')&&r.request().method()==='GET',{timeout:40000});const m=page.waitForResponse(r=>r.url().endsWith('/api/briefing'),{timeout:40000});await Promise.all([n,m]);checks.push('390 real 30-second timer refreshed briefing and instructions while composing');}
  else await refreshAll(page);
  assert.equal(await dialog.getByLabel('무엇을 할까요?').inputValue(),'작성 중인 지시');
  await dialog.getByRole('button',{name:'닫기(내용 유지)'}).click();await panel.locator('.instruct-button').click();
  assert.equal(await dialog.getByLabel('무엇을 할까요?').inputValue(),'작성 중인 지시');await dialog.getByRole('button',{name:'지시 창 닫기'}).click();
  // Cancel the queued instruction.
  await item.getByRole('button',{name:'대기 취소'}).click();await panel.getByText('취소했어요.').waitFor();
  await expect(panel.locator('.instruction-item').first().locator('.instruction-badge')).toHaveText('취소됨');
  assert.equal((await list()).items[0].status,'cancelled');
  // "이 항목으로 지시" preselects the verified today target.
  await page.getByRole('button',{name:'이 항목으로 지시'}).click();await dialog.waitFor();
  assert.equal(await dialog.getByLabel('대상').inputValue(),'project:pending');await dialog.getByRole('button',{name:'지시 창 닫기'}).click();
  assert.ok(await noOverflow(page));
  checks.push(width+' first-screen 지시하기, collapsed copy, compose→preview→confirm→listed, refresh keeps preview/draft, double tap → 1 POST/1 row, cancel, today target prefill, no overflow');
  await context.close();
 }

 // Real roundtrip through the bridge API: queued (locked Mac) → claimed → running → needs_user / done / failed.
 {await reset();const {context,page,panel}=await open(390);
  const mk=async t=>{const r=await owner('/api/instructions',{text:t,idempotencyKey:crypto.randomUUID()});assert.equal(r.status,201);return (await r.json()).item;};
  const a=await mk('라운드트립 A: 상태를 요약해 줘');await heartbeat(false,'locked');await refreshAll(page);
  await expect(panel.locator('.instruction-item').first().locator('.instruction-badge')).toHaveText('Mac 대기 중(Mac 잠김)');
  await heartbeat(true);let got=await claim();assert.deepEqual(got.map(x=>x.id),[a.id]);await refreshAll(page);
  await expect(panel.locator('.instruction-item').first().locator('.instruction-badge')).toHaveText('실행 중 · 세션 준비 중');
  await setStatus(a.id,{status:'running',sessionName:'sites-'+a.id.slice(0,8)});await refreshAll(page);
  await expect(panel.locator('.instruction-item').first().locator('.instruction-badge')).toHaveText('실행 중 · 세션 sites-'+a.id.slice(0,8));
  await setStatus(a.id,{status:'needs_user',question:'초안 A와 B 중 어느 쪽으로 갈까요?',summary:'초안 두 개를 만들었어요\n저장 위치 /Users/example/Obsidian/x.md'});await refreshAll(page);
  const first=panel.locator('.instruction-item').first();
  await expect(first.locator('.instruction-badge')).toHaveText('답 필요');
  assert.equal(await first.locator('.instruction-question').textContent(),'답 필요: 초안 A와 B 중 어느 쪽으로 갈까요?');
  assert.ok(await first.getByText('Paseo에서 세션 sites-'+a.id.slice(0,8)+'을 열어 답하세요').isVisible());
  assert.ok(!(await first.locator('.instruction-summary').textContent()).includes('/Users/'),'summary path masked');
  assert.equal(await first.locator('a').count(),0,'plain text only');
  const b=await mk('라운드트립 B: 완료 요약');got=await claim();assert.deepEqual(got.map(x=>x.id),[b.id]);
  await setStatus(b.id,{status:'running',sessionName:'sites-'+b.id.slice(0,8)});await setStatus(b.id,{status:'done',summary:'1. git status 확인\n2. 변경 없음\nhttps://example.com/plain'});
  const c=await mk('라운드트립 C: 실패');got=await claim();await setStatus(c.id,{status:'failed',errorCode:'LAUNCH_FAILED'});
  await refreshAll(page);
  const rows=panel.locator('.instruction-item');
  await expect(rows.nth(0).locator('.instruction-badge')).toHaveText('실패');assert.ok(await rows.nth(0).getByText('실행기를 띄우지 못했어요').isVisible());
  assert.equal(await rows.nth(1).locator('.instruction-badge').textContent(),'완료');assert.equal(await rows.nth(1).locator('.instruction-summary').textContent(),'1. git status 확인\n2. 변경 없음\nhttps://example.com/plain');
  assert.equal(await rows.nth(1).locator('a').count(),0,'URL in a summary stays plain text');
  await expect(rows.nth(1).locator('.instruction-session')).toHaveText('세션 sites-'+b.id.slice(0,8));
  await shot(panel,'390-roundtrip.png');
  await context.close();checks.push('roundtrip via bridge API: locked Mac badge, claimed, running with session, needs_user question + Paseo hint, masked summary, done summary, failed code; plain text only');}

 // Every badge, including delayed running and expired, from a fixed list; switch off; auth loss.
 const now=Date.now(),iso=ms=>new Date(ms).toISOString();
 const base={target:null,end_level:null,updated_at:iso(now),claimed_at:null,started_at:null,finished_at:null,expires_at:iso(now+86400000),session_name:null,summary:null,question:null,error_code:null};
 const fixture=[['queued',{}],['claimed',{claimed_at:iso(now-60000)}],['running',{started_at:iso(now-5*60000),session_name:'sites-aaaa1111'}],['running',{started_at:iso(now-75*60000),session_name:'sites-bbbb2222'}],['needs_user',{session_name:'sites-cccc3333',question:'어느 커버로 할까요?'}],['done',{summary:'완료 요약 1줄\n완료 요약 2줄',session_name:'sites-eeee5555'}],['failed',{error_code:'TIMEOUT',session_name:'sites-dddd4444'}],['cancelled',{}],['expired',{}]]
  .map(([status,extra],i)=>({...base,id:'00000000-0000-4000-8000-00000000000'+i,text:'고정 목록 '+status+(i===3?' (지연)':''),status,created_at:iso(now-(i+1)*600000),...extra}));
 const mock=(enabled)=>({enabled,macOnline:true,macReady:{ready:false,reason:'launcher_down'},maxActive:1,delayAfterMinutes:60,maxChars:4000,items:fixture});
 for(const width of [390,1280]){
  const {context,page,panel}=await open(width);
  await page.route(origin+'/api/instructions',route=>route.request().method()==='GET'?route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(mock(true))}):route.continue());
  await refreshAll(page);await panel.getByText('지시 9개 모두 보기').click();
  const badges=await panel.locator('.instruction-badge').allTextContents();
  assert.deepEqual(badges,['Mac 대기 중(Paseo 꺼짐)','실행 중 · 세션 준비 중','실행 중 · 세션 sites-aaaa1111','지연 · 세션 sites-bbbb2222','답 필요','완료','실패','취소됨','만료됨']);
  assert.equal(await panel.locator('.instruction-cancel').count(),1,'cancel only on queued');
  assert.ok(await panel.getByText('Paseo에서 세션 sites-cccc3333을 열어 답하세요').isVisible());
  assert.ok(await panel.getByText('60분이 넘었어요',{exact:false}).isVisible());
  assert.ok(await panel.getByText('Mac이 24시간 안에 가져가지 않았어요',{exact:false}).isVisible());
  // Session names on running/done/failed cards (plain text), not only on needs_user.
  const cards=panel.locator('.instruction-item');
  for(const [i,name] of [[2,'sites-aaaa1111'],[3,'sites-bbbb2222'],[5,'sites-eeee5555'],[6,'sites-dddd4444']]){assert.equal(await cards.nth(i).locator('.instruction-session').textContent(),'세션 '+name);assert.equal(await cards.nth(i).locator('a').count(),0);}
  assert.equal(await cards.nth(1).locator('.instruction-session').count(),0,'claimed without a session name has no session line');
  assert.ok(await noOverflow(page));
  await shot(panel,width+'-badges.png');
  // Server switch off: composer opens with the reason and disabled inputs.
  await page.unroute(origin+'/api/instructions');
  await page.route(origin+'/api/instructions',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(mock(false))}));
  await refreshAll(page);
  await expect(panel.getByText('지시 기능 꺼짐',{exact:false}).first()).toBeVisible();
  await panel.locator('.instruct-button').click();const dialog=page.getByRole('dialog',{name:'지시하기'});
  assert.ok(await dialog.getByLabel('무엇을 할까요?').isDisabled());assert.ok(await dialog.getByRole('button',{name:'미리보기'}).isDisabled());
  assert.ok(await dialog.getByText('지시 기능이 꺼져 있어요',{exact:false}).isVisible());
  await shot(page,width+'-switch-off.png');
  await page.unroute(origin+'/api/instructions');await dialog.getByRole('button',{name:'지시 창 닫기'}).click();
  // Auth loss on the instructions API clears the draft and hides the composer.
  await refreshAll(page);await panel.locator('.instruct-button').click();await dialog.getByLabel('무엇을 할까요?').fill('지워져야 할 초안');
  await page.route(origin+'/api/instructions',route=>route.fulfill({status:401,contentType:'application/json',body:'{"error":"UNAUTHORIZED"}'}));
  await refreshAll(page).catch(()=>{});await panel.getByText('로그인이 필요해요. 사이트를 다시 열어 주세요').waitFor();
  assert.equal(await dialog.count(),0);assert.ok(await panel.locator('.instruct-button').isDisabled());
  await page.unroute(origin+'/api/instructions');
  // Briefing auth loss removes the whole panel; signing back in starts with an empty draft.
  await page.route(origin+'/api/briefing',route=>route.fulfill({status:401,body:'{}'}));
  await page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));await page.getByText('로그인을 다시 확인해주세요.',{exact:false}).first().waitFor();
  assert.equal(await page.locator('.instructions-panel').count(),0);
  await page.unroute(origin+'/api/briefing');await page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));
  await page.locator('.instructions-panel .instruct-button:not([disabled])').waitFor();await page.locator('.instructions-panel .instruct-button').click();
  assert.equal(await page.getByRole('dialog',{name:'지시하기'}).getByLabel('무엇을 할까요?').inputValue(),'');
  await context.close();checks.push(width+' all nine badges incl. delayed/expired, cancel only on queued, switch off disables input with reason, 403/401 clear the draft');
 }
 assert.deepEqual(errors,[]);
 await reset();
 await writeFile(path.join(shots,'verification.json'),JSON.stringify({passed:true,origin,checks,screenshots:files},null,2));
 for(const c of checks)console.log('ok -',c);
 console.log('PASS: instructions UI —',checks.length,'groups,',files.length,'screenshots in',shots);
}finally{await browser.close();}
