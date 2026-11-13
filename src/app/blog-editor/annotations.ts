import {recordContentEvent,snapshot} from '../../shared/content-history';
import {readFile,writeFile,open,rename,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {parse} from '../../shared/blog-markup';
import {paragraphNodes} from '../../shared/blog-markup-source';
import type {BlogAnnotation} from '../../shared/blog-annotations';
const entry=z.strictObject({id:z.string().uuid(),paragraphId:z.string().min(1).max(100),quote:z.string().min(1).max(4000),context:z.string().min(1).max(20000),note:z.string().max(4000),checked:z.boolean(),createdAt:z.string()});
const action=z.discriminatedUnion('action',[
  z.strictObject({action:z.literal('add'),id:z.string().uuid(),paragraphId:z.string().min(1),quote:z.string().min(1).max(4000),context:z.string().min(1).max(20000),note:z.string().max(4000),checked:z.boolean()}),
  z.strictObject({action:z.literal('check'),id:z.string().uuid(),checked:z.boolean()}),
]);
export class AnnotationStore {
  private file:string;
  constructor(private canon:string){this.file=canon+'.annotations.json';}
  private async entries():Promise<BlogAnnotation[]>{
    try{return z.array(entry).max(2000).parse(JSON.parse(await readFile(this.file,'utf8')));}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
  }
  async list(){
    const paragraphs=paragraphNodes(parse(await readFile(this.canon,'utf8')));
    return (await this.entries()).map(a=>({...a,fresh:paragraphs.find(p=>p.id===a.paragraphId)?.lines.join('\n')===a.context}));
  }
  async update(value:unknown){
    const input=action.parse(value);
    const lock=await open(this.file+'.lock','wx').catch(e=>{if(e.code==='EEXIST')throw new Error('주석을 저장 중이에요. 잠시 후 다시 시도해주세요.');throw e;});
    const temp=this.file+'.'+randomUUID()+'.tmp';
    try{
      const entries=await this.entries();
      const before=JSON.stringify(entries);
      if(input.action==='add'){
        const paragraphs=paragraphNodes(parse(await readFile(this.canon,'utf8')));
        if(!paragraphs.some(p=>p.id===input.paragraphId)||!input.context.includes(input.quote))throw new Error('선택한 구절과 문단을 다시 확인해주세요.');
        if(!entries.some(a=>a.id===input.id)){
          if(entries.length>=2000)throw new Error('주석은 2,000개까지 저장할 수 있어요.');
          const {action:_,...data}=input;entries.push({...data,createdAt:new Date().toISOString()});
        }
      }else{
        const found=entries.find(a=>a.id===input.id);if(!found)throw new Error('주석을 찾을 수 없어요.');found.checked=input.checked;
      }
      const revision=await snapshot(this.canon,await readFile(this.canon,'utf8'));
      if(before!==JSON.stringify(entries))await recordContentEvent(this.canon,'annotation:'+randomUUID(),{kind:'annotation-intent',revision,actor:'user',actorEvidence:'annotation API action',input,before:JSON.parse(before),after:entries});
      await writeFile(temp,JSON.stringify(entries,null,2)+'\n',{flag:'wx'});await rename(temp,this.file);
      return await this.list();
    }finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});await lock.close();await unlink(this.file+'.lock');}
  }
}
