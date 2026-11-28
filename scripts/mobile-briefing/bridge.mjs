import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,rename,lstat} from 'node:fs/promises';
import path from 'node:path';
import {tsImport} from 'tsx/esm/api';
const {readMonitor}=await tsImport('./monitor.ts',import.meta.url);
const {InstructionRunner,PaseoLauncher,createInstructionApi}=await tsImport('./instructions.ts',import.meta.url);
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {LocalObjectStore,projectSnapshot} from '../../packages/icloud-object-sdk/index.mjs';
import {createMediaJobPoller,createPreviewRunner} from './media-preview.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
// Local tests and E2E inject the site URL and a key file instead of the Keychain:
// REELS_BRIDGE_URL (https, or http on loopback) + REELS_BRIDGE_KEY_FILE (0600).
async function readCredential(){
 const url=process.env.REELS_BRIDGE_URL,keyFile=process.env.REELS_BRIDGE_KEY_FILE;
 if(url||keyFile){
  if(!url||!keyFile)throw new Error('REELS_BRIDGE_URL and REELS_BRIDGE_KEY_FILE go together');
  const st=await lstat(keyFile);if(!st.isFile()||(st.mode&0o077))throw new Error('Key file must be a private regular file');
  const token=(await readFile(keyFile,'utf8')).trim();if(!token)throw new Error('Key file is empty');
  const u=new URL(url);if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)))throw new Error('HTTPS required');
  return {url,token};
 }
 const account=process.argv[2];if(!account)throw new Error('A Keychain account is required');
 // Release folders share one helper binary (its Keychain access is granted to that file): REELS_BRIDGE_KEYCHAIN_HELPER.
 const helper=process.env.REELS_BRIDGE_KEYCHAIN_HELPER??path.join(repo,'artifacts/mobile-bridge/keychain');
 const credential=JSON.parse(execFileSync(helper,['read',account],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 if(new URL(credential.url).protocol!=='https:')throw new Error('HTTPS required');
 return credential;
}
const credential=await readCredential();
const origin=new URL(credential.url);
const root=process.env.REELS_BRIDGE_DATA_DIR??path.join(os.homedir(),'Library/Application Support/Reels Dashboard/mobile-bridge');await mkdir(root,{recursive:true,mode:0o700});
let objects=new LocalObjectStore(),snapshot=null;
try{const cached=JSON.parse(await readFile(path.join(root,'registry.json'),'utf8'));objects=new LocalObjectStore(cached.objects);snapshot=cached.snapshot;}catch{}
// The app serves MCP over local HTTP; connect lazily so an app that is not running yet is only "unavailable".
const mcpUrl=new URL(process.env.REELS_MCP_URL??'http://127.0.0.1:4319/mcp');let client=null;
const shutdown=new AbortController();
const execute=promisify(execFile);
const log=(message)=>console.log(new Date().toISOString(),message);
const registry=path.join(root,'registry.json');
const runtime=path.join(repo,'native/editor-engine/.build/runtime/bin');
const jobs=createMediaJobPoller({
 request,pollOriginal,log,
 runPreview:createPreviewRunner({
  registry,cacheDir:path.join(os.homedir(),'Library/Caches/Reels Dashboard/mobile-preview'),
  ffmpeg:process.env.REELS_PREVIEW_FFMPEG??path.join(runtime,'ffmpeg'),
  ffprobe:process.env.REELS_PREVIEW_FFPROBE??path.join(runtime,'ffprobe'),
 }),
});
function stop(){shutdown.abort();void jobs.stop();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
// The code revision and the last snapshot the site accepted let the live installer confirm the new bridge.
let codeRevision=null;try{codeRevision=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}catch{}
// localRevision: the snapshot this process last built or reused; acceptedRevision: the last one the site
// confirmed holding; projectedAt: when this process last built one from the running app (null = cache only).
let summary={syncedAt:null,contentCount:null,assetCount:null,localRevision:null,acceptedRevision:null,projectedAt:null};
try{const saved=JSON.parse(await readFile(path.join(root,'status.json'),'utf8'));summary={syncedAt:saved.syncedAt,contentCount:saved.contentCount,assetCount:saved.assetCount,localRevision:null,acceptedRevision:null,projectedAt:null};}catch{}
async function reportStatus(connected){
 const status={siteUrl:origin.origin,connected,checkedAt:new Date().toISOString(),...summary,codeRevision,pid:process.pid};
 const temp=path.join(root,'status.json.tmp');
 await writeFile(temp,JSON.stringify(status),{mode:0o600});await rename(temp,path.join(root,'status.json'));
}
function rawRequest(route,options={}){
 return fetch(new URL(route,origin),{...options,headers:{'OAI-Sites-Authorization':'Bearer '+credential.token,'X-Reels-Bridge-Key':credential.token,...options.headers},redirect:'manual',signal:AbortSignal.timeout(30000)});
}
async function request(route,options={}){
 const {signal,...init}=options;
 const signals=[shutdown.signal,AbortSignal.timeout(30000)];
 if(signal)signals.push(signal);
 const r=await fetch(new URL(route,origin),{...init,headers:{'OAI-Sites-Authorization':'Bearer '+credential.token,'X-Reels-Bridge-Key':credential.token,...init.headers},redirect:'manual',signal:AbortSignal.any(signals)});
 if(!r.ok)throw new Error(`Remote request failed (${r.status})`);return r;
}
// Sites instructions: off unless <root>/instructions.json enables them. Runs in its own
// loop so media polling, heartbeats and metadata sync never wait on Paseo.
const instructions=new InstructionRunner({root,api:createInstructionApi(rawRequest),launcher:new PaseoLauncher(),log});
const heartbeat=()=>request('/api/bridge/heartbeat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(instructions.heartbeat())});
async function instructionLoop(){
 while(!shutdown.signal.aborted){
  try{await instructions.tick();}catch{log('Instruction tick failed.');}
  for(let i=0;i<10&&!shutdown.signal.aborted;i++)await new Promise(r=>setTimeout(r,1000));
 }
 await instructions.release().catch(()=>{});
}
async function mcp(name){if(!client){const next=new Client({name:'reels-mobile-bridge',version:'1'});await next.connect(new StreamableHTTPClientTransport(mcpUrl));client=next;}const r=await client.callTool({name,arguments:{}},{timeout:20000});if(r.isError)throw new Error('Local app unavailable');return r.structuredContent;}
async function refresh(){
 try{log('Reading local metadata.');await mcp('reels_get_app_state');const state=await mcp('reels_list_projects');log(`Projecting ${state.dashboard.projects.length} entries.`);const weeklyGoals=await mcp('reels_get_weekly_goals');const progress=await readMonitor(state.dashboard,path.dirname(root),weeklyGoals);const projection=await projectSnapshot(state.dashboard,'로컬 Mac',{...progress,countFolders:false,knownCounts:Object.fromEntries((snapshot?.assets??[]).filter(a=>a.isDirectory).map(a=>[a.objectKey,a.itemCount]))});log('Metadata projection ready.');objects=projection.objects;snapshot=projection.snapshot;summary.localRevision=snapshot.sourceRevision;summary.projectedAt=new Date().toISOString();
 const temp=path.join(root,'registry.json.tmp');await writeFile(temp,JSON.stringify({objects:objects.exportRegistry(),snapshot}),{mode:0o600});await rename(temp,registry);
 }catch{log('Local app is unavailable; preserving last registered metadata.');}
 if(snapshot){summary.localRevision=snapshot.sourceRevision;const remote=await (await heartbeat()).json();if(!shutdown.signal.aborted)jobs.updateHeartbeat(remote);if(remote.sourceRevision!==snapshot.sourceRevision){const result=await (await request('/api/bridge/snapshot',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot)})).json();log(`Synced ${result.contents} content entries and ${result.assets} resource records.`);}
  summary.acceptedRevision=snapshot.sourceRevision;}
 const remote=await (await request('/api/briefing')).json();
 summary={...summary,syncedAt:remote.syncedAt??null,contentCount:remote.contents.length,assetCount:remote.assets.length};
 await reportStatus(true);
}
async function pollOriginal(){
 const {jobs}=await (await request('/api/bridge/jobs')).json();
 if(jobs.length)log(`Received ${jobs.length} media request(s).`);
 await Promise.all(jobs.map(async job=>{
  try{log('Reading requested file range.');const result=await execute(process.execPath,[path.join(repo,'scripts/mobile-briefing/read-object.mjs'),registry,job.object_key,String(job.range_start),String(job.range_end),job.etag],{encoding:'buffer',timeout:8000,killSignal:'SIGKILL',maxBuffer:3*1024*1024});log('File range ready; forwarding.');await request('/api/bridge/jobs/'+job.id,{method:'PUT',body:result.stdout,headers:{'Content-Type':'application/octet-stream'}});}
  catch(e){log('Media request failed: '+(['SOURCE_CHANGED','SOURCE_UNAVAILABLE','NOT_LOCAL'].includes(e.message)?e.message:'REQUEST_FAILED'));const error=['SOURCE_CHANGED','SOURCE_UNAVAILABLE','NOT_LOCAL'].includes(e.message)?e.message:'SOURCE_UNAVAILABLE';await request('/api/bridge/jobs/'+job.id,{method:'PUT',headers:{'X-Reels-Source-Error':error}}).catch(()=>{});}
 }));
}
let nextSync=0,nextHeartbeat=0,nextFailureLog=0;
const instructionTask=instructionLoop();
try{
 while(!shutdown.signal.aborted){
  try{
   if(Date.now()>=nextSync){nextSync=Date.now()+60000;await refresh();}
   if(Date.now()>=nextHeartbeat){const beat=await (await heartbeat()).json();if(shutdown.signal.aborted)break;jobs.updateHeartbeat(beat);nextHeartbeat=Date.now()+10000;await reportStatus(true);}
   await jobs.poll();
  }catch{if(shutdown.signal.aborted)break;await reportStatus(false).catch(()=>{});if(Date.now()>nextFailureLog){log('Connection unavailable; metadata retained. Retrying.');nextFailureLog=Date.now()+60000;}}
  await new Promise(r=>setTimeout(r,1000));
 }
}finally{await jobs.stop();await instructionTask.catch(()=>{});await client?.close();}
