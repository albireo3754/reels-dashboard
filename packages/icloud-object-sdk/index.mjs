import {createHash} from 'node:crypto';
import {stat,realpath,open,readdir,readFile} from 'node:fs/promises';
import {parsePublishingCopy} from './publishing-copy.mjs';
import {parseRouteMap,ROUTE_MAP_FILENAME,ROUTE_MAP_MAX_BYTES} from './route-map.mjs';
import {constants} from 'node:fs';
import path from 'node:path';
export const hash=v=>createHash('sha256').update(v).digest('hex');
// The hosted ingestion boundary accepts 4MiB for the complete JSON request.
// Leave room for transport overhead and drop route payloads, never basic progress.
export const SNAPSHOT_MAX_BYTES=3.5*1024*1024;
// D1 rows are limited to 2,000,000 bytes; reserve space for other content fields.
export const SYNC_ROUTE_MAX_BYTES=1024*1024;
const media=new Set(['.mov','.mp4','.m4v','.jpg','.jpeg','.png','.heic','.webp','.m4a','.wav','.mp3']);
export const mimeType=file=>({'.mov':'video/quicktime','.mp4':'video/mp4','.m4v':'video/mp4','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.heic':'image/heic','.m4a':'audio/mp4','.mp3':'audio/mpeg','.wav':'audio/wav','.zip':'application/zip','.md':'text/markdown','.txt':'text/plain','.json':'application/json','.html':'text/html','.srt':'text/plain','.vtt':'text/vtt','.csv':'text/csv'}[path.extname(file).toLowerCase()]??'application/octet-stream');
const fingerprint=s=>'"'+hash(`${s.size}:${s.mtimeMs}:${s.ino}`).slice(0,40)+'"';
export class LocalObjectStore{
 constructor(entries=[]){this.entries=new Map(entries.map(x=>[x.key,x]));}
 exportRegistry(){return [...this.entries.values()];}
 async register(file){
  const canonical=await realpath(file);const info=await stat(canonical);
  if(!info.isFile()&&!info.isDirectory())throw new Error('SOURCE_UNAVAILABLE');
  const key=hash('reels-local-object-v1\0'+canonical.normalize('NFC'));
  const entry={key,path:canonical,etag:fingerprint(info)};this.entries.set(key,entry);
  return this.headObject(key);
 }
 async headObject(key){
  const e=this.entries.get(key);if(!e)throw new Error('NOT_LOCAL');
  let info;try{if(await realpath(e.path)!==e.path)throw new Error('SOURCE_CHANGED');info=await stat(e.path);}catch{throw new Error('SOURCE_UNAVAILABLE');}
  if(fingerprint(info)!==e.etag)throw new Error('SOURCE_CHANGED');
  return {key,fileName:path.basename(e.path).normalize('NFC'),contentType:mimeType(e.path),contentLength:info.isDirectory()?0:info.size,etag:e.etag,isDirectory:info.isDirectory()};
 }
 async getObject({key,start=0,end,ifMatch}){
  const metadata=await this.headObject(key);if(metadata.isDirectory)throw new Error('NOT_A_FILE');
  if(ifMatch&&metadata.etag!==ifMatch)throw new Error('SOURCE_CHANGED');
  const last=end??Math.min(metadata.contentLength-1,start+2*1024*1024-1);
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(last)||start<0||last<start||last>=metadata.contentLength||last-start+1>2*1024*1024)throw new Error('INVALID_RANGE');
  const file=await open(this.entries.get(key).path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{if(fingerprint(await file.stat())!==metadata.etag)throw new Error('SOURCE_CHANGED');const body=Buffer.alloc(last-start+1);let received=0;while(received<body.length){const r=await file.read(body,received,body.length-received,start+received);if(!r.bytesRead)throw new Error('SOURCE_CHANGED');received+=r.bytesRead;}return {...metadata,body,start,end:last};}finally{await file.close();}
 }
 async listObjects({key,offset=0,limit=100}){
  const metadata=await this.headObject(key);if(!metadata.isDirectory)throw new Error('NOT_A_DIRECTORY');
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>200)throw new Error('INVALID_PAGE');
  const dir=this.entries.get(key).path;const files=(await readdir(dir,{withFileTypes:true})).filter(x=>!x.name.startsWith('.')&&!x.isSymbolicLink()&&x.isFile()&&media.has(path.extname(x.name).toLowerCase())).sort((a,b)=>a.name.localeCompare(b.name));
  return {total:files.length,nextOffset:offset+limit<files.length?offset+limit:null,objects:await Promise.all(files.slice(offset,offset+limit).map(x=>this.register(path.join(dir,x.name))))};
 }
 async countMedia(key){const e=this.entries.get(key);await this.headObject(key);return (await readdir(e.path,{withFileTypes:true})).filter(x=>!x.name.startsWith('.')&&!x.isSymbolicLink()&&x.isFile()&&media.has(path.extname(x.name).toLowerCase())).length;}
}
export async function projectSnapshot(dashboard,sourceLabel='로컬 Mac',options={countFolders:true,knownCounts:{}}){
 const objects=new LocalObjectStore();const contents=[],assets=[];
 let routeUpdatedAt=dashboard.updatedAt;
 for(const p of dashboard.projects){
  const content={id:p.id,title:p.title,date:p.date,dateBasis:p.dateBasis??'record',stage:p.stage,nextAction:p.nextAction,publicURL:p.publicURL,publishingCopy:null,routeMap:null,routeMapStatus:null};
  const routeResources=(p.resources??[]).filter(r=>r.role==='document'&&path.basename(r.path)===ROUTE_MAP_FILENAME);
  if(routeResources.length)content.routeMapStatus='unavailable';
  contents.push(content);
  for(const r of p.resources??[]){
   let meta=null,count=null;try{meta=await objects.register(r.path);if(meta.isDirectory)count=options.countFolders?await objects.countMedia(meta.key):(options.knownCounts?.[meta.key]??null);}catch{}
   const key=meta?.key??hash('unavailable\0'+r.path.normalize('NFC'));
   assets.push({id:hash(p.id+'\0'+r.role+'\0'+key),contentId:p.id,objectKey:key,role:r.role,label:r.label,fileName:meta?.fileName??path.basename(r.path).normalize('NFC'),mimeType:meta?.contentType??mimeType(r.path),bytes:meta?.contentLength??0,isDirectory:meta?.isDirectory??r.role==='folder',available:!!meta,itemCount:count,etag:meta?.etag??'unavailable'});
   if(routeResources.length===1&&r===routeResources[0]&&meta&&!meta.isDirectory&&meta.contentLength<=ROUTE_MAP_MAX_BYTES){
    try{
     const source=await readFile(objects.entries.get(meta.key).path,{encoding:'utf8',signal:AbortSignal.timeout(2000)});
     if(Buffer.byteLength(source,'utf8')>ROUTE_MAP_MAX_BYTES)throw new Error('ROUTE_MAP_TOO_LARGE');
     const routeMap=parseRouteMap(JSON.parse(source));
     if(Buffer.byteLength(JSON.stringify(routeMap),'utf8')>SYNC_ROUTE_MAX_BYTES)throw new Error('ROUTE_MAP_SYNC_TOO_LARGE');
     const info=await stat(objects.entries.get(meta.key).path);
     await objects.headObject(meta.key); // Reject a concurrent document replacement.
     content.routeMap=routeMap;content.routeMapStatus='ready';
     if(info.mtime.toISOString()>routeUpdatedAt)routeUpdatedAt=info.mtime.toISOString();
    }catch{content.routeMap=null;content.routeMapStatus='unavailable';}
   }
   if(r.role==='document'&&path.extname(r.path).toLowerCase()==='.md'&&meta&&!meta.isDirectory&&meta.contentLength<=256*1024){
    try{
     const source=await readFile(objects.entries.get(meta.key).path,{encoding:'utf8',signal:AbortSignal.timeout(2000)});
     const copy=parsePublishingCopy(source,p.id);
     if(copy){
      const info=await stat(objects.entries.get(meta.key).path);
      await objects.headObject(meta.key); // Reject a concurrent document replacement.
      if(content.publishingCopy)throw new Error('AMBIGUOUS_CONTENT_DOCUMENT');
      content.publishingCopy={...copy,updatedAt:info.mtime.toISOString()};
     }
    }catch(error){if(!content.publishingCopy||error.message==='AMBIGUOUS_CONTENT_DOCUMENT')content.publishingCopy={status:'unavailable',publicationStatus:'unknown',sections:[],updatedAt:null};}
   }
  }
 }
 const sourceUpdatedAt=contents.reduce((latest,c)=>c.publishingCopy?.updatedAt>latest?c.publishingCopy.updatedAt:latest,routeUpdatedAt);
 const snapshot={sourceId:'primary-mac',sourceLabel,sourceRevision:'0'.repeat(64),sourceUpdatedAt,contents,assets};
 const routeCandidates=contents.filter(c=>c.routeMap).map(content=>({content,bytes:Buffer.byteLength(JSON.stringify(content.routeMap),'utf8')})).sort((a,b)=>b.bytes-a.bytes);
 for(const {content} of routeCandidates){
  if(Buffer.byteLength(JSON.stringify(snapshot),'utf8')<=SNAPSHOT_MAX_BYTES)break;
  content.routeMap=null;content.routeMapStatus='unavailable';
 }
 snapshot.sourceRevision=hash(JSON.stringify({updatedAt:dashboard.updatedAt,contents,assets}));
 return {objects,snapshot};
}
