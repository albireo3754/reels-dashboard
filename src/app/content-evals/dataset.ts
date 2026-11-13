import {readFile, readdir, realpath, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {stringify} from 'yaml';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {contentHash,immutableJson} from '../../shared/content-history';

export const importManifest=z.strictObject({version:z.literal(1),sources:z.array(z.strictObject({
  file:z.string(),kind:z.enum(['notes','review','session-summary','published-comparison','experiment','history']),
  articleId:z.string().optional(),split:z.enum(['development','holdout-candidate']).default('development'),
})).min(1)});
export interface RawRecord {
  version:1;id:string;contentId:string;kind:string;articleId:string|null;split:string;
  source:{file:string;sha256:string;startLine:number;endLine:number;observedAt:string};
  text:string;actor:'unknown';attribution:'unverified-source-report';labelStatus:'unconfirmed';
}
/** Real data must not enter a Git checkout (including this public source tree). */
export async function privateOutput(directory:string){
  let cursor=path.resolve(directory);
  for(;;){
    try {const entries=await readdir(cursor);if(entries.includes('.git'))throw new Error('OUTPUT_INSIDE_GIT: use a private data directory outside Git');}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;
  }
  await mkdir(directory,{recursive:true,mode:0o700});
  const actual=await realpath(directory);
  if(actual!==path.resolve(directory))await privateOutput(actual);
  return actual;
}
function chunks(text:string){
  const lines=text.split('\n');const sections:Array<{text:string;startLine:number;endLine:number}>=[];
  let start=0;
  for(let i=1;i<=lines.length;i++){
    if(i===lines.length||/^#{1,4} |^- \*\*레슨\*\*/.test(lines[i])){
      const body=lines.slice(start,i).join('\n');
      if(body.trim())sections.push({text:body,startLine:start+1,endLine:i});start=i;
    }
  }
  return sections;
}
export async function importDataset(manifest:unknown,directory:string){
  const input=importManifest.parse(manifest),out=await privateOutput(directory);
  const report={targets:input.sources.length,collected:0,duplicates:0,unconfirmed:0,errors:[] as Array<{file:string;error:string}>,omitted:'Only explicit manifest files; no background session crawl, images, or inferred gold labels.'};
  for(const source of input.sources){
    try{
      const file=await realpath(source.file),text=await readFile(file,'utf8'),sha256=contentHash(text);
      if(Buffer.byteLength(text)>8_000_000)throw new Error('Source exceeds 8MB');
      if(/\.json$/.test(file))JSON.parse(text);
      await immutableJson(path.join(out,'sources',sha256+'.json'),{file,sha256,text});
      const records=/\.md$/.test(file)?chunks(text):[{text,startLine:1,endLine:text.split('\n').length}];
      for(const chunk of records){
        const id=contentHash(JSON.stringify([file,sha256,chunk.startLine,chunk.endLine]));
        const record:RawRecord={version:1,id,contentId:contentHash(chunk.text),kind:source.kind,articleId:source.articleId??null,split:source.split,source:{file,sha256,startLine:chunk.startLine,endLine:chunk.endLine,observedAt:new Date().toISOString()},text:chunk.text,actor:'unknown',attribution:'unverified-source-report',labelStatus:'unconfirmed'};
        if(await immutableJson(path.join(out,'raw',id+'.json'),record))report.collected++;else report.duplicates++;
      }
    }catch(e){report.errors.push({file:source.file,error:String(e)});}
  }
  const records=await readRecords(out);report.unconfirmed=records.length;
  const csv=(v:unknown)=>'"'+String(v??'').replaceAll('"','""')+'"';
  const columns=['id','contentId','kind','articleId','split','labelStatus','sourceFile','sourceHash','startLine','endLine','observedAt','text'];
  await writeFile(path.join(out,'dataset.yaml'),stringify({version:1,records}),{mode:0o600});
  await writeFile(path.join(out,'dataset.csv'),columns.join(',')+'\n'+records.map(r=>[r.id,r.contentId,r.kind,r.articleId,r.split,r.labelStatus,r.source.file,r.source.sha256,r.source.startLine,r.source.endLine,r.source.observedAt,r.text].map(csv).join(',')).join('\n')+'\n',{mode:0o600});
  await writeFile(path.join(out,'import-report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  await immutableJson(path.join(out,'imports',randomUUID()+'.json'),{manifest:input,report,observedAt:new Date().toISOString()});
  return report;
}
export async function readRecords(out:string):Promise<RawRecord[]>{
  const names=await readdir(path.join(out,'raw')).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
  return Promise.all(names.filter(n=>n.endsWith('.json')).sort().map(async n=>JSON.parse(await readFile(path.join(out,'raw',n),'utf8'))));
}
export const caseSchema=z.strictObject({version:z.literal(1),id:z.string().regex(/^[\w-]{1,100}$/),rawIds:z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1),
  status:z.enum(['candidate','confirmed']),split:z.enum(['development','holdout-candidate','holdout']),
  input:z.string(),expectedFindingIds:z.array(z.string()),exhaustive:z.boolean(),
  confirmation:z.strictObject({actor:z.literal('user'),by:z.string().min(1),evidence:z.string().min(1),at:z.string().datetime()}).optional(),
});
export async function storeCase(directory:string,value:unknown){
  const c=caseSchema.parse(value);await privateOutput(directory);
  if(c.status==='confirmed'&&!c.confirmation)throw new Error('Explicit user confirmation evidence required');
  if(c.split==='holdout'&&c.status!=='confirmed')throw new Error('Holdout requires confirmation');
  const raw=await readRecords(directory);
  if(c.rawIds.some(id=>!raw.some(r=>r.id===id)))throw new Error('Unknown raw event');
  if(c.split==='holdout'&&c.rawIds.some(id=>raw.find(r=>r.id===id)!.split==='development'))throw new Error('Historical development data cannot become holdout');
  const revision=contentHash(JSON.stringify(c));
  await immutableJson(path.join(directory,'cases',c.id,revision+'.json'),c);
  return {id:c.id,revision};
}
