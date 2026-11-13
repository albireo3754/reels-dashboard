import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm,mkdir} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {markupFixture} from '../fixtures/markup-editor';
import {MarkupStore} from '../../src/app/blog-editor/markup-store';
import {startCanonicalEditor} from '../../src/app/blog-editor/server';
import {contentHistoryDir,prepareRevision,recoverRevisions,contentDiff} from '../../src/shared/content-history';
import {load,save} from '../../src/shared/blog-markup-store';
import {importDataset,readRecords,storeCase} from '../../src/app/content-evals/dataset';
import {freezeExperiment,replay,compare,judge} from '../../src/app/content-evals/runner';
import {commandAdapter} from '../../src/app/content-evals/command-adapter';
import {collectFeedback} from '../../src/app/blog-editor/content-feedback';
const temp=()=>mkdtemp(path.join(os.tmpdir(),'content-evals-'));
const jsonFiles=async(dir:string)=>Promise.all((await readdir(dir)).filter(n=>n.endsWith('.json')).map(async n=>JSON.parse(await readFile(path.join(dir,n),'utf8'))));

test('actual editor HTTP saves two edits, retains exact revisions, no-op, feedback dedup and restart',async()=>{
 const root=await temp();const config=await markupFixture(root);let server=await startCanonicalEditor(config);
 try{
  const address=server.url; // returned editor URL
  const origin=new URL(address).origin;
  const post=async(route:string,value:unknown)=>{const r=await fetch(origin+'/api/blog/'+route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});assert.equal(r.status,200,await r.clone().text());return r.json();};
  let doc=await new MarkupStore(config).load();
  const event={id:crypto.randomUUID(),revision:doc.revision,action:'keep',proposalId:'B1/f1',proposal:{text:'Unwanted'}};
  assert.equal((await post('feedback',event)).created,true);assert.equal((await post('feedback',event)).created,false);
  await assert.rejects(collectFeedback(config.canon,{...event,action:'accept-intent'}),/EVENT_ID_CONFLICT/);
  for(const source of ['First direct edit','Second direct edit']){const r=await post('save',{revision:doc.revision,decisionIds:[event.id],edits:[{id:'P2',source}]});doc=r.document;}
  await post('save',{revision:doc.revision,edits:[{id:'P2',source:'Second direct edit'}]});
  const dir=contentHistoryDir(config.canon),tx=await jsonFiles(path.join(dir,'transactions'));
  assert.equal(tx.length,2);assert.ok(tx.every(t=>t.context.decisionIds.includes(event.id)));
  assert.equal((await jsonFiles(path.join(dir,'receipts'))).length,2);
  const last=tx.find(t=>t.diff.inserted.includes('Second'))!;assert.ok(last);
  assert.equal((await jsonFiles(path.join(dir,'events'))).length,1);
  await server.close();server=await startCanonicalEditor(config);
  assert.match((await new MarkupStore(config).load()).sourceText!,/Second direct edit/);
 }finally{await server.close();await rm(root,{recursive:true,force:true});}
});
test('pending writes recover without falsely claiming unobserved changes; immutable exact diff',async()=>{
 const root=await temp();try{
 const file=path.join(root,'article.md');await writeFile(file,'before');
 const id=await prepareRevision(file,'before','after','user');await writeFile(file,'after');await recoverRevisions(file,'after');
 const missing=await prepareRevision(file,'after','never written','user');await recoverRevisions(file,'after');
 const receipts=await jsonFiles(path.join(contentHistoryDir(file),'receipts'));
 assert.equal(receipts.find(r=>r.id===id).status,'recovered');assert.equal(receipts.find(r=>r.id===missing).status,'not-observed');
 const d=contentDiff('abcXYZend','abcZZend');assert.equal('abcXYZend'.slice(0,d.start)+d.inserted+'abcXYZend'.slice(d.start+d.removed.length),'abcZZend');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('journal failure prevents manuscript mutation; external edits keep unknown attribution',async()=>{
 const root=await temp();try{
 const config=await markupFixture(root),base=await load(config.canon);
 await mkdir(path.dirname(contentHistoryDir(config.canon)),{recursive:true});await writeFile(contentHistoryDir(config.canon),'blocked');
 await assert.rejects(save(config.canon,base.text.replace('Second line','Edit'),base,{actor:'user'}));assert.equal(await readFile(config.canon,'utf8'),base.text);
 await rm(contentHistoryDir(config.canon));
 await save(config.canon,base.text.replace('Second line','Edit'),base,{actor:'user'});
 await writeFile(config.canon,(await readFile(config.canon,'utf8')).replace('Edit','Outside'));
 const next=await load(config.canon);await save(config.canon,next.text.replace('Outside','Next'),next,{actor:'user'});
 const events=await jsonFiles(path.join(contentHistoryDir(config.canon),'events'));assert.equal(events[0].actor,'unknown');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('real import contract is repeatable, preserves provenance and separates confirmation/holdout',async()=>{
 const root=await temp();try{
 const source=path.join(root,'notes.md');await writeFile(source,'# Notes\nUser shortened a phrase.\n## Inference\nReason unknown.');
 const manifest={version:1,sources:[{file:source,kind:'notes'}]},out=path.join(root,'dataset');
 const first=await importDataset(manifest,out),second=await importDataset(manifest,out);assert.equal(first.collected,2);assert.equal(second.collected,0);assert.equal(second.duplicates,2);
 const records=await readRecords(out);assert.ok(records.every(r=>r.labelStatus==='unconfirmed'&&r.actor==='unknown'));
 const c={version:1,id:'case1',rawIds:[records[0].id],status:'confirmed',split:'development',input:'text',expectedFindingIds:['f1'],exhaustive:true};
 await assert.rejects(storeCase(out,c),/confirmation/);
 const confirmed={...c,confirmation:{actor:'user',by:'synthetic tester',evidence:'fixture only',at:new Date().toISOString()}};
 await storeCase(out,confirmed);await assert.rejects(storeCase(out,{...confirmed,split:'holdout'}),/Historical/);
 assert.match(await readFile(path.join(out,'dataset.csv'),'utf8'),/sourceHash/);
 }finally{await rm(root,{recursive:true,force:true});}
});
const confirmedCase={version:1 as const,id:'case1',rawIds:['a'.repeat(64)],status:'confirmed' as const,split:'development' as const,input:'test',expectedFindingIds:['f1'],exhaustive:true,confirmation:{actor:'user' as const,by:'fixture',evidence:'synthetic',at:'2026-11-13T00:00:00.000Z'}};
test('frozen paired replay, retries, omitted cases, scoped judge and mismatched inputs',async()=>{
 const root=await temp();try{
 const file=path.join(root,'input.md'),adapter=path.join(root,'adapter.mjs');await writeFile(file,'frozen input');await writeFile(adapter,'export async function run(){}');
 const spec={version:1,name:'fixture',model:'fixture',workflow:'existing-workflow-contract',settings:{},adapter,files:[{role:'input',file}],cases:[confirmedCase],scope:['text'],unexecuted:['visual'],maxAttempts:2};
 const a=await freezeExperiment(spec,path.join(root,'runs')),b=await freezeExperiment({...spec,model:'fixture-b'},path.join(root,'runs'));
 await writeFile(file,'later source edit');
 let calls=0;const result=await replay(a.directory,{async run(){if(++calls===1)throw Error('transient');return {findings:[{caseId:'case1',ids:['f1']}],evidence:[],usage:null,execution:'fixture',unexecuted:[]};}});
 assert.equal(result.attempts.length,2);assert.equal(result.cases[0].status,'passed');
 const other=await replay(b.directory,{async run(){return {findings:[],evidence:[],usage:null,execution:'fixture',unexecuted:[]};}});
 assert.equal(other.cases[0].status,'not-run');assert.equal((await compare(result.resultFile,other.resultFile)).comparable,true);
 const c=await freezeExperiment(spec,path.join(root,'runs'));const third=await replay(c.directory,{async run(){return {findings:[],evidence:[],usage:null,execution:'fixture',unexecuted:[]};}});
 await assert.rejects(compare(result.resultFile,third.resultFile),/MISMATCH/);
 const measured=judge([confirmedCase],{findings:[{caseId:'case1',ids:['wrong']}],evidence:[],usage:null,execution:'fixture',unexecuted:[]})[0];assert.equal(measured.status,'failed');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('command adapter stops aborted child and runner records cancellation',async()=>{
 const root=await temp();try{
 const file=path.join(root,'in'),adapter=path.join(root,'adapter.mjs');await writeFile(file,'input');await writeFile(adapter,'export {}');
 const frozen=await freezeExperiment({version:1,name:'abort',model:'none',workflow:'fixture',settings:{},adapter,files:[{role:'input',file}],cases:[confirmedCase],scope:['text'],unexecuted:[],timeoutMs:100},path.join(root,'runs'));
 const result=await replay(frozen.directory,commandAdapter(process.execPath,['-e','setInterval(()=>{},1000)']));assert.equal(result.status,'aborted');assert.equal(result.cases[0].status,'not-run');
 }finally{await rm(root,{recursive:true,force:true});}
});
