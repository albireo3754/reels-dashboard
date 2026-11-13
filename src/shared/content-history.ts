import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, link, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';

export const contentHash = (text:string|Uint8Array) => createHash('sha256').update(text).digest('hex');
export const contentHistoryDir = (file:string) => path.join(path.dirname(file), '.history', path.basename(file), 'content-evals');
export type HistoryActor = 'user'|'agent'|'unknown';
/** Publish complete records exclusively: readers never see a half-written JSON object. */
export async function immutableJson(file:string, value:unknown) {
  await mkdir(path.dirname(file), {recursive:true});
  const temp=file+'.'+randomUUID()+'.tmp';
  try {
    await writeFile(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
    try { await link(temp,file); return true; }
    catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')return false;throw e;}
  } finally {await unlink(temp).catch(()=>{});}
}
export async function snapshot(file:string,text:string){
  const revision=contentHash(text);
  await immutableJson(path.join(contentHistoryDir(file),'revisions',revision+'.json'),{version:1,revision,text});
  return revision;
}
/** Exact replacement span: includes wording, markup, order, and media references, with no inferred intent. */
export function contentDiff(before:string,after:string){
  let start=0,end=0;
  while(start<Math.min(before.length,after.length)&&before[start]===after[start])start++;
  while(end<Math.min(before.length,after.length)-start&&before[before.length-1-end]===after[after.length-1-end])end++;
  return {start,removed:before.slice(start,before.length-end),inserted:after.slice(start,after.length-end)};
}
export async function recordContentEvent(file:string,key:string,payload:Record<string,unknown>){
  return immutableJson(path.join(contentHistoryDir(file),'events',contentHash(key)+'.json'),{
    ...payload,version:1,id:contentHash(key),articleId:contentHash(path.resolve(file)),sourceFile:path.resolve(file),observedAt:new Date().toISOString(),labelStatus:'unconfirmed',
  });
}
export async function prepareRevision(file:string,before:string,after:string,actor:HistoryActor,context:Record<string,unknown>={}){
  const from=await snapshot(file,before),to=await snapshot(file,after);
  if(from===to)return undefined;
  const id=randomUUID();
  await immutableJson(path.join(contentHistoryDir(file),'transactions',id+'.json'),{
    version:1,id,before:from,after:to,actor,actorEvidence:'save caller declaration; not identity verification',source:'markup-store',createdAt:new Date().toISOString(),diff:contentDiff(before,after),context,
  });
  return id;
}
export async function finishRevision(file:string,id:string|undefined,status:'committed'|'recovered'|'not-observed'|'overwritten'){
  if(id)await immutableJson(path.join(contentHistoryDir(file),'receipts',id+'.json'),{id,status,observedAt:new Date().toISOString()});
}
/** Called with the manuscript write lock. A pending attempt is never silently promoted to a successful save. */
export async function recoverRevisions(file:string,current:string){
  const dir=contentHistoryDir(file);
  const names=await readdir(path.join(dir,'transactions')).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  const receipts=new Set(await readdir(path.join(dir,'receipts')).catch(e=>{if(e.code==='ENOENT')return [];throw e;}));
  for(const name of names.filter(n=>n.endsWith('.json')&&!receipts.has(n))){
    const tx=JSON.parse(await readFile(path.join(dir,'transactions',name),'utf8'));
    await finishRevision(file,tx.id,tx.after===contentHash(current)?'recovered':'not-observed');
  }
}
