import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
const origin=process.env.MONITOR_TEST_ORIGIN??'http://127.0.0.1:5227';
assert.ok(['127.0.0.1','localhost'].includes(new URL(origin).hostname),'Local fixtures only');
const secret=process.env.BRIEFING_QA_KEY ?? /^BRIDGE_SECRET=(.*)$/m.exec(await readFile('.dev.vars','utf8'))?.[1]?.replace(/^["']|["']$/g,'');
assert.ok(secret);
const headers={'content-type':'application/json','x-reels-bridge-key':secret};
const at='2026-11-17T10:00:00.000Z';
const content=(id,state,stage='review',priority=1)=>({id,title:`검증 ${id}`,date:'2026-11-17',dateBasis:'record',stage,nextAction:'남은 채널을 확인해요',publicURL:'',kind:'content',priority,state,publications:[{channel:'naver-clip',status:state==='scheduled'?'scheduled':state==='complete'?'published':'draft',url:'',...(state==='scheduled'?{scheduledAt:'2026-11-19T12:00:00+09:00'}:{})}]});
const candidate={projectId:'pending',title:'검증 pending',status:'draft',ready:true};
const week={from:'2026-11-15',to:'2026-11-22',totals:{target:8,done:2,remaining:6},channels:[['blog','블로그',2],['naver-clip','클립',3],['instagram','릴스',2],['youtube','쇼츠',1]].map(([channel,label,target])=>({channel,label,target,published:channel==='naver-clip'?1:0,scheduled:channel==='naver-clip'?1:0,remaining:channel==='naver-clip'?1:target,candidates:channel==='naver-clip'?[candidate]:[]}))};
const monitor={generatedAt:at,thisWeek:week,nextWeek:{...week,from:'2026-11-22',to:'2026-11-29'},queue:{until:'2026-12-01',channels:[{channel:'naver-clip',label:'클립',cap:6,booked:1,open:5,full:false,inProduction:1,rows:[{projectId:'scheduled',title:'검증 scheduled',day:'2026-11-19',status:'scheduled'},{projectId:'pending',title:'검증 pending',day:'2026-11-20',status:'suggested'}]}]},autopilot:{enabled:false,paused:false,notice:'Linear 사본이 오래됐어요 — 자동 실행 멈춤',status:'리뷰 대기 2 · 진행 중 1 · 점유 3/3 · 자동 슬롯 0',today:{title:'검증 pending',target:'project:pending',why:['채널 남음'],decision:'남은 채널: 네이버클립 임시저장',doneWhen:'네이버클립 게시 상태를 확인',outcome:null,changeCount:0}}};
const fixture={sourceId:'primary-mac',sourceLabel:'로컬 검증',sourceRevision:'monitor-qa-'+Date.now(),sourceUpdatedAt:at,contents:[content('pending','channel_pending','published',1),content('review','review','review',2),content('scheduled','scheduled','review',3),content('done','complete','done',4),{...content('operation','in_progress','editing',5),kind:'operation',publications:[]}],assets:[],monitor};
async function api(route,options={}){return fetch(origin+route,{...options,headers});}
const unauth=await fetch(origin+'/api/briefing');assert.equal(unauth.status,401);
const ingest=await api('/api/bridge/snapshot',{method:'PUT',body:JSON.stringify(fixture)});assert.equal(ingest.status,200,await ingest.text());
const data=await (await api('/api/briefing')).json();assert.deepEqual(data.monitor,monitor);assert.equal(data.contents.find(c=>c.id==='pending').state,'channel_pending');assert.equal(data.contents.find(c=>c.id==='done').stage,'done');assert.equal(data.mediaEnabled,false);
const invalid=structuredClone(fixture);invalid.monitor.autopilot.today.reportPath='/private/secret';assert.equal((await api('/api/bridge/snapshot',{method:'PUT',body:JSON.stringify(invalid)})).status,400);assert.deepEqual((await (await api('/api/briefing')).json()).monitor,monitor);
await mkdir('artifacts/monitor',{recursive:true});
const browser=await chromium.launch({headless:true});const errors=[];
try{
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:900}});await context.route(origin+'/**',route=>route.continue({headers:{...route.request().headers(),'x-reels-bridge-key':secret,'oai-authenticated-user-id':'local-qa','oai-authenticated-user-email':'qa@example.invalid'}}));
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/');
  await page.getByRole('heading',{name:'이번 주 목표',exact:true}).waitFor();await page.getByRole('heading',{name:'퇴근 후 오늘 볼 1개',exact:true}).waitFor();
  const reservations = page.getByRole('region', {name: '공개 예약 1건'});
  await reservations.getByRole('button', {name: '검증 scheduled'}).click();
  await page.getByRole('dialog', {name: '검증 scheduled', exact: true}).waitFor();
  await page.getByRole('button', {name: '상세 닫기'}).click();
  assert.ok(await page.getByText('남은 채널: 네이버클립 임시저장',{exact:true}).isVisible());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:`artifacts/monitor/home-${width}.png`,fullPage:true});
  const [secondWeek, thirdWeek] = await page.locator('.upcoming-week').all();
  assert.equal(await secondWeek.locator('.goal-tile:visible').count(),0);
  assert.equal(await thirdWeek.locator('.goal-tile:visible').count(),0);
  await secondWeek.locator('summary').click();
  await thirdWeek.locator('summary').focus();
  await page.keyboard.press('Enter');
  assert.ok(await page.getByRole('heading',{name:'이번 주 목표',exact:true}).isVisible());
  assert.equal(await secondWeek.locator('.goal-tile:visible').count(),4);
  assert.equal(await thirdWeek.locator('.goal-tile:visible').count(),4);
  assert.ok(await thirdWeek.getByText('게시 0 · 예약 0 · 남은 3',{exact:true}).isVisible());
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await thirdWeek.locator('summary').click();
  assert.equal(await secondWeek.locator('.goal-tile:visible').count(),4);
  await secondWeek.locator('summary').click();
  await page.locator('.booking-queue summary').click();assert.ok(await page.getByText('예약 제안은 아직 채널에 등록된 일정이 아니에요.',{exact:false}).isVisible());
  await page.locator('.today-title').click();await page.getByRole('dialog',{name:'검증 pending',exact:true}).waitFor();await page.getByRole('button',{name:'상세 닫기'}).click();
  await page.getByRole('navigation',{name:'제작 현황 탐색'}).getByRole('button',{name:'콘텐츠'}).click();
  const cards=page.locator('.board-cards .content-card');assert.equal(await cards.count(),3);
  assert.deepEqual(await cards.locator('h3').allTextContents(),['검증 pending순서 1','검증 review순서 2','검증 operation운영순서 5']);
  await page.getByLabel('채널 필터').selectOption('naver-clip');assert.equal(await cards.count(),2);
  await page.getByLabel('채널 필터').selectOption('all');await page.getByLabel('작업 종류').selectOption('operation');assert.equal(await cards.count(),1);
  await page.getByLabel('작업 종류').selectOption('all');await page.getByRole('button',{name:'공개 예약 대기',exact:true}).click();assert.equal(await cards.count(),1);await cards.first().click();await page.getByRole('dialog',{name:'검증 scheduled',exact:true}).waitFor();assert.ok(await page.getByText('네이버클립 · 11. 19.',{exact:false}).count());await page.getByRole('button',{name:'상세 닫기'}).click();
  await page.getByRole('button',{name:'완료',exact:true}).click();assert.equal(await cards.count(),1);assert.ok((await cards.innerText()).includes('검증 done'));
  await page.getByRole('button',{name:'전체',exact:true}).click();assert.equal(await cards.count(),5);await page.getByLabel('콘텐츠 검색').fill('pending');assert.equal(await cards.count(),1);
  await page.getByRole('button',{name:'카드',exact:true}).click();assert.equal(await page.locator('.board-cards.list-view').count(),0);
  await page.screenshot({path:`artifacts/monitor/board-${width}.png`,fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  // The open detail must update as the server snapshot changes, without reloading the page.
  await cards.first().click();await page.getByRole('dialog',{name:'검증 pending',exact:true}).waitFor();
  fixture.contents[0].nextAction='동기화 후 다음 행동';fixture.sourceRevision='monitor-updated-'+Date.now();assert.equal((await api('/api/bridge/snapshot',{method:'PUT',body:JSON.stringify(fixture)})).status,200);
  await page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));await page.getByRole('dialog').getByText('동기화 후 다음 행동',{exact:true}).waitFor();
  await context.close();
 }
 assert.deepEqual(errors,[]);
 await writeFile('artifacts/monitor/verification.json',JSON.stringify({passed:true,viewports:[390,1280],checks:['D1 roundtrip','strict contract','unauthorized read','done/draft/scheduled','independent week disclosures','queue','today deep link','active default','work order','channel/kind filter','search','grid/list','open detail refresh','no overflow','no browser errors']},null,2));
 console.log('PASS: D1 monitor roundtrip, contract rejection, auth, desktop/mobile dashboard, filters, ordering, navigation, detail refresh, layout and browser errors');
}finally{await browser.close();}
