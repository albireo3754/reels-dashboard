import { env } from 'cloudflare:workers';
import { snapshotSchema, rangeFor } from './contracts';
import { acceptPreviewResult, listPreviewJobs, previewMedia, previewStatus, reapExpiredPreviews } from './previews';
import { handleBridgeInstructions, handleInstructions, heartbeatReadiness, readable as readableFor, whoami, service as serviceFor, type InstructionEnv } from './instructions.mjs';
const E=()=>env as Cloudflare.Env & InstructionEnv & {MEDIA_READS_ENABLED?:string;MEDIA_PREVIEWS_ENABLED?:string};
const db=()=>{if(!E().DB)throw new Error('DATABASE_UNAVAILABLE');return E().DB!;};
const previewsEnabled=()=>E().MEDIA_PREVIEWS_ENABLED==='true';
function previewBindings(){
 const bucket=E().BUCKET;
 if(!bucket)throw new Error('RELAY_UNAVAILABLE');
 return {db:db(),bucket};
}
const json=(v:unknown,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
const previewPath=/^\/api\/previews\/([a-f0-9]{64})(\/media)?$/;
export function isPreviewMediaRequest(req:Request){
 return (req.method==='GET'||req.method==='HEAD')&&previewPath.exec(new URL(req.url).pathname)?.[2]==='/media';
}
const service=(req:Request)=>serviceFor(req,E());
// Bridge key or any signed-in Sites user (the Site access policy decides who that is).
const readable=(req:Request)=>readableFor(req,E());
const now=()=>new Date().toISOString();
async function source(){return await db().prepare('SELECT * FROM sources WHERE id=?').bind('primary-mac').first<any>();}
async function batch(statements:D1PreparedStatement[]){for(let i=0;i<statements.length;i+=40)await db().batch(statements.slice(i,i+40));}
async function ingest(req:Request){
 const length=Number(req.headers.get('content-length')||0);if(length>4*1024*1024)return json({error:'SNAPSHOT_TOO_LARGE'},413);
 const raw=await req.text();if(new TextEncoder().encode(raw).byteLength>4*1024*1024)return json({error:'SNAPSHOT_TOO_LARGE'},413);
 const parsed=snapshotSchema.safeParse(JSON.parse(raw));if(!parsed.success)return json({error:'INVALID_SNAPSHOT'},400);const data=parsed.data;
 const ids=new Set(data.contents.map(p=>p.id));if(ids.size!==data.contents.length||new Set(data.assets.map(a=>a.id)).size!==data.assets.length||data.assets.some(a=>!ids.has(a.contentId)))return json({error:'INVALID_REFERENCES'},400);
 const t=now(),runId=crypto.randomUUID();
 await db().prepare('INSERT INTO sources(id,label,heartbeat_at,status) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,heartbeat_at=excluded.heartbeat_at,status=excluded.status').bind(data.sourceId,data.sourceLabel,t,'online').run();
 await db().prepare('INSERT INTO sync_runs(id,source_id,source_revision,created_at,status,content_count,asset_count,monitor) VALUES(?,?,?,?,?,?,?,?)').bind(runId,data.sourceId,data.sourceRevision,t,'importing',data.contents.length,data.assets.length,data.monitor?JSON.stringify(data.monitor):null).run();
 try{
 await batch(data.contents.map(p=>db().prepare('INSERT INTO contents(run_id,id,title,date,date_basis,stage,next_action,public_url,publishing_copy,route_map,route_map_status,progress) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(runId,p.id,p.title,p.date,p.dateBasis,p.stage,p.nextAction,p.publicURL,p.publishingCopy?JSON.stringify(p.publishingCopy):null,p.routeMap?JSON.stringify(p.routeMap):null,p.routeMap?'ready':p.routeMapStatus==='unavailable'?'unavailable':null,JSON.stringify({kind:p.kind,priority:p.priority,state:p.state,publications:p.publications}))));
 await batch(data.assets.map(a=>db().prepare('INSERT INTO assets(run_id,id,content_id,object_key,role,label,file_name,mime_type,bytes,is_directory,available,item_count,etag) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(runId,a.id,a.contentId,a.objectKey,a.role,a.label,a.fileName,a.mimeType,a.bytes,a.isDirectory?1:0,a.available?1:0,a.itemCount,a.etag)));
 await db().batch([
 db().prepare('UPDATE sync_runs SET status=? WHERE id=?').bind('complete',runId),
 db().prepare('UPDATE sources SET latest_run_id=?,source_updated_at=?,heartbeat_at=?,status=? WHERE id=?').bind(runId,data.sourceUpdatedAt,t,'online',data.sourceId)
 ]);
 }catch(error){await db().prepare('UPDATE sync_runs SET status=? WHERE id=?').bind('failed',runId).run();throw error;}
 // Keep two completed snapshots; never delete a concurrent import or the current source pointer.
 const obsolete=await db().prepare("SELECT id FROM sync_runs WHERE source_id=? AND status='complete' ORDER BY created_at DESC LIMIT 100 OFFSET 2").bind(data.sourceId).all<{id:string}>();
 for(const r of obsolete.results){await db().batch([db().prepare('DELETE FROM assets WHERE run_id=?').bind(r.id),db().prepare('DELETE FROM contents WHERE run_id=?').bind(r.id),db().prepare('DELETE FROM sync_runs WHERE id=? AND id NOT IN (SELECT latest_run_id FROM sources WHERE latest_run_id IS NOT NULL)').bind(r.id)]);}
 return json({runId,contents:data.contents.length,assets:data.assets.length,syncedAt:t});
}
async function chunk(object:any,start:number,end:number){
 const bucket=E().BUCKET;if(!bucket)throw new Error('RELAY_UNAVAILABLE');
 const id=crypto.randomUUID();const expires=new Date(Date.now()+30000).toISOString();
 await db().prepare('INSERT INTO media_requests(id,object_key,etag,range_start,range_end,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').bind(id,object.object_key,object.etag,start,end,'pending',now(),expires).run();
 for(let attempt=0;attempt<70;attempt++){
  await new Promise(r=>setTimeout(r,250));
  const result=await db().prepare('SELECT status,error FROM media_requests WHERE id=?').bind(id).first<any>();
  if(result?.status==='error')throw new Error(result.error||'SOURCE_UNAVAILABLE');
  if(result?.status==='complete'){
   const file=await bucket.get('relay/'+id);if(!file)throw new Error('RELAY_EXPIRED');
   const bytes=await file.arrayBuffer();await bucket.delete('relay/'+id);await db().prepare('DELETE FROM media_requests WHERE id=?').bind(id).run();return new Uint8Array(bytes);
  }
 }
 await db().prepare('UPDATE media_requests SET status=? WHERE id=?').bind('expired',id).run();throw new Error('LOCAL_OFFLINE');
}
async function media(req:Request,id:string){
 if(E().MEDIA_READS_ENABLED!=="true")return json({error:"MEDIA_NOT_ENABLED",message:"원본 파일 열기는 준비 중이에요."},503);
 const src=await source();const object=src?.latest_run_id?await db().prepare('SELECT * FROM assets WHERE run_id=? AND id=?').bind(src.latest_run_id,id).first<any>():null;
 if(!object)return json({error:'NOT_FOUND'},404);
 if(object.is_directory)return json({error:'DIRECTORY',itemCount:object.item_count},400);
 if(!object.available)return json({error:'SOURCE_UNAVAILABLE'},404);
 let range;try{range=rangeFor(req.headers.get('range'),object.bytes);}catch{return new Response(null,{status:416,headers:{'Content-Range':`bytes */${object.bytes}`}});}
 const type=/^(image\/(png|jpeg|webp|heic)|video\/(mp4|quicktime)|audio\/)/.test(object.mime_type)?object.mime_type:'application/octet-stream';
 const headers=new Headers({'Content-Type':type,'Content-Length':String(range.end-range.start+1),'Accept-Ranges':'bytes','Cache-Control':'private, no-store','ETag':object.etag,'X-Content-Type-Options':'nosniff','Content-Disposition':`${type==='application/octet-stream'?'attachment':'inline'}; filename*=UTF-8''${encodeURIComponent(object.file_name)}`});
 if(range.partial)headers.set('Content-Range',`bytes ${range.start}-${range.end}/${object.bytes}`);
 if(req.method==='HEAD')return new Response(null,{headers,status:range.partial?206:200});
 if(Date.now()-Date.parse(src.heartbeat_at)>45000)return json({error:'LOCAL_OFFLINE',message:'로컬 서버가 연결되면 파일을 열 수 있어요.'},503);
 if(object.bytes===0)return new Response(null,{headers});
 try{
  let position=range.start;
  const first=await chunk(object,position,Math.min(range.end,position+2*1024*1024-1));position+=first.byteLength;
  const stream=new ReadableStream({start(controller){controller.enqueue(first);},async pull(controller){if(position>range.end){controller.close();return;}try{const bytes=await chunk(object,position,Math.min(range.end,position+2*1024*1024-1));position+=bytes.byteLength;controller.enqueue(bytes);}catch(e){controller.error(e);}},cancel(){position=range.end+1;}});
  return new Response(stream,{headers,status:range.partial?206:200});
 }catch{return json({error:'LOCAL_OFFLINE',message:'파일을 읽지 못했어요. Mac과 iCloud 연결을 확인해주세요.'},503);}
}
export async function handleApi(req:Request){
 try{
 const url=new URL(req.url),p=url.pathname;
 if(p.startsWith('/api/bridge/')){
  if(!service(req))return json({error:'UNAUTHORIZED'},401);
  if(p==='/api/bridge/snapshot'&&req.method==='PUT')return ingest(req);
  if(p==='/api/bridge/heartbeat'&&req.method==='POST'){
   const readiness=await heartbeatReadiness(req);if(!readiness.ok)return json({error:readiness.error},readiness.status);
   const t=now();
   if(readiness.value)await db().prepare('UPDATE sources SET heartbeat_at=?,status=?,instructions_ready=?,instructions_reason=?,instructions_at=? WHERE id=?').bind(t,'online',readiness.value.ready?1:0,readiness.value.reason,t,'primary-mac').run();
   else await db().prepare('UPDATE sources SET heartbeat_at=?,status=? WHERE id=?').bind(t,'online','primary-mac').run();
   if(E().BUCKET)await reapExpiredPreviews(previewBindings()).catch(()=>console.error('preview-expiry-cleanup-failed'));
   const src=await source();
   const run=src?.latest_run_id?await db().prepare('SELECT source_revision FROM sync_runs WHERE id=?').bind(src.latest_run_id).first<{source_revision:string}>():null;
   return json({ok:true,mediaEnabled:E().MEDIA_READS_ENABLED==="true",previewsEnabled:previewsEnabled(),instructionsEnabled:E().INSTRUCTIONS_ENABLED==="true",sourceRevision:run?.source_revision??null});
  }
  if(p==='/api/bridge/preview-jobs'&&req.method==='GET')return await listPreviewJobs(previewBindings(),previewsEnabled());
  const previewJob=/^\/api\/bridge\/preview-jobs\/([a-f0-9-]{36})$/.exec(p);
  if(previewJob&&req.method==='PUT'){
   if(!previewsEnabled())return json({error:'PREVIEWS_NOT_ENABLED'},503);
   return await acceptPreviewResult(req,previewJob[1],previewBindings());
  }
  if(p==='/api/bridge/jobs'&&req.method==='GET'){
   const expired=await db().prepare('SELECT id FROM media_requests WHERE expires_at<? LIMIT 100').bind(now()).all<{id:string}>();
   for(const x of expired.results){await E().BUCKET?.delete('relay/'+x.id);await db().prepare('DELETE FROM media_requests WHERE id=?').bind(x.id).run();}
   const jobs=await db().prepare("SELECT * FROM media_requests WHERE status='pending' AND expires_at>? ORDER BY created_at LIMIT 4").bind(now()).all();return json({jobs:jobs.results});
  }
  const instructions=await handleBridgeInstructions(req,E(),db(),p);if(instructions)return instructions;
  const match=/^\/api\/bridge\/jobs\/([a-f0-9-]{36})$/.exec(p);
  if(match&&req.method==='PUT'){
   const job=await db().prepare('SELECT * FROM media_requests WHERE id=? AND expires_at>?').bind(match[1],now()).first<any>();
   if(!job||job.status!=='pending')return json({error:'EXPIRED'},409);
   const error=req.headers.get('x-reels-source-error');
   if(error){await db().prepare('UPDATE media_requests SET status=?,error=? WHERE id=?').bind('error',['SOURCE_CHANGED','SOURCE_UNAVAILABLE','NOT_LOCAL'].includes(error)?error:'SOURCE_UNAVAILABLE',job.id).run();return json({ok:true});}
   const bytes=await req.arrayBuffer();if(bytes.byteLength!==job.range_end-job.range_start+1||bytes.byteLength>2*1024*1024)return json({error:'INVALID_CHUNK'},400);
   await E().BUCKET!.put('relay/'+job.id,bytes);await db().prepare('UPDATE media_requests SET status=? WHERE id=?').bind('complete',job.id).run();return json({ok:true});
  }
  return json({error:'NOT_FOUND'},404);
 }
 // Booleans only, never an id.
 if(p==='/api/whoami'&&req.method==='GET')return whoami(req,E());
 if(p==='/api/instructions'||p.startsWith('/api/instructions/')){const r=await handleInstructions(req,E(),db(),p);if(r)return r;}
 if(!readable(req))return json({error:'UNAUTHORIZED'},401);
 if(p==='/api/briefing'&&req.method==='GET'){
  const src=await source();if(!src?.latest_run_id)return json({source:null,contents:[],assets:[],syncedAt:null,online:false,mediaEnabled:false,previewsEnabled:previewsEnabled()});
  const [c,a,run]=await Promise.all([db().prepare('SELECT * FROM contents WHERE run_id=? ORDER BY date DESC,title').bind(src.latest_run_id).all(),db().prepare('SELECT id,content_id,role,label,file_name,mime_type,bytes,is_directory,available,item_count FROM assets WHERE run_id=?').bind(src.latest_run_id).all(),db().prepare('SELECT created_at,monitor FROM sync_runs WHERE id=?').bind(src.latest_run_id).first<any>()]);
  return json({mediaEnabled:E().MEDIA_READS_ENABLED==="true",previewsEnabled:previewsEnabled(),source:{label:src.label,lastSeen:src.heartbeat_at,sourceUpdatedAt:src.source_updated_at},online:Date.now()-Date.parse(src.heartbeat_at)<45000,syncedAt:run?.created_at,monitor:run?.monitor?JSON.parse(run.monitor):null,contents:c.results.map((row:any)=>({...row,...(row.progress?JSON.parse(row.progress):{}),progress:undefined,publishing_copy:row.publishing_copy?JSON.parse(row.publishing_copy):null,route_map:row.route_map?JSON.parse(row.route_map):null})),assets:a.results});
 }
 const preview=previewPath.exec(p);
 if(preview&&(preview[2]?['GET','HEAD']:['GET','POST']).includes(req.method)){
  if(!previewsEnabled())return json({error:'PREVIEWS_NOT_ENABLED'},503);
  const bindings=previewBindings();
  return await (preview[2]?previewMedia(req,url,preview[1],bindings):previewStatus(req,preview[1],bindings));
 }
 const match=/^\/api\/media\/([a-f0-9]{64})$/.exec(p);if(match&&['GET','HEAD'].includes(req.method))return media(req,match[1]);
 return json({error:'NOT_FOUND'},404);
 }catch(error){console.error('briefing-api',error instanceof Error?error.name:'Error');return json({error:'REQUEST_FAILED'},500);}
}
