// Local D1/UI coverage for old video queues and the four-channel posting queue.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium} from '@playwright/test';
const origin=process.env.MONITOR_TEST_ORIGIN??'http://127.0.0.1:5227';
assert.ok(['127.0.0.1','localhost'].includes(new URL(origin).hostname),'Local fixtures only');
const secret=/^BRIDGE_SECRET=(.*)$/m.exec(await readFile('.dev.vars','utf8'))?.[1]?.replace(/^["']|["']$/g,'');
assert.ok(secret);
const headers={'content-type':'application/json','x-reels-bridge-key':secret};
const at='2026-11-18T00:00:00.000Z';
const phases={draft:'임시저장',final:'완성본',review:'검토 대기',production:'제작 중',reuse:'재업 후보'};
const channels=[['blog','블로그'],['naver-clip','클립'],['instagram','릴스'],['youtube','쇼츠']];
const week={from:'2026-11-15',to:'2026-11-22',totals:{target:8,done:0,remaining:8},channels:channels.map(([channel,label])=>({channel,label,target:2,published:0,scheduled:0,remaining:2,candidates:[]}))};
const fixture={sourceId:'primary-mac',sourceLabel:'로컬 대기열 검증',sourceRevision:'',sourceUpdatedAt:at,contents:[{id:'queue-qa',title:'로컬 대기열 검증',date:'2026-11-18',dateBasis:'record',stage:'review',nextAction:'대기열 확인',publicURL:''}],assets:[],monitor:{generatedAt:at,thisWeek:week,nextWeek:week,queue:{until:'2026-12-01',channels:channels.map(([channel,label])=>({channel,label,cap:4,booked:1,open:3,full:false,inProduction:1,rows:[{projectId:'queue-qa',title:'예약 검증',day:'2026-11-19',status:'scheduled'},...Object.keys(phases).map((phase,i)=>({projectId:`${channel}-${phase}`,title:`${label} ${phase}`,day:`2026-11-${20+i}`,status:'suggested',phase}))]}))},autopilot:{enabled:false,paused:false,notice:null,status:'대기',today:null}}};
async function put(snapshot,status=200){const response=await fetch(origin+'/api/bridge/snapshot',{method:'PUT',headers,body:JSON.stringify({...snapshot,sourceRevision:crypto.randomUUID()})});assert.equal(response.status,status,await response.text());}
async function read(){const response=await fetch(origin+'/api/briefing',{headers});assert.equal(response.status,200);return response.json();}
const legacy=structuredClone(fixture);legacy.monitor.queue.channels=legacy.monitor.queue.channels.slice(1);for(const c of legacy.monitor.queue.channels)for(const row of c.rows)delete row.phase;
await put(legacy);assert.deepEqual((await read()).monitor.queue,legacy.monitor.queue);
await put(fixture);assert.deepEqual((await read()).monitor.queue,fixture.monitor.queue);
const invalid=structuredClone(fixture);invalid.monitor.queue.channels[0].rows[1].phase='unknown';await put(invalid,400);assert.deepEqual((await read()).monitor.queue,fixture.monitor.queue);
await mkdir('artifacts/queue',{recursive:true});
const browser=await chromium.launch({headless:true});const errors=[];
try{
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:844}});
  await context.route(origin+'/**',route=>route.continue({headers:{...route.request().headers(),'oai-authenticated-user-id':'local-qa','oai-authenticated-user-email':'qa@example.invalid'}}));
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(origin+'/');
  const queue=page.locator('.booking-queue');await queue.locator('summary').click();
  assert.ok((await queue.locator('summary').innerText()).includes('게시 2주 예약 현황'));
  const cards=queue.locator('.queue-grid>article');assert.equal(await cards.count(),4);
  for(let i=0;i<4;i++){
   assert.ok((await cards.nth(i).locator('h3').innerText()).includes(channels[i][1]));
   for(const label of Object.values(phases))assert.ok(await cards.nth(i).getByText(`제안 · ${label}`,{exact:false}).isVisible());
   assert.equal(await cards.nth(i).getByText('예약',{exact:false}).count()>=1,true);
  }
  await page.screenshot({path:`artifacts/queue/queue-${width}.png`,fullPage:true});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await context.close();
 }
 assert.deepEqual(errors,[]);
 await writeFile('artifacts/queue/verification.json',JSON.stringify({passed:true,checks:['three-channel/no-phase legacy','four-channel D1 roundtrip','unknown phase rejects without replacing snapshot','blog visible','all five phase labels','390/1280px no overflow/errors']},null,2));
 console.log('PASS: legacy queues, four channels including blog, optional phase, all phase labels and 390/1280px UI.');
}finally{await browser.close();}
