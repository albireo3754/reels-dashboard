// A supplied private TopicBoard is read locally, never bundled or sent to production.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '@playwright/test';

const origin=process.env.TOPICS_TEST_ORIGIN??'http://127.0.0.1:5227';
assert.ok(['127.0.0.1','localhost'].includes(new URL(origin).hostname),'Local fixtures only');
const artifacts=path.resolve(process.argv[3]??'artifacts/topics');
const suffix=process.argv[4]??'';
assert.ok(['','-v2'].includes(suffix),'Unknown capture suffix');
const captureName=name=>name.replace(/\.png$/,`${suffix}.png`);
await mkdir(artifacts,{recursive:true});
const at='2026-11-18T00:00:00.000Z';
const readiness=['ready','needs_edit','needs_user','needs_user','needs_user','needs_user','hold'];
const labels={ready:'바로 올릴 수 있음',needs_edit:'편집하면 됨',needs_user:'내 답 필요',hold:'보류'};
const synthetic={items:readiness.map((r,i)=>({
 id:`draft-${i}`,channel:'instagram',title:`검증 소재 ${i+1}`,hookFamily:'정보형',
 coverHooks:['여행 전에 알아둘 / 이번 주 이야기','두 번째 표지 / 다른 도입'],captionHead:'캡션 첫 줄 검증',
 basedOn:[{title:'이전 콘텐츠',evidence:'저장 반응을 관찰한 사례'}],source:'기존 촬영분 · 미편집',hypothesis:'새 도입의 반응을 확인해요.',
 effort:'S',readiness:r,asks:r==='needs_user'?['이번 콘텐츠에 쓸 경험은 무엇인가요?']:[],rank:i+1,
 decision:'proposed',updatedAt:at,projectId:'topic-qa',projectTitle:'로컬 검증 카드',
 channelLabel:'인스타그램',readinessLabel:labels[r],effortLabel:'작업 적음',
})),counts:{picked:0,ready:1,needs_edit:1,needs_user:4,hold:1,dropped:0},gaps:[{channel:'instagram',label:'릴스',week:'next',remaining:2}]};
const board=process.argv[2]?JSON.parse(await readFile(process.argv[2],'utf8')):synthetic;
const secret=process.env.BRIEFING_QA_KEY ?? /^BRIDGE_SECRET=(.*)$/m.exec(await readFile('.dev.vars','utf8'))?.[1]?.replace(/^["']|["']$/g,'');
assert.ok(secret,'Local fixture credential missing');
const headers={'content-type':'application/json','x-reels-bridge-key':secret};
const week={from:'2026-11-15',to:'2026-11-22',totals:{target:8,done:2,remaining:6},channels:[['blog','블로그'],['naver-clip','클립'],['instagram','릴스'],['youtube','쇼츠']].map(([channel,label])=>({channel,label,target:2,published:channel==='blog'?2:0,scheduled:0,remaining:channel==='blog'?0:2,candidates:[]}))};
const monitor={generatedAt:at,thisWeek:week,nextWeek:{...week,from:'2026-11-22',to:'2026-11-29'},queue:{until:'2026-12-01',channels:[{channel:'instagram',label:'릴스',cap:4,booked:0,open:4,full:false,inProduction:1,rows:[]}]},autopilot:{enabled:false,paused:false,notice:null,status:'검토 대기 1',today:{title:'로컬 검증 카드',target:'project:topic-qa',why:['문안 확인'],decision:'남은 문안을 확인해요',doneWhen:'문안 확정',outcome:null,changeCount:0}}};
const copy={status:'ready',publicationStatus:'draft',updatedAt:at,sections:[{id:'caption',kind:'caption',label:'캡션',parentId:null,text:'문안 회귀 확인\n두 번째 줄'}]};
const fixture={sourceId:'primary-mac',sourceLabel:'로컬 화면 검증',sourceRevision:'',sourceUpdatedAt:at,contents:[{id:'topic-qa',title:'로컬 검증 카드',date:'2026-11-18',dateBasis:'record',stage:'review',nextAction:'남은 문안을 확인해요',publicURL:'',publishingCopy:copy}],assets:[],monitor};
async function put(topics,invalid=false){
 const snapshot=structuredClone(fixture);
 if(topics!==undefined)snapshot.monitor.topics=topics;
 snapshot.sourceRevision=`topics-qa-${crypto.randomUUID()}`;
 const response=await fetch(origin+'/api/bridge/snapshot',{method:'PUT',headers,body:JSON.stringify(snapshot)});
 assert.equal(response.status,invalid?400:200,await response.text());
}
async function read(){const response=await fetch(origin+'/api/briefing',{headers});assert.equal(response.status,200);return response.json();}
assert.equal((await fetch(origin+'/api/briefing')).status,401);
await put(board);assert.deepEqual((await read()).monitor.topics,board);
const invalid=structuredClone(board);invalid.items[0].localPath='/private/rejected';
await put(invalid,true);assert.deepEqual((await read()).monitor.topics,board);
await put(undefined);assert.equal((await read()).monitor.topics,undefined);
await put(board);

const browser=await chromium.launch({headless:true});const errors=[];const metrics=[];
async function sectionCapture(page,section,file){
 await page.evaluate(()=>window.scrollTo(0,0));
 const box=await section.boundingBox();assert.ok(box);
 const capture=await page.screenshot({path:path.join(artifacts,captureName(file)),fullPage:true,clip:{x:0,y:Math.max(0,Math.floor(box.y)-12),width:390,height:Math.ceil(box.height)+24}});
 assert.ok(capture.readUInt32BE(20)>=box.height,'Capture must include the whole topic section');
}
try{
 for(const width of [390,1280]){
  const context=await browser.newContext({viewport:{width,height:844},isMobile:width===390,hasTouch:width===390});
  await context.route(origin+'/**',route=>route.continue({headers:{...route.request().headers(),'oai-authenticated-user-id':'local-qa','oai-authenticated-user-email':'qa@example.invalid'}}));
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/');
  const section=page.getByRole('region',{name:'소재 선정',exact:true});
  await section.getByText(board.items[0].title,{exact:true}).waitFor();await page.evaluate(()=>document.fonts.ready);
  const cards=section.locator('.topic-card');
  assert.equal(await cards.count(),board.items.length);assert.equal(await section.locator('details[open]').count(),0);
  assert.deepEqual(await cards.locator('.topic-title').allTextContents(),board.items.map(item=>item.title));
  assert.equal(await section.locator('button,input,select,textarea').count(),0,'Topic selection must be read-only');
  for(let i=0;i<board.items.length;i++){
   const item=board.items[i],card=cards.nth(i);
   assert.equal(await card.locator('.topic-rank').count(),item.rank==null?0:1);
   if(item.readiness==='hold'){
    assert.equal(await card.locator('summary .topic-hook-lines').count(),0);
    assert.ok((await card.boundingBox()).height<100,'Held card should stay compact');
    await card.locator('summary').click();
    if(item.asks.length)assert.ok(await card.getByText('결정할 것',{exact:true}).isVisible());
   }else{
    assert.deepEqual(await card.locator('summary .topic-hook-lines>span').allTextContents(),item.coverHooks[0].split(' / '));
    assert.equal(await card.getByText('추천 표지',{exact:true}).count(),0);
    if(item.asks.length){
     const heading={ready:'올리기 전 확인',needs_edit:'확인할 것',needs_user:null}[item.readiness];
     assert.equal(await card.locator('.topic-asks>strong').count(),heading?1:0);
     if(heading)assert.ok(await card.getByText(heading,{exact:true}).isVisible());
    }
   }
   for(const ask of item.asks)assert.ok(await card.locator('.topic-asks').getByText(ask,{exact:true}).isVisible());
   if(item.readiness==='hold')await card.locator('summary').click();
  }
  if(new Set(board.items.map(item=>item.channel)).size===1)assert.equal(await section.locator('.topic-channel').count(),0);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  const sectionHeight=(await section.boundingBox()).height;
  if(width===390){assert.ok(sectionHeight<=3*844,`Collapsed topics too tall: ${sectionHeight}`);await sectionCapture(page,section,'mobile-390-collapsed.png');}
  else {
   await page.screenshot({path:path.join(artifacts,captureName('desktop-1280.png')),fullPage:true});
   for(let i=0;i+1<board.items.length;i+=2){
    const left=await cards.nth(i).boundingBox(),right=await cards.nth(i+1).boundingBox();
    assert.ok(Math.abs(left.height-right.height)<1,'Desktop row card heights must align');
    if(board.items[i].readiness!=='hold'&&board.items[i+1].readiness!=='hold'){
     const lt=await cards.nth(i).locator('.topic-toggle').boundingBox(),rt=await cards.nth(i+1).locator('.topic-toggle').boundingBox();
     assert.ok(Math.abs(lt.y-rt.y)<1,'Desktop row toggles must align');
    }
   }
  }
  metrics.push({width,sectionHeight,cards:board.items.length});
  const richIndex=Math.max(0,board.items.findIndex(item=>item.coverHooks.length>1&&item.captionHead));
  const rich=cards.nth(richIndex);await rich.locator('summary').click();
  for(const field of ['훅 계열','소스'])assert.ok(await rich.getByText(field,{exact:true}).isVisible());
  assert.equal(await rich.getByText('연결 카드',{exact:true}).count(),board.items[richIndex].projectTitle===board.items[richIndex].title?0:1);
  assert.equal(await rich.locator('.topic-facts').evaluate(el=>getComputedStyle(el).wordBreak),'keep-all');
  for(const basis of board.items[richIndex].basedOn)assert.ok(await rich.getByText(basis.evidence,{exact:true}).isVisible());
  if(width===390)await sectionCapture(page,section,'mobile-390-expanded.png');
  await rich.locator('summary').click();
  // Native disclosures support keyboard access.
  await cards.first().locator('summary').focus();await page.keyboard.press('Enter');
  assert.equal(await cards.first().getAttribute('open'),'');await page.keyboard.press('Enter');
  // Weekly goals, booking queue, today's detail and publishing copy remain reachable.
  const secondWeek = page.locator('.upcoming-week').filter({hasText:'2주차 목표'});
  await secondWeek.locator('summary').click();
  assert.ok(await secondWeek.locator('.goal-grid').isVisible());
  await secondWeek.locator('summary').click();
  await page.locator('.booking-queue summary').click();
  await page.getByRole('region',{name:'퇴근 후 오늘 볼 1개'}).locator('.today-title').click();
  await page.getByRole('dialog',{name:'로컬 검증 카드',exact:true}).waitFor();
  assert.ok(await page.getByRole('dialog').getByText('문안 회귀 확인',{exact:false}).isVisible());
  await page.getByRole('button',{name:'상세 닫기'}).click();
  if(width===390){
   await put(undefined);await page.getByRole('button',{name:'진행 정보 새로고침'}).click();
   await section.getByText('아직 등록된 소재 후보가 없어요',{exact:true}).waitFor();
   assert.ok(await page.getByRole('heading',{name:'이번 주 목표',exact:true}).isVisible());
   assert.ok(await page.getByRole('heading',{name:'퇴근 후 오늘 볼 1개',exact:true}).isVisible());
   await page.screenshot({path:path.join(artifacts,captureName('mobile-390-empty.png')),fullPage:true});
   const empty={items:[],counts:{picked:0,ready:0,needs_edit:0,needs_user:0,hold:0,dropped:1},gaps:[]};
   await put(empty);await page.getByRole('button',{name:'진행 정보 새로고침'}).click();await section.getByText('아직 등록된 소재 후보가 없어요',{exact:true}).waitFor();
   // Preserve a server-provided picked order even when ranks would sort differently.
   const picked=structuredClone(board);const last=picked.items.pop();last.decision='picked';last.rank=99;picked.items.unshift(last);picked.counts.picked++;
   await put(picked);await page.getByRole('button',{name:'진행 정보 새로고침'}).click();await cards.first().getByText('선정',{exact:true}).waitFor();
   assert.deepEqual(await cards.locator('.topic-title').allTextContents(),picked.items.map(item=>item.title));
   await put(board);
  }
  await context.close();
 }
 assert.deepEqual(errors,[]);
 await writeFile(path.join(artifacts,`verification${suffix}.json`),JSON.stringify({passed:true,privateFixture:!!process.argv[2],metrics,checks:['D1 topics roundtrip','strict rejection preserves snapshot','old snapshot without topics','empty board','server order and picked badge','two-line recommended hook','readiness-specific questions','compact held card','rank and desktop alignment','single-channel omission','duplicate project title omission','keep-all wrapping','expanded context','keyboard disclosure','read-only','weekly goals/queue/today/copy regression','no overflow','no browser errors']},null,2));
 console.log('PASS: topic contract, D1 roundtrip, old/empty snapshots, 390/1280px layout, disclosures, questions, read-only behavior and existing sections.');
}finally{await browser.close();}
