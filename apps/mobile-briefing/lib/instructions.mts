// Mobile Sites instructions: anyone the Site lets in may create/cancel/list (user decision 2026-11-21);
// only the bridge key can claim or report status.
// Pure validators are exported for tests. Nothing here logs instruction text or owner ids.
import {validPaseoTarget} from './paseo-request.mjs';

export type InstructionEnv={
 DB?:D1Database;BRIDGE_SECRET?:string;
 INSTRUCTIONS_ENABLED?:string;
 INSTRUCTIONS_MAX_ACTIVE?:string;INSTRUCTIONS_TTL_HOURS?:string;INSTRUCTIONS_CLAIM_TIMEOUT_MINUTES?:string;INSTRUCTIONS_RATE_PER_MINUTE?:string;INSTRUCTIONS_RATE_PER_DAY?:string;INSTRUCTIONS_QUEUE_MAX?:string;
};
export const STATUSES=['queued','claimed','running','needs_user','done','failed','cancelled','expired'] as const;
export type InstructionStatus=typeof STATUSES[number];
export const END_LEVELS=['draft','review_applied','pre_publish','pre_merge'] as const;
export const ERROR_CODES=['LAUNCH_FAILED','RESULT_MISSING','RESULT_INVALID','TIMEOUT','BRIDGE_DISABLED','AGENT_FAILED','CLAIM_LOST'] as const;
// CLAIM_LOST is written only by the server (a claim never followed by running); the bridge cannot report it.
export const BRIDGE_ERROR_CODES=ERROR_CODES.filter(c=>c!=='CLAIM_LOST');
export const READY_REASONS=['disabled','launcher_down','locked','busy'] as const;
// Final values (decisions D14–D21); each limit can still be tuned with the env named beside it.
export const LIMITS={
 textChars:4000,textBytes:16*1024,bodyBytes:24*1024,
 ttlHours:24,maxActive:1,claimTimeoutMinutes:10,perMinute:3,perDay:20,queueMax:5,
 listSize:30,delayAfterMinutes:60,onlineMs:45_000,
 sessionNameChars:120,summaryChars:2000,summaryLines:10,questionChars:500,
} as const;
// Bridge-side transitions only. Owner cancel (queued→cancelled) and server expiry (queued→expired) are separate paths.
export const BRIDGE_TRANSITIONS:Record<string,readonly InstructionStatus[]>={claimed:['running','failed'],running:['needs_user','done','failed']};
export const MASKED_LINE='(경로·민감 문자열이 있어 가렸어요. 실행 세션에서 확인하세요)';
export const MASKED_QUESTION='(질문에 경로·민감 문자열이 있어 가렸어요. 실행 세션에서 확인하세요)';
const ITEM_COLUMNS='id,text,target,end_level,status,created_at,updated_at,claimed_at,started_at,finished_at,expires_at,session_name,summary,question,error_code';
const EVENT_ID='lower(hex(randomblob(16)))';

const int=(v:string|undefined,fallback:number,min:number,max:number)=>{const n=Number(v);return v!==undefined&&v!==''&&Number.isInteger(n)&&n>=min&&n<=max?n:fallback;};
export function config(env:InstructionEnv){
 return {
  enabled:env.INSTRUCTIONS_ENABLED==='true',
  maxActive:int(env.INSTRUCTIONS_MAX_ACTIVE,LIMITS.maxActive,1,2),
  ttlHours:int(env.INSTRUCTIONS_TTL_HOURS,LIMITS.ttlHours,1,72),
  claimTimeoutMinutes:int(env.INSTRUCTIONS_CLAIM_TIMEOUT_MINUTES,LIMITS.claimTimeoutMinutes,1,240),
  perMinute:int(env.INSTRUCTIONS_RATE_PER_MINUTE,LIMITS.perMinute,1,30),
  perDay:int(env.INSTRUCTIONS_RATE_PER_DAY,LIMITS.perDay,1,200),
  queueMax:int(env.INSTRUCTIONS_QUEUE_MAX,LIMITS.queueMax,1,50),
 };
}

// ---- identity -------------------------------------------------------------
const json=(v:unknown,status=200)=>Response.json(v,{status,headers:{'Cache-Control':'no-store'}});
export function service(req:Request,env:InstructionEnv){const secret=env.BRIDGE_SECRET;return !!secret&&req.headers.get('x-reels-bridge-key')===secret;}
export type Owner={ok:true;id:string}|{ok:false;status:401;error:'UNAUTHORIZED'};
/** Site access is the permission (user decision 2026-11-21): any request the Sites front door signed in
 *  (oai-authenticated-user-id present) may instruct. The id is kept only for per-person rate limits and
 *  idempotency; it is never returned. Who can reach the Site is governed by the Site's access policy. */
export function owner(req:Request,_env:InstructionEnv):Owner{
 const id=req.headers.get('oai-authenticated-user-id');
 return id?{ok:true,id}:{ok:false,status:401,error:'UNAUTHORIZED'};
}
/** Browser reads of the briefing/media: the bridge key or a signed-in Sites user (unchanged behaviour). */
export function readable(req:Request,env:InstructionEnv){
 return service(req,env)||!!req.headers.get('oai-authenticated-user-id');
}
/** GET /api/whoami: booleans only, never an id. */
export function whoami(req:Request,_env:InstructionEnv){
 const id=req.headers.get('oai-authenticated-user-id');
 return json({header:!!id,canInstruct:!!id});
}
/** Browser write guard: Sec-Fetch-Site must be same-origin when present, Origin must equal the request origin when present, and one of them must be present. */
export function sameOrigin(req:Request){
 const site=req.headers.get('sec-fetch-site'),origin=req.headers.get('origin');
 if(!site&&!origin)return false;
 if(site&&site!=='same-origin')return false;
 if(origin&&origin!==new URL(req.url).origin)return false;
 return true;
}

// ---- validation -----------------------------------------------------------
const CONTROL_EXCEPT_NL_TAB=/[^\P{Cc}\n\t]/u;
const LONE_SURROGATE=/\p{Cs}/u;
const codePoints=(s:string)=>[...s].length;
const bytes=(s:string)=>new TextEncoder().encode(s).byteLength;
export type Check<T>={ok:true;value:T}|{ok:false;status:400|413;error:string};
export function cleanText(v:unknown):Check<string>{
 if(typeof v!=='string')return {ok:false,status:400,error:'TEXT_REQUIRED'};
 const t=v.replace(/\r\n?/g,'\n').trim();
 if(!t)return {ok:false,status:400,error:'TEXT_REQUIRED'};
 if(CONTROL_EXCEPT_NL_TAB.test(t)||LONE_SURROGATE.test(t))return {ok:false,status:400,error:'TEXT_INVALID'};
 if(codePoints(t)>LIMITS.textChars||bytes(t)>LIMITS.textBytes)return {ok:false,status:413,error:'TEXT_TOO_LONG'};
 return {ok:true,value:t};
}
export const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Local paths, file URIs, Windows/UNC paths and well-known credential shapes. Heuristic: the bridge filters first; this is the last boundary.
const PATHLIKE=/(^|[^A-Za-z0-9.])(~\/|\/(Users|home|private|var|tmp|etc|opt|Volumes|Library|System|root|usr|Applications)(\/|\b))|file:\/\/|(^|[^A-Za-z])[A-Za-z]:\\|\\\\[A-Za-z0-9]/;
const SECRETLIKE=/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|github_pat_|\bxox[abprs]-|\bAKIA[0-9A-Z]{16}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|-----BEGIN|[A-Za-z0-9+/_=-]{40,}/;
const HIDDEN=/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u;
export const unsafeLine=(line:string)=>HIDDEN.test(line)||PATHLIKE.test(line)||SECRETLIKE.test(line);
/** Summary from the bridge: ≤2000 code points, ≤10 lines; suspicious lines are replaced, never passed through. */
export function cleanSummary(v:unknown):Check<string|null>{
 if(v===undefined||v===null)return {ok:true,value:null};
 if(typeof v!=='string')return {ok:false,status:400,error:'SUMMARY_INVALID'};
 const t=v.replace(/\r\n?/g,'\n').trim();if(!t)return {ok:true,value:null};
 if(codePoints(t)>LIMITS.summaryChars)return {ok:false,status:400,error:'SUMMARY_TOO_LONG'};
 const lines=t.split('\n');if(lines.length>LIMITS.summaryLines)return {ok:false,status:400,error:'SUMMARY_TOO_LONG'};
 return {ok:true,value:lines.map(l=>unsafeLine(l)?MASKED_LINE:l).join('\n')};
}
export function cleanQuestion(v:unknown):Check<string|null>{
 if(v===undefined||v===null)return {ok:true,value:null};
 if(typeof v!=='string')return {ok:false,status:400,error:'QUESTION_INVALID'};
 const t=v.replace(/\r\n?/g,'\n').trim();if(!t)return {ok:true,value:null};
 if(codePoints(t)>LIMITS.questionChars)return {ok:false,status:400,error:'QUESTION_TOO_LONG'};
 return {ok:true,value:t.split('\n').some(unsafeLine)?MASKED_QUESTION:t};
}
const SESSION_NAME=/^[\p{L}\p{N}][\p{L}\p{N} ._:#()[\]-]*$/u;
/** Session names are shown so the owner can find the run in Paseo/Herdr. Paths and token shapes are rejected. */
export function cleanSessionName(v:unknown):Check<string|null>{
 if(v===undefined||v===null)return {ok:true,value:null};
 if(typeof v!=='string'||!v||codePoints(v)>LIMITS.sessionNameChars||!SESSION_NAME.test(v)||unsafeLine(v))return {ok:false,status:400,error:'SESSION_NAME_INVALID'};
 return {ok:true,value:v};
}
async function readBody(req:Request,limit:number):Promise<{ok:true;value:unknown}|{ok:false;status:400|413|415;error:string}>{
 if(!/^application\/json(\s*;|$)/i.test(req.headers.get('content-type')??''))return {ok:false,status:415,error:'JSON_REQUIRED'};
 const declared=Number(req.headers.get('content-length')||0);if(declared>limit)return {ok:false,status:413,error:'BODY_TOO_LARGE'};
 const chunks:Uint8Array[]=[];let size=0;
 if(req.body){const reader=req.body.getReader();for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel().catch(()=>{});return {ok:false,status:413,error:'BODY_TOO_LARGE'};}chunks.push(value);}}
 const all=new Uint8Array(size);let at=0;for(const c of chunks){all.set(c,at);at+=c.byteLength;}
 try{return {ok:true,value:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all))};}catch{return {ok:false,status:400,error:'INVALID_JSON'};}
}
const isObject=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const onlyKeys=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).every(k=>keys.includes(k));

// ---- database helpers -----------------------------------------------------
const iso=(ms:number)=>new Date(ms).toISOString();
// Housekeeping run in the same batch as every read/create/cancel/claim:
//  - queued rows past expires_at → expired;
//  - claimed rows that never became running within the claim timeout → failed CLAIM_LOST (e.g. the claim
//    response was lost and the bridge has no record). Never re-queued: an instruction runs at most once.
// Both statement pairs write one server event per changed row. HOUSEKEEPING is their count.
const HOUSEKEEPING=4;
function expireStatements(db:D1Database,at:string,claimTimeoutMinutes:number){
 const lost=iso(Date.parse(at)-claimTimeoutMinutes*60_000);
 return [
  db.prepare("INSERT INTO instruction_events(id,instruction_id,at,actor,from_status,to_status,note) SELECT "+EVENT_ID+",id,?,'server','claimed','failed','CLAIM_LOST' FROM instructions WHERE status='claimed' AND claimed_at<=?").bind(at,lost),
  db.prepare("UPDATE instructions SET status='failed',error_code='CLAIM_LOST',updated_at=?,finished_at=? WHERE status='claimed' AND claimed_at<=?").bind(at,at,lost),
  db.prepare("INSERT INTO instruction_events(id,instruction_id,at,actor,from_status,to_status,note) SELECT "+EVENT_ID+",id,?,'server','queued','expired','EXPIRED' FROM instructions WHERE status='queued' AND expires_at<=?").bind(at,at),
  db.prepare("UPDATE instructions SET status='expired',updated_at=?,finished_at=? WHERE status='queued' AND expires_at<=?").bind(at,at,at),
 ];
}
async function expire(db:D1Database,at:string,claimTimeoutMinutes:number){await db.batch(expireStatements(db,at,claimTimeoutMinutes));}
async function knownTarget(db:D1Database,target:string){
 const src=await db.prepare('SELECT latest_run_id FROM sources WHERE id=?').bind('primary-mac').first<{latest_run_id:string|null}>();
 if(!src?.latest_run_id)return false;
 const run=await db.prepare('SELECT monitor FROM sync_runs WHERE id=?').bind(src.latest_run_id).first<{monitor:string|null}>();
 let today:unknown=null;try{today=run?.monitor?JSON.parse(run.monitor)?.autopilot?.today?.target:null;}catch{today=null;}
 if(today===target)return true;
 if(!target.startsWith('project:'))return false;
 return !!await db.prepare('SELECT 1 AS ok FROM contents WHERE run_id=? AND id=?').bind(src.latest_run_id,target.slice(8)).first();
}
async function macState(db:D1Database){
 const src=await db.prepare('SELECT heartbeat_at,instructions_ready,instructions_reason,instructions_at FROM sources WHERE id=?').bind('primary-mac').first<{heartbeat_at:string;instructions_ready:number|null;instructions_reason:string|null;instructions_at:string|null}>();
 const fresh=(at:string|null|undefined)=>!!at&&Date.now()-Date.parse(at)<LIMITS.onlineMs;
 const online=fresh(src?.heartbeat_at);
 const ready=online&&fresh(src?.instructions_at)&&src?.instructions_ready!=null?{ready:src.instructions_ready===1,reason:src.instructions_ready===1?null:src.instructions_reason}:null;
 return {online,ready};
}

// ---- site user API (shared queue) --------------------------------------------
export async function handleInstructions(req:Request,env:InstructionEnv,db:D1Database,path:string):Promise<Response|null>{
 const cancel=/^\/api\/instructions\/([0-9a-f-]{36})\/cancel$/.exec(path);
 if(path!=='/api/instructions'&&!cancel)return null;
 const who=owner(req,env);if(!who.ok)return json({error:who.error},who.status);
 const cfg=config(env),at=iso(Date.now());
 if(path==='/api/instructions'&&req.method==='GET'){
  await expire(db,at,cfg.claimTimeoutMinutes);
  const [items,mac]=await Promise.all([db.prepare('SELECT '+ITEM_COLUMNS+' FROM instructions ORDER BY created_at DESC,id LIMIT ?').bind(LIMITS.listSize).all(),macState(db)]);
  return json({enabled:cfg.enabled,macOnline:mac.online,macReady:mac.ready,maxActive:cfg.maxActive,delayAfterMinutes:LIMITS.delayAfterMinutes,maxChars:LIMITS.textChars,items:items.results});
 }
 if(req.method!=='POST')return json({error:'METHOD_NOT_ALLOWED'},405);
 if(!sameOrigin(req))return json({error:'CROSS_SITE'},403);
 const body=await readBody(req,LIMITS.bodyBytes);if(!body.ok)return json({error:body.error},body.status);
 if(cancel){
  if(!isObject(body.value)||Object.keys(body.value).length)return json({error:'INVALID_REQUEST'},400);
  const id=cancel[1].toLowerCase();
  const row=await db.prepare('SELECT status FROM instructions WHERE id=?').bind(id).first<{status:string}>();
  if(!row)return json({error:'NOT_FOUND'},404);
  const results=await db.batch([
   ...expireStatements(db,at,cfg.claimTimeoutMinutes),
   db.prepare("INSERT INTO instruction_events(id,instruction_id,at,actor,from_status,to_status,note) SELECT "+EVENT_ID+",id,?,'owner','queued','cancelled','CANCELLED' FROM instructions WHERE id=? AND status='queued'").bind(at,id),
   db.prepare("UPDATE instructions SET status='cancelled',updated_at=?,finished_at=? WHERE id=? AND status='queued' RETURNING "+ITEM_COLUMNS).bind(at,at,id),
  ]);
  const item=results[HOUSEKEEPING+1].results[0];
  if(!item){const now=await db.prepare('SELECT status FROM instructions WHERE id=?').bind(id).first<{status:string}>();return json({error:'NOT_CANCELLABLE',status:now?.status??null},409);}
  return json({item});
 }
 // create
 if(!cfg.enabled)return json({error:'DISABLED'},403);
 const v=body.value;
 if(!isObject(v)||!onlyKeys(v,['text','target','endLevel','idempotencyKey']))return json({error:'INVALID_REQUEST'},400);
 if(typeof v.idempotencyKey!=='string'||!UUID.test(v.idempotencyKey))return json({error:'IDEMPOTENCY_KEY_REQUIRED'},400);
 const key=v.idempotencyKey.toLowerCase();
 const text=cleanText(v.text);if(!text.ok)return json({error:text.error},text.status);
 let target:string|null=null;
 if(v.target!==undefined&&v.target!==null&&v.target!==''){
  const t=validPaseoTarget(v.target);if(!t)return json({error:'TARGET_INVALID'},400);target=t;
 }
 if(v.endLevel!==undefined&&v.endLevel!==null&&!(END_LEVELS as readonly unknown[]).includes(v.endLevel))return json({error:'END_LEVEL_INVALID'},400);
 const endLevel=(v.endLevel as string|null|undefined)??null;
 // Idempotency before limits: a resend never consumes quota and never creates a second row,
 // even after the first one expired or was cancelled.
 const existing=async()=>{
  const row=await db.prepare('SELECT '+ITEM_COLUMNS+' FROM instructions WHERE owner_id=? AND idempotency_key=?').bind(who.id,key).first<Record<string,unknown>>();
  if(!row)return null;
  return row.text===text.value&&row.target===target&&row.end_level===endLevel?json({item:row,duplicate:true}):json({error:'IDEMPOTENCY_CONFLICT'},409);
 };
 const prior=await existing();if(prior)return prior;
 if(target&&!await knownTarget(db,target))return json({error:'TARGET_UNKNOWN'},400);
 const nowMs=Date.parse(at),id=crypto.randomUUID(),expires=iso(nowMs+cfg.ttlHours*3600_000),minute=iso(nowMs-60_000),day=iso(nowMs-86_400_000);
 // Limit checks and the insert are one statement; the event row is written in the same transaction.
 const results=await db.batch([
  ...expireStatements(db,at,cfg.claimTimeoutMinutes),
  db.prepare("INSERT INTO instructions(id,owner_id,idempotency_key,text,target,end_level,status,created_at,updated_at,expires_at) SELECT ?,?,?,?,?,?,'queued',?,?,? WHERE (SELECT count(*) FROM instructions WHERE owner_id=? AND created_at>?)<? AND (SELECT count(*) FROM instructions WHERE owner_id=? AND created_at>?)<? AND (SELECT count(*) FROM instructions WHERE status='queued' AND expires_at>?)<? ON CONFLICT(owner_id,idempotency_key) DO NOTHING")
   .bind(id,who.id,key,text.value,target,endLevel,at,at,expires,who.id,minute,cfg.perMinute,who.id,day,cfg.perDay,at,cfg.queueMax),
  db.prepare("INSERT INTO instruction_events(id,instruction_id,at,actor,from_status,to_status,note) SELECT "+EVENT_ID+",id,?,'owner',NULL,'queued','CREATED' FROM instructions WHERE id=?").bind(at,id),
 ]);
 if(results[HOUSEKEEPING].meta.changes===1){
  const item=await db.prepare('SELECT '+ITEM_COLUMNS+' FROM instructions WHERE id=?').bind(id).first();
  return json({item},201);
 }
 const raced=await existing();if(raced)return raced;
 const count=async(sql:string,...args:unknown[])=>(await db.prepare(sql).bind(...args).first<{n:number}>())?.n??0;
 if(await count('SELECT count(*) AS n FROM instructions WHERE owner_id=? AND created_at>?',who.id,minute)>=cfg.perMinute)return json({error:'RATE_LIMITED',window:'minute'},429);
 if(await count('SELECT count(*) AS n FROM instructions WHERE owner_id=? AND created_at>?',who.id,day)>=cfg.perDay)return json({error:'RATE_LIMITED',window:'day'},429);
 return json({error:'QUEUE_FULL'},429);
}

// ---- bridge API (service key only; the caller has already checked it) --------
export async function handleBridgeInstructions(req:Request,env:InstructionEnv,db:D1Database,path:string):Promise<Response|null>{
 const status=/^\/api\/bridge\/instructions\/([0-9a-f-]{36})\/status$/.exec(path);
 if(path!=='/api/bridge/instructions/claim'&&!status)return null;
 if(req.method!=='POST')return json({error:'METHOD_NOT_ALLOWED'},405);
 const body=await readBody(req,8*1024);if(!body.ok)return json({error:body.error},body.status);
 const v=body.value,cfg=config(env),at=iso(Date.now());
 if(!status){
  if(!isObject(v)||!onlyKeys(v,['capacity'])||!Number.isInteger(v.capacity)||(v.capacity as number)<0||(v.capacity as number)>2)return json({error:'INVALID_REQUEST'},400);
  if(!cfg.enabled)return json({items:[],enabled:false});
  const slots=Math.min(v.capacity as number,cfg.maxActive);
  const pick="(SELECT id FROM instructions WHERE status='queued' AND expires_at>? ORDER BY created_at,id LIMIT 1)";
  const room="(SELECT count(*) FROM instructions WHERE status IN ('claimed','running'))<?";
  // Expiry, the active-count check, picking the oldest queued row, the conditional transition and the
  // audit row all run in one D1 batch (one transaction), so two concurrent claims cannot take the same row.
  const statements=[...expireStatements(db,at,cfg.claimTimeoutMinutes)];
  for(let i=0;i<slots;i++){
   statements.push(db.prepare("INSERT INTO instruction_events(id,instruction_id,at,actor,from_status,to_status,note) SELECT "+EVENT_ID+",id,?,'bridge','queued','claimed','CLAIMED' FROM instructions WHERE id="+pick+" AND status='queued' AND "+room).bind(at,at,cfg.maxActive));
   statements.push(db.prepare("UPDATE instructions SET status='claimed',claimed_at=?,updated_at=? WHERE id="+pick+" AND status='queued' AND "+room+" RETURNING id,text,target,end_level,created_at").bind(at,at,at,cfg.maxActive));
  }
  const results=await db.batch(statements);
  const items=results.slice(HOUSEKEEPING).filter((_,i)=>i%2===1).flatMap(r=>r.results);
  return json({items,enabled:true});
 }
 const id=status[1].toLowerCase();
 if(!isObject(v)||!onlyKeys(v,['status','sessionName','summary','question','errorCode']))return json({error:'INVALID_REQUEST'},400);
 const next=v.status as InstructionStatus;
 if(!['running','needs_user','done','failed'].includes(next as string))return json({error:'STATUS_INVALID'},400);
 const session=cleanSessionName(v.sessionName);if(!session.ok)return json({error:session.error},400);
 const summary=cleanSummary(v.summary);if(!summary.ok)return json({error:summary.error},400);
 const question=cleanQuestion(v.question);if(!question.ok)return json({error:question.error},400);
 if(question.value&&next!=='needs_user')return json({error:'QUESTION_NOT_ALLOWED'},400);
 if(next==='needs_user'&&!question.value)return json({error:'QUESTION_REQUIRED'},400);
 if(next==='running'&&!session.value)return json({error:'SESSION_NAME_REQUIRED'},400);
 let errorCode:string|null=null;
 if(v.errorCode!==undefined&&v.errorCode!==null){if(next!=='failed'||!(BRIDGE_ERROR_CODES as readonly unknown[]).includes(v.errorCode))return json({error:'ERROR_CODE_INVALID'},400);errorCode=v.errorCode as string;}
 if(next==='failed')errorCode??='AGENT_FAILED';
 const current=()=>db.prepare('SELECT '+ITEM_COLUMNS+' FROM instructions WHERE id=?').bind(id).first<Record<string,unknown>&{status:string;error_code:string|null}>();
 // Same status again (a retried upload) is an idempotent success: the current item is returned and nothing is
 // written (no event, timestamps and fields unchanged). Any other refusal carries only the current status and
 // error code, so the bridge can tell "already there" from e.g. failed CLAIM_LOST; never owner or text.
 const settle=(row:Awaited<ReturnType<typeof current>>)=>!row?json({error:'NOT_FOUND'},404):row.status===next?json({item:row,unchanged:true}):json({error:'TRANSITION_NOT_ALLOWED',status:row.status,error_code:row.error_code},409);
 const row=await current();
 if(!row||row.status===next||!(BRIDGE_TRANSITIONS[row.status]??[]).includes(next))return settle(row);
 const note=next==='running'?'STARTED':next==='needs_user'?'NEEDS_USER':next==='done'?'DONE':'FAILED:'+errorCode;
 const started=next==='running'?at:null,finished=next==='running'?null:at;
 const results=await db.batch([
  db.prepare("INSERT INTO instruction_events(id,instruction_id,at,actor,from_status,to_status,note) SELECT "+EVENT_ID+",id,?,'bridge',status,?,? FROM instructions WHERE id=? AND status=?").bind(at,next,note,id,row.status),
  db.prepare('UPDATE instructions SET status=?,updated_at=?,started_at=COALESCE(?,started_at),finished_at=COALESCE(?,finished_at),session_name=COALESCE(?,session_name),summary=COALESCE(?,summary),question=COALESCE(?,question),error_code=COALESCE(?,error_code) WHERE id=? AND status=? RETURNING '+ITEM_COLUMNS)
   .bind(next,at,started,finished,session.value,summary.value,question.value,errorCode,id,row.status),
 ]);
 const item=results[1].results[0];
 if(!item)return settle(await current());
 return json({item});
}

/** Optional heartbeat body {instructions:{ready, reason?}}. Returns null when there is no body (legacy heartbeat). */
export async function heartbeatReadiness(req:Request):Promise<{ok:true;value:{ready:boolean;reason:string|null}|null}|{ok:false;status:400|413|415;error:string}>{
 const length=req.headers.get('content-length');
 if(!req.body||length==='0')return {ok:true,value:null};
 if(Number(length)>1024)return {ok:false,status:413,error:'BODY_TOO_LARGE'};
 const raw=await req.text();if(!raw.trim())return {ok:true,value:null};
 if(raw.length>1024)return {ok:false,status:413,error:'BODY_TOO_LARGE'};
 let v:unknown;try{v=JSON.parse(raw);}catch{return {ok:false,status:400,error:'INVALID_HEARTBEAT'};}
 if(!isObject(v)||!onlyKeys(v,['instructions'])||!isObject(v.instructions)||!onlyKeys(v.instructions,['ready','reason']))return {ok:false,status:400,error:'INVALID_HEARTBEAT'};
 const {ready,reason}=v.instructions;
 if(typeof ready!=='boolean')return {ok:false,status:400,error:'INVALID_HEARTBEAT'};
 if(reason!==undefined&&reason!==null&&!(READY_REASONS as readonly unknown[]).includes(reason))return {ok:false,status:400,error:'INVALID_HEARTBEAT'};
 return {ok:true,value:{ready,reason:ready?null:(reason as string|undefined)??null}};
}
