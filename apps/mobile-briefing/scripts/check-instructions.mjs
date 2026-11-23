// Local-only API checks for mobile instructions: the real lib/api.ts runs inside workerd (Miniflare)
// with an in-memory D1 per scenario. No network, no production D1. Run: npm run test:instructions
import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';

const root=path.resolve(import.meta.dirname,'..');
const bundled=(await build({stdin:{contents:"import {handleApi} from './lib/api.ts';export default {fetch:req=>handleApi(req)};",resolveDir:root,loader:'ts'},bundle:true,write:false,format:'esm',platform:'neutral',mainFields:['module','main'],conditions:['workerd','worker','import'],external:['cloudflare:workers'],target:'es2022',logLevel:'silent'})).outputFiles[0].text;
const pure=(await build({stdin:{contents:"export * from './lib/instructions.mts';",resolveDir:root,loader:'ts'},bundle:true,write:false,format:'esm',platform:'neutral',target:'es2022',logLevel:'silent'})).outputFiles[0].text;
const {cleanSummary,cleanQuestion,cleanSessionName,cleanText,MASKED_LINE,MASKED_QUESTION}=await import('data:text/javascript;base64,'+Buffer.from(pure).toString('base64'));
const migrations=[];for(const f of (await readdir(path.join(root,'drizzle'))).filter(f=>f.endsWith('.sql')).sort())migrations.push(...(await readFile(path.join(root,'drizzle',f),'utf8')).split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean));

const ORIGIN='http://sites.local.test',KEY='bridge-test-key',OWNER='owner-1b7e-test',OTHER='someone-else-9f2c';
const sensitive=[OWNER,OTHER];let runtimeOutput='';const responses=[];const checks=[];
const ok=(name)=>checks.push(name);
const instances=[];
async function boot(vars={},persist){
 const mf=new Miniflare({modules:true,script:bundled,compatibilityDate:'2026-05-15',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'instructions-test'},r2Buckets:['BUCKET'],...(persist?{d1Persist:persist}:{}),
  bindings:{BRIDGE_SECRET:KEY,INSTRUCTIONS_ENABLED:'true',...vars},
  handleRuntimeStdio(out,err){for(const s of [out,err])s.on('data',d=>{runtimeOutput+=d;});}});
 instances.push(mf);
 const db=await mf.getD1Database('DB');
 if(!persist||!(await db.prepare("SELECT name FROM sqlite_master WHERE name='instructions'").first()))for(const s of migrations)await db.prepare(s).run();
 const call=async(method,route,{user,bridge,origin=ORIGIN,site='same-origin',body,raw,type='application/json',headers={},record=true}={})=>{
  const h={...headers};
  if(user)h['oai-authenticated-user-id']=user;
  if(bridge)h['x-reels-bridge-key']=bridge===true?KEY:bridge;
  if(method!=='GET'){if(origin)h.origin=origin;if(site)h['sec-fetch-site']=site;if(type)h['content-type']=type;}
  const r=await mf.dispatchFetch(ORIGIN+route,{method,headers:h,body:method==='GET'?undefined:raw??(body===undefined?undefined:JSON.stringify(body))});
  const text=await r.text();if(record)responses.push(text);let data=null;try{data=JSON.parse(text);}catch{}
  return {status:r.status,data,text,headers:r.headers};
 };
 const me={mf,db,call,
  create:(body,opts={})=>call('POST','/api/instructions',{user:OWNER,body:{idempotencyKey:crypto.randomUUID(),...body},...opts}),
  list:(user=OWNER)=>call('GET','/api/instructions',{user}),
  cancel:(id,opts={})=>call('POST','/api/instructions/'+id+'/cancel',{user:OWNER,body:{},...opts}),
  claim:(capacity=1)=>call('POST','/api/bridge/instructions/claim',{bridge:true,body:{capacity},origin:null,site:null}),
  status:(id,body)=>call('POST','/api/bridge/instructions/'+id+'/status',{bridge:true,body,origin:null,site:null}),
  events:async id=>(await db.prepare('SELECT actor,from_status,to_status,note FROM instruction_events WHERE instruction_id=? ORDER BY at,rowid').bind(id).all()).results,
  row:async id=>db.prepare('SELECT * FROM instructions WHERE id=?').bind(id).first(),
 };
 return me;
}
const at='2026-11-20T10:00:00.000Z';
const week={from:'2026-11-15',to:'2026-11-22',totals:{target:1,done:0,remaining:1},channels:[]};
async function seed(t,todayTarget='project:pending'){
 const r=await t.call('PUT','/api/bridge/snapshot',{bridge:true,origin:null,site:null,body:{sourceId:'primary-mac',sourceLabel:'로컬 검증',sourceRevision:'instr-'+Math.random(),sourceUpdatedAt:at,
  contents:[{id:'pending',title:'합성 pending',date:'2026-11-20',dateBasis:'record',stage:'review',nextAction:'검토',publicURL:''},{id:'로지-레몬젤리',title:'합성 2',date:'2026-11-19',dateBasis:'record',stage:'editing',nextAction:'편집',publicURL:''}],assets:[],
  monitor:{generatedAt:at,thisWeek:week,nextWeek:week,queue:{until:'2026-12-01',channels:[]},autopilot:{enabled:true,paused:false,notice:null,status:'대기',today:{title:'오늘',target:todayTarget,why:[],decision:'d',doneWhen:'w',outcome:null,changeCount:0}}}}});
 assert.equal(r.status,200,r.text);
}
const TEXT='이 worktree의 git status를 요약해 보고해 줘';
try{
 // ---- pure validators
 {assert.equal(cleanText('  a\r\nb\t ').value,'a\nb');
  for(const bad of ['a\u0000b','a\u0007','a\ud800',''+String.fromCharCode(0x1b)+'[31m'])assert.equal(cleanText(bad).ok,false,JSON.stringify(bad));
  assert.equal(cleanText('가'.repeat(4000)).ok,true);assert.equal(cleanText('가'.repeat(4001)).error,'TEXT_TOO_LONG');assert.equal(cleanText('\u{1F34B}'.repeat(4000)).ok,true);
  assert.deepEqual(cleanSummary('정상 줄\n경로 /Users/example/Obsidian/x.md 수정\n토큰 sk-abcdefghijklmnopqrstu\nfile:///etc/passwd\n~/side/x\nC:\\Users\\x\n숨김​문자\n벨\u0007\nhttps://example.com/ok').value.split('\n'),['정상 줄',MASKED_LINE,MASKED_LINE,MASKED_LINE,MASKED_LINE,MASKED_LINE,MASKED_LINE,MASKED_LINE,'https://example.com/ok']);
  assert.equal(cleanSummary(Array(11).fill('x').join('\n')).ok,false);assert.equal(cleanSummary('x'.repeat(2001)).ok,false);
  assert.equal(cleanQuestion('ghp_' + 'a'.repeat(30) + ' 를 넣을까요?').value,MASKED_QUESTION);assert.equal(cleanQuestion('초안 A와 B 중 무엇으로 갈까요?').value,'초안 A와 B 중 무엇으로 갈까요?');
  for(const bad of ['/Users/example/invalid','sites-1\n2','a/b','x'.repeat(121),'세션‮',' lead'])assert.equal(cleanSessionName(bad).ok,false,bad);
  assert.equal(cleanSessionName('sites-1a2b3c4d').ok,true);assert.equal(cleanSessionName('Sites 작업 1a2b3c4d').ok,true);
  ok('validators: text trim/control/surrogate/4000cp; summary/question path·token·hidden masking; session name');}

 // ---- identity, switches, read gate
 const t=await boot();await seed(t);
 {let r=await t.call('GET','/api/instructions');assert.equal(r.status,401);
  r=await t.create({text:TEXT},{user:null});assert.equal(r.status,401);
  r=await t.create({text:TEXT},{user:null,bridge:true});assert.equal(r.status,401,'bridge key alone is not a site user');
  r=await t.call('GET','/api/briefing');assert.equal(r.status,401,'no header, no read');
  r=await t.call('GET','/api/briefing',{user:OTHER});assert.equal(r.status,200,'any signed-in site user reads');
  r=await t.call('GET','/api/briefing',{bridge:true});assert.equal(r.status,200);
  r=await t.call('GET','/api/whoami',{user:OTHER});assert.deepEqual(r.data,{header:true,canInstruct:true});
  r=await t.call('GET','/api/whoami');assert.deepEqual(r.data,{header:false,canInstruct:false});
  // Shared queue: a second signed-in user can create, sees everyone's items and can cancel a queued one.
  const mine=(await t.create({text:TEXT+' shared-a'})).data.item;
  r=await t.create({text:TEXT+' shared-b'},{user:OTHER});assert.equal(r.status,201,'another site user can instruct');const theirs=r.data.item;
  r=await t.list(OTHER);assert.equal(r.status,200);assert.ok(r.data.items.some(x=>x.id===mine.id)&&r.data.items.some(x=>x.id===theirs.id),'shared list');
  r=await t.cancel(mine.id,{user:OTHER});assert.deepEqual([r.status,r.data.item.status],[200,'cancelled'],'any site user can cancel queued');
  await t.cancel(theirs.id);
  ok('site access is the permission: missing header 401, bridge key is not a site user, any signed-in user reads/creates/lists/cancels the shared queue, whoami booleans');}
 {const off=await boot({INSTRUCTIONS_ENABLED:''});await seed(off);
  let r=await off.create({text:TEXT});assert.deepEqual([r.status,r.data.error],[403,'DISABLED']);
  r=await off.claim(1);assert.deepEqual(r.data,{items:[],enabled:false});
  r=await off.list();assert.equal(r.status,200);assert.equal(r.data.enabled,false);
  ok('server switch off: create 403 DISABLED, claim empty with enabled:false, list shows enabled:false');}

 // ---- CSRF and body limits
 {for(const [label,opts,expect] of [['origin mismatch',{origin:'https://evil.test'},403],['cross-site',{site:'cross-site'},403],['same-site',{site:'same-site'},403],['neither',{origin:null,site:null},403],['origin only',{site:null},201],['sec-fetch-site only',{origin:null},201]]){
   const r=await t.create({text:TEXT+' '+label},opts);assert.equal(r.status,expect,label+' '+r.text);if(expect===403)assert.equal(r.data.error,'CROSS_SITE');}
  let r=await t.call('POST','/api/instructions',{user:OWNER,raw:'x'.repeat(25*1024)});assert.deepEqual([r.status,r.data.error],[413,'BODY_TOO_LARGE']);
  r=await t.call('POST','/api/instructions',{user:OWNER,raw:JSON.stringify({text:'a',idempotencyKey:crypto.randomUUID()}),type:'text/plain'});assert.equal(r.status,415);
  r=await t.create({text:'가'.repeat(4001)});assert.deepEqual([r.status,r.data.error],[413,'TEXT_TOO_LONG']);
  r=await t.create({text:'a\u0000b'});assert.equal(r.status,400);
  r=await t.create({text:'   '});assert.equal(r.status,400);
  r=await t.create({text:TEXT,extra:1});assert.equal(r.status,400);
  r=await t.call('POST','/api/instructions',{user:OWNER,body:{text:TEXT}});assert.deepEqual([r.status,r.data.error],[400,'IDEMPOTENCY_KEY_REQUIRED']);
  r=await t.create({text:TEXT,endLevel:'publish_now'});assert.equal(r.status,400);
  r=await t.create({text:TEXT,target:'project:pending\nreels publish'});assert.deepEqual([r.status,r.data.error],[400,'TARGET_INVALID']);
  r=await t.create({text:TEXT,target:'project:does-not-exist'});assert.deepEqual([r.status,r.data.error],[400,'TARGET_UNKNOWN']);
  r=await t.create({text:TEXT,target:'https://example.com/not-today'});assert.deepEqual([r.status,r.data.error],[400,'TARGET_UNKNOWN']);
  ok('CSRF: origin mismatch/cross-site/same-site/neither 403; JSON-only 415; body >24KiB 413; text >4000cp 413; control/empty/unknown keys/bad key/end level/target 400');}

 // ---- rate, queue cap, idempotency
 {const r1=await boot();await seed(r1);const keys=[];
  for(let i=0;i<3;i++){const k=crypto.randomUUID();keys.push(k);const r=await r1.create({text:TEXT+i,target:i?'project:로지-레몬젤리':'project:pending',endLevel:'draft',idempotencyKey:k});assert.equal(r.status,201,r.text);}
  let r=await r1.create({text:TEXT+'4'});assert.deepEqual([r.status,r.data.error,r.data.window],[429,'RATE_LIMITED','minute']);
  const first=await r1.create({text:TEXT+0,target:'project:pending',endLevel:'draft',idempotencyKey:keys[0]});assert.equal(first.status,200,'resend is answered before the rate limit');assert.equal(first.data.duplicate,true);
  r=await r1.create({text:TEXT+0+' 바뀜',target:'project:pending',endLevel:'draft',idempotencyKey:keys[0]});assert.deepEqual([r.status,r.data.error],[409,'IDEMPOTENCY_CONFLICT']);
  r=await r1.create({text:TEXT+0,target:'project:pending',endLevel:'pre_merge',idempotencyKey:keys[0]});assert.equal(r.status,409);
  r=await r1.create({text:TEXT+0,target:'project:pending',endLevel:'draft',idempotencyKey:keys[0].toUpperCase()});assert.equal(r.status,200);
  assert.equal((await r1.db.prepare('SELECT count(*) AS n FROM instructions').first()).n,3);
  // after cancel, the same key returns the cancelled item and creates nothing
  const id0=first.data.item.id;assert.equal((await r1.cancel(id0)).status,200);
  r=await r1.create({text:TEXT+0,target:'project:pending',endLevel:'draft',idempotencyKey:keys[0]});assert.deepEqual([r.status,r.data.item.id,r.data.item.status],[200,id0,'cancelled']);
  // double tap: the same key sent twice at once yields one row
  const dbl=await boot();await seed(dbl);const k=crypto.randomUUID();
  const pair=await Promise.all([dbl.create({text:TEXT,idempotencyKey:k}),dbl.create({text:TEXT,idempotencyKey:k})]);
  assert.deepEqual(pair.map(p=>p.status).sort(),[200,201]);assert.equal(pair[0].data.item.id,pair[1].data.item.id);
  assert.equal((await dbl.db.prepare('SELECT count(*) AS n FROM instructions').first()).n,1);assert.equal((await dbl.events(pair[0].data.item.id)).length,1);
  const q=await boot({INSTRUCTIONS_RATE_PER_MINUTE:'30'});await seed(q);
  for(let i=0;i<5;i++)assert.equal((await q.create({text:TEXT+i})).status,201);
  r=await q.create({text:TEXT+'6'});assert.deepEqual([r.status,r.data.error],[429,'QUEUE_FULL']);
  const d=await boot({INSTRUCTIONS_RATE_PER_MINUTE:'30',INSTRUCTIONS_RATE_PER_DAY:'4'});await seed(d);
  for(let i=0;i<4;i++){const c=await d.create({text:TEXT+i});assert.equal(c.status,201);await d.cancel(c.data.item.id);}
  r=await d.create({text:TEXT+'5'});assert.deepEqual([r.status,r.data.error,r.data.window],[429,'RATE_LIMITED','day']);
  ok('rate 3/min → 429; resend before limit 200 same item; different payload 409; key case-insensitive; cancelled key not recreated; concurrent double tap → 1 row; queued cap 5 → 429 QUEUE_FULL; 24h cap → 429');}

 // ---- claim atomicity, transitions, audit
 {const c=await boot({INSTRUCTIONS_RATE_PER_MINUTE:'30'});await seed(c);
  const a=(await c.create({text:TEXT+' A'})).data.item,b=(await c.create({text:TEXT+' B'})).data.item;
  const both=await Promise.all([c.claim(1),c.claim(1)]);
  const got=both.flatMap(x=>x.data.items);assert.equal(got.length,1,'two concurrent claims take one item');assert.equal(got[0].id,a.id,'oldest first');
  assert.deepEqual(Object.keys(got[0]).sort(),['created_at','end_level','id','target','text']);assert.equal(got[0].text,TEXT+' A');
  assert.equal((await c.claim(2)).data.items.length,0,'max active 1 counts claimed');
  let r=await c.status(b.id,{status:'running',sessionName:'sites-x'});assert.deepEqual([r.status,r.data.error],[409,'TRANSITION_NOT_ALLOWED'],'queued→running');
  r=await c.status(a.id,{status:'done'});assert.equal(r.status,409,'claimed→done');
  r=await c.status(a.id,{status:'running'});assert.deepEqual([r.status,r.data.error],[400,'SESSION_NAME_REQUIRED']);
  r=await c.status(a.id,{status:'running',sessionName:'/Users/example/x'});assert.equal(r.status,400);
  r=await c.status(a.id,{status:'running',sessionName:'sites-'+a.id.slice(0,8)});assert.equal(r.status,200);assert.ok(r.data.item.started_at);
  r=await c.status(a.id,{status:'running',sessionName:'sites-again'});assert.deepEqual([r.status,r.data.unchanged,r.data.item.session_name],[200,true,'sites-'+a.id.slice(0,8)],'running→running is an idempotent no-op');
  assert.equal((await c.claim(1)).data.items.length,0,'running occupies the slot');
  r=await c.status(a.id,{status:'needs_user'});assert.deepEqual([r.status,r.data.error],[400,'QUESTION_REQUIRED']);
  r=await c.status(a.id,{status:'done',errorCode:'TIMEOUT'});assert.equal(r.status,400);
  r=await c.status(a.id,{status:'done',question:'?'});assert.equal(r.status,400);
  r=await c.status(a.id,{status:'needs_user',question:'초안 A와 B 중 어느 쪽?',summary:'초안 두 개 작성\n저장 위치 /Users/example/Obsidian/side/x.md'});
  assert.equal(r.status,200);assert.equal(r.data.item.summary,'초안 두 개 작성\n'+MASKED_LINE);assert.equal(r.data.item.session_name,'sites-'+a.id.slice(0,8));
  r=await c.status(a.id,{status:'done'});assert.equal(r.status,409,'needs_user is terminal for the bridge');
  const next=(await c.claim(1)).data.items;assert.deepEqual(next.map(x=>x.id),[b.id],'needs_user frees the slot');
  r=await c.status(b.id,{status:'failed',errorCode:'NOT_A_CODE'});assert.equal(r.status,400);
  r=await c.status(b.id,{status:'failed',errorCode:'LAUNCH_FAILED'});assert.equal(r.status,200);assert.equal(r.data.item.error_code,'LAUNCH_FAILED');
  r=await c.status(b.id,{status:'running',sessionName:'sites-b'});assert.equal(r.status,409,'failed→running');
  r=await c.status(crypto.randomUUID(),{status:'running',sessionName:'x'});assert.equal(r.status,404);
  r=await c.call('POST','/api/bridge/instructions/claim',{user:OWNER,body:{capacity:1}});assert.equal(r.status,401,'owner header cannot claim');
  r=await c.call('POST','/api/bridge/instructions/'+b.id+'/status',{user:OWNER,body:{status:'done'}});assert.equal(r.status,401,'owner header cannot set status');
  r=await c.call('POST','/api/bridge/instructions/claim',{bridge:'wrong-key',body:{capacity:1}});assert.equal(r.status,401);
  for(const capacity of [3,-1,1.5,'1'])assert.equal((await c.claim(capacity)).status,400);
  assert.deepEqual(await c.events(a.id),[{actor:'owner',from_status:null,to_status:'queued',note:'CREATED'},{actor:'bridge',from_status:'queued',to_status:'claimed',note:'CLAIMED'},{actor:'bridge',from_status:'claimed',to_status:'running',note:'STARTED'},{actor:'bridge',from_status:'running',to_status:'needs_user',note:'NEEDS_USER'}]);
  assert.deepEqual(await c.events(b.id),[{actor:'owner',from_status:null,to_status:'queued',note:'CREATED'},{actor:'bridge',from_status:'queued',to_status:'claimed',note:'CLAIMED'},{actor:'bridge',from_status:'claimed',to_status:'failed',note:'FAILED:LAUNCH_FAILED'}]);
  r=await c.cancel(a.id);assert.deepEqual([r.status,r.data.error],[409,'NOT_CANCELLABLE']);
  ok('concurrent claim ×2 → one item (oldest); claimed/running occupy the only slot; disallowed transitions 409; field rules 400; summary path masked; needs_user frees slot; owner header/wrong key on bridge routes 401; one audit row per transition');}
 {const m=await boot({INSTRUCTIONS_MAX_ACTIVE:'2',INSTRUCTIONS_RATE_PER_MINUTE:'30',INSTRUCTIONS_RATE_PER_DAY:'200',INSTRUCTIONS_QUEUE_MAX:'50'});await seed(m);
  for(let round=0;round<10;round++){
   const ids=[];for(let i=0;i<3;i++)ids.push((await m.create({text:TEXT+round+i})).data.item.id);
   const rs=await Promise.all([m.claim(2),m.claim(2),m.claim(1)]);const got=rs.flatMap(x=>x.data.items.map(i=>i.id));
   assert.equal(got.length,2,'never more than max active');assert.equal(new Set(got).size,2,'no item claimed twice');
   for(const id of got){await m.status(id,{status:'running',sessionName:'s-'+round});await m.status(id,{status:'done',summary:'ok'});}
   const rest=(await m.db.prepare("SELECT id FROM instructions WHERE status IN ('queued','claimed')").all()).results;
   for(const x of rest){if((await m.row(x.id)).status==='queued')await m.cancel(x.id);}
  }
  ok('max active 2: 10 rounds of three concurrent claims → exactly 2 distinct items each');}
 {const race=await boot({INSTRUCTIONS_RATE_PER_MINUTE:'30',INSTRUCTIONS_RATE_PER_DAY:'200',INSTRUCTIONS_QUEUE_MAX:'50'});await seed(race);let cancelWins=0,claimWins=0;
  for(let i=0;i<12;i++){
   const made=await race.create({text:TEXT+i});assert.equal(made.status,201,made.text);const it=made.data.item;
   // Alternate which request is dispatched first so both orders are exercised.
   const [cn,cl]=i%2?await Promise.all([race.cancel(it.id),race.claim(1)]):(await Promise.all([race.claim(1),race.cancel(it.id)])).reverse();
   const claimed=cl.data.items.some(x=>x.id===it.id);
   assert.ok((cn.status===200)!==claimed,'exactly one of cancel/claim wins');
   const row=await race.row(it.id),ev=await race.events(it.id);assert.equal(ev.length,2);
   if(claimed){claimWins++;assert.equal(cn.status,409);assert.equal(row.status,'claimed');await race.status(it.id,{status:'failed',errorCode:'BRIDGE_DISABLED'});}
   else{cancelWins++;assert.equal(row.status,'cancelled');}
  }
  ok('cancel vs claim race ×12: exactly one wins, 2 audit rows (cancel won '+cancelWins+', claim won '+claimWins+')');}

 // ---- expiry and heartbeat compatibility
 {const e=await boot({INSTRUCTIONS_RATE_PER_MINUTE:'30',MEDIA_READS_ENABLED:'true',MEDIA_PREVIEWS_ENABLED:'true'});await seed(e);const k=crypto.randomUUID();
  const it=(await e.create({text:TEXT,idempotencyKey:k})).data.item;
  assert.equal(Date.parse(it.expires_at)-Date.parse(it.created_at),24*3600_000,'TTL 24h');
  await e.db.prepare('UPDATE instructions SET expires_at=? WHERE id=?').bind('2000-01-01T00:00:00.000Z',it.id).run();
  assert.equal((await e.claim(1)).data.items.length,0,'expired before claim');
  const listed=(await e.list()).data.items.find(x=>x.id===it.id);assert.equal(listed.status,'expired');
  assert.deepEqual((await e.events(it.id)).map(x=>[x.actor,x.to_status,x.note]),[['owner','queued','CREATED'],['server','expired','EXPIRED']]);
  const again=await e.create({text:TEXT,idempotencyKey:k});assert.deepEqual([again.status,again.data.item.id,again.data.item.status],[200,it.id,'expired']);
  assert.equal((await e.cancel(it.id)).status,409);
  const it2=(await e.create({text:TEXT+2})).data.item;await e.db.prepare('UPDATE instructions SET expires_at=? WHERE id=?').bind('2000-01-01T00:00:00.000Z',it2.id).run();
  assert.equal((await e.list()).data.items.find(x=>x.id===it2.id).status,'expired','expired on read');
  const {source_revision:sourceRevision}=await e.db.prepare('SELECT source_revision FROM sync_runs').first();
  const expectedBeat={ok:true,mediaEnabled:true,previewsEnabled:true,instructionsEnabled:true,sourceRevision};
  let r=await e.call('POST','/api/bridge/heartbeat',{bridge:true,origin:null,site:null,type:null});assert.equal(r.status,200);assert.deepEqual(r.data,expectedBeat);
  assert.equal((await e.list()).data.macReady,null,'legacy heartbeat: no readiness');
  r=await e.call('POST','/api/bridge/heartbeat',{bridge:true,origin:null,site:null,body:{instructions:{ready:false,reason:'locked'}}});assert.equal(r.status,200);assert.deepEqual(r.data,expectedBeat);
  let l=(await e.list()).data;assert.deepEqual([l.macOnline,l.macReady],[true,{ready:false,reason:'locked'}]);
  r=await e.call('POST','/api/bridge/heartbeat',{bridge:true,origin:null,site:null,body:{instructions:{ready:true}}});l=(await e.list()).data;assert.deepEqual(l.macReady,{ready:true,reason:null});
  for(const bad of [{instructions:{ready:'yes'}},{instructions:{ready:false,reason:'sleeping'}},{other:1}]){r=await e.call('POST','/api/bridge/heartbeat',{bridge:true,origin:null,site:null,body:bad});assert.equal(r.status,400);}
  ok('expiry and heartbeat: readiness stored and validated; both heartbeat formats return media flags, instruction flag and source revision');}

 // ---- claim lost: a claim never followed by running frees the slot as failed CLAIM_LOST (never re-queued)
 {const l=await boot({INSTRUCTIONS_RATE_PER_MINUTE:'30'});await seed(l);
  const back=(id,min)=>l.db.prepare('UPDATE instructions SET claimed_at=? WHERE id=?').bind(new Date(Date.now()-min*60_000).toISOString(),id).run();
  const a=(await l.create({text:TEXT+' lost'})).data.item;assert.deepEqual((await l.claim(1)).data.items.map(x=>x.id),[a.id]);
  const b=(await l.create({text:TEXT+' next'})).data.item;
  await back(a.id,9);assert.equal((await l.claim(1)).data.items.length,0,'9 minutes: still occupying');assert.equal((await l.row(a.id)).status,'claimed');
  await back(a.id,11);const got=(await l.claim(1)).data.items;assert.deepEqual(got.map(x=>x.id),[b.id],'next claim takes the new item');
  const row=await l.row(a.id);assert.deepEqual([row.status,row.error_code],['failed','CLAIM_LOST']);assert.ok(row.finished_at);
  const ev=await l.events(a.id);assert.deepEqual(ev.map(e=>[e.actor,e.from_status,e.to_status,e.note]),[['owner',null,'queued','CREATED'],['bridge','queued','claimed','CLAIMED'],['server','claimed','failed','CLAIM_LOST']]);
  let r=await l.status(a.id,{status:'running',sessionName:'sites-late'});assert.deepEqual([r.status,r.data.error],[409,'TRANSITION_NOT_ALLOWED'],'late running report');
  r=await l.status(b.id,{status:'failed',errorCode:'CLAIM_LOST'});assert.equal(r.status,400,'the bridge cannot report CLAIM_LOST');
  // also applied on read, and the timeout is configurable
  const m=await boot({INSTRUCTIONS_CLAIM_TIMEOUT_MINUTES:'2'});await seed(m);const c=(await m.create({text:TEXT})).data.item;await m.claim(1);
  await m.db.prepare('UPDATE instructions SET claimed_at=? WHERE id=?').bind(new Date(Date.now()-3*60_000).toISOString(),c.id).run();
  const listed=(await m.list()).data.items.find(x=>x.id===c.id);assert.deepEqual([listed.status,listed.error_code],['failed','CLAIM_LOST']);
  assert.equal((await m.events(c.id)).filter(e=>e.note==='CLAIM_LOST').length,1);await m.list();assert.equal((await m.events(c.id)).filter(e=>e.note==='CLAIM_LOST').length,1,'idempotent on repeated reads');
  ok('claim lost: 9 min keeps the slot, after 10 min the next claim takes a new item, old one failed CLAIM_LOST with one server event, late running 409, bridge cannot send CLAIM_LOST, also on read, timeout env');}

 // ---- same-status re-reports are idempotent; refusals say the current status and error code
 {const s=await boot({INSTRUCTIONS_RATE_PER_MINUTE:'30'});await seed(s);
  const a=(await s.create({text:TEXT+' idem'})).data.item;await s.claim(1);
  let r=await s.status(a.id,{status:'running',sessionName:'sites-'+a.id.slice(0,8)});assert.equal(r.status,200);const started=r.data.item.started_at;
  await new Promise(res=>setTimeout(res,5));
  r=await s.status(a.id,{status:'running',sessionName:'sites-'+a.id.slice(0,8)});assert.deepEqual([r.status,r.data.unchanged,r.data.item.status,r.data.item.started_at],[200,true,'running',started]);
  const twice=await Promise.all([s.status(a.id,{status:'done',summary:'완료'}),s.status(a.id,{status:'done',summary:'완료'})]);
  assert.deepEqual(twice.map(x=>x.status),[200,200],'concurrent identical done reports both succeed');
  const finished=(await s.row(a.id)).finished_at;
  r=await s.status(a.id,{status:'done',summary:'완료'});assert.deepEqual([r.status,r.data.unchanged,r.data.item.finished_at],[200,true,finished]);
  assert.deepEqual((await s.events(a.id)).map(e=>e.note),['CREATED','CLAIMED','STARTED','DONE'],'one event per real transition');
  r=await s.status(a.id,{status:'failed',errorCode:'AGENT_FAILED'});assert.deepEqual([r.status,r.data.status,r.data.error_code],[409,'done',null]);
  assert.ok(!('text' in r.data)&&!('item' in r.data)&&!r.text.includes(TEXT)&&!r.text.includes(OWNER));
  const b=(await s.create({text:TEXT+' lost'})).data.item;await s.claim(1);
  await s.db.prepare('UPDATE instructions SET claimed_at=? WHERE id=?').bind(new Date(Date.now()-11*60_000).toISOString(),b.id).run();await s.list();
  r=await s.status(b.id,{status:'running',sessionName:'sites-late'});assert.deepEqual([r.status,r.data.error,r.data.status,r.data.error_code],[409,'TRANSITION_NOT_ALLOWED','failed','CLAIM_LOST']);
  assert.deepEqual(Object.keys(r.data).sort(),['error','error_code','status']);
  r=await s.status(b.id,{status:'failed',errorCode:'LAUNCH_FAILED'});assert.deepEqual([r.status,r.data.unchanged,r.data.item.error_code],[200,true,'CLAIM_LOST'],'failed again keeps CLAIM_LOST');
  assert.equal((await s.events(b.id)).length,3);
  ok('same-status re-report 200 unchanged (running, done ×3 incl. concurrent), timestamps/events untouched; 409 body has only status/error_code; CLAIM_LOST then running → 409 failed/CLAIM_LOST');}

 // ---- nothing sensitive leaves the server
 for(const text of responses){for(const s of sensitive)assert.ok(!text.includes(s),'owner id in a response');assert.ok(!text.includes('owner_id')&&!text.includes('idempotency_key'));}
 assert.ok(!runtimeOutput.includes(TEXT)&&!sensitive.some(s=>runtimeOutput.includes(s)),'worker output contains instruction text or owner id');
 ok(responses.length+' responses without owner_id/idempotency_key/owner values; worker console without text or owner ids');
 for(const c of checks)console.log('ok -',c);
 console.log('PASS: instructions API —',checks.length,'groups');
}finally{await Promise.all(instances.map(m=>m.dispose()));}
