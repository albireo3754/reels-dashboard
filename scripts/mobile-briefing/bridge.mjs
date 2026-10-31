import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {LocalObjectStore,projectSnapshot} from '../../packages/icloud-object-sdk/index.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const account=process.argv[2];if(!account)throw new Error('A Keychain account is required');
const credential=JSON.parse(execFileSync(path.join(repo,'artifacts/mobile-bridge/keychain'),['read',account],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
const origin=new URL(credential.url);if(origin.protocol!=='https:')throw new Error('HTTPS required');
const root=path.join(os.homedir(),'Library/Application Support/Reels Dashboard/mobile-bridge');await mkdir(root,{recursive:true,mode:0o700});
let objects=new LocalObjectStore(),snapshot=null;
try{const cached=JSON.parse(await readFile(path.join(root,'registry.json'),'utf8'));objects=new LocalObjectStore(cached.objects);snapshot=cached.snapshot;}catch{}
const client=new Client({name:'reels-mobile-bridge',version:'1'});
const transport=new StdioClientTransport({command:process.execPath,args:[path.join(repo,'dist-mcp/server.mjs')],cwd:repo,env:{...process.env},stderr:'pipe'});
await client.connect(transport);
console.log(new Date().toISOString(),"MCP connection ready.");
let mediaEnabled=false;
let running=true;process.on('SIGTERM',()=>{running=false;});process.on('SIGINT',()=>{running=false;});
const execute=promisify(execFile);
const log=(message)=>console.log(new Date().toISOString(),message);
let summary={syncedAt:null,contentCount:null,assetCount:null};
try{const saved=JSON.parse(await readFile(path.join(root,'status.json'),'utf8'));summary={syncedAt:saved.syncedAt,contentCount:saved.contentCount,assetCount:saved.assetCount};}catch{}
async function reportStatus(connected){
 const status={siteUrl:origin.origin,connected,checkedAt:new Date().toISOString(),...summary};
 const temp=path.join(root,'status.json.tmp');
 await writeFile(temp,JSON.stringify(status),{mode:0o600});await rename(temp,path.join(root,'status.json'));
}
async function request(route,options={}){
 const r=await fetch(new URL(route,origin),{...options,headers:{'OAI-Sites-Authorization':'Bearer '+credential.token,'X-Reels-Bridge-Key':credential.token,...options.headers},redirect:'manual',signal:AbortSignal.timeout(30000)});
 if(!r.ok)throw new Error(`Remote request failed (${r.status})`);return r;
}
async function mcp(name){const r=await client.callTool({name,arguments:{}},{timeout:20000});if(r.isError)throw new Error('Local app unavailable');return r.structuredContent;}
async function refresh(){
 try{log('Reading local metadata.');await mcp('reels_get_app_state');const state=await mcp('reels_list_projects');log(`Projecting ${state.dashboard.projects.length} entries.`);const projection=await projectSnapshot(state.dashboard,'로컬 Mac',{countFolders:false,knownCounts:Object.fromEntries((snapshot?.assets??[]).filter(a=>a.isDirectory).map(a=>[a.objectKey,a.itemCount]))});log('Metadata projection ready.');objects=projection.objects;snapshot=projection.snapshot;
 const temp=path.join(root,'registry.json.tmp');await writeFile(temp,JSON.stringify({objects:objects.exportRegistry(),snapshot}),{mode:0o600});await rename(temp,path.join(root,'registry.json'));
 }catch{log('Local app is unavailable; preserving last registered metadata.');}
 if(snapshot){const remote=await (await request('/api/bridge/heartbeat',{method:'POST'})).json();mediaEnabled=remote.mediaEnabled===true;if(remote.sourceRevision!==snapshot.sourceRevision){const result=await (await request('/api/bridge/snapshot',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot)})).json();log(`Synced ${result.contents} content entries and ${result.assets} resource records.`);}}
 const remote=await (await request('/api/briefing')).json();
 summary={syncedAt:remote.syncedAt??null,contentCount:remote.contents.length,assetCount:remote.assets.length};
 await reportStatus(true);
}
let nextSync=0,nextHeartbeat=0,nextFailureLog=0;
try{
 while(running){
  try{
   if(Date.now()>=nextSync){nextSync=Date.now()+60000;await refresh();}
   if(Date.now()>=nextHeartbeat){const heartbeat=await (await request('/api/bridge/heartbeat',{method:'POST'})).json();mediaEnabled=heartbeat.mediaEnabled===true;nextHeartbeat=Date.now()+10000;await reportStatus(true);}
   if(!mediaEnabled){await new Promise(r=>setTimeout(r,1000));continue;}
   const {jobs}=await (await request('/api/bridge/jobs')).json();
   if(jobs.length)log(`Received ${jobs.length} media request(s).`);
   await Promise.all(jobs.map(async job=>{
    try{log('Reading requested file range.');const result=await execute(process.execPath,[path.join(repo,'scripts/mobile-briefing/read-object.mjs'),path.join(root,'registry.json'),job.object_key,String(job.range_start),String(job.range_end),job.etag],{encoding:'buffer',timeout:8000,killSignal:'SIGKILL',maxBuffer:3*1024*1024});log('File range ready; forwarding.');await request('/api/bridge/jobs/'+job.id,{method:'PUT',body:result.stdout,headers:{'Content-Type':'application/octet-stream'}});}
    catch(e){log('Media request failed: '+(['SOURCE_CHANGED','SOURCE_UNAVAILABLE','NOT_LOCAL'].includes(e.message)?e.message:'REQUEST_FAILED'));const error=['SOURCE_CHANGED','SOURCE_UNAVAILABLE','NOT_LOCAL'].includes(e.message)?e.message:'SOURCE_UNAVAILABLE';await request('/api/bridge/jobs/'+job.id,{method:'PUT',headers:{'X-Reels-Source-Error':error}}).catch(()=>{});}
   }));
  }catch{await reportStatus(false).catch(()=>{});if(Date.now()>nextFailureLog){log('Connection unavailable; metadata retained. Retrying.');nextFailureLog=Date.now()+60000;}}
  await new Promise(r=>setTimeout(r,1000));
 }
}finally{await client.close();await transport.close();}
