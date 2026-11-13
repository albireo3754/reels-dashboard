import {z} from 'zod';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {snapshot,recordContentEvent,contentHistoryDir,contentHash} from '../../shared/content-history';
import {fingerprint} from '../../shared/blog-markup-source';
const feedback=z.strictObject({
  id:z.string().uuid(),revision:z.string().min(1).max(128),
  action:z.enum(['accept-intent','keep','annotation','suggest-accepted','suggest-dismissed']),
  proposalId:z.string().max(200),proposal:z.unknown(),reason:z.string().max(4000).optional(),
});
export async function collectFeedback(file:string,value:unknown,projectId?:string){
  const event=feedback.parse(value),text=await readFile(file,'utf8');
  const existing=await readFile(path.join(contentHistoryDir(file),'events',contentHash('feedback:'+event.id)+'.json'),'utf8').catch(e=>{if(e.code==='ENOENT')return undefined;throw e;});
  if(existing){
    const old=JSON.parse(existing);
    if(JSON.stringify(old.clientPayload)!==JSON.stringify(event))throw new Error('EVENT_ID_CONFLICT');
    return {ok:true,created:false,id:event.id};
  }
  const observedRevision=await snapshot(file,text);
  const created=await recordContentEvent(file,'feedback:'+event.id,{
    kind:'feedback',...event,clientEventId:event.id,clientPayload:event,projectId:projectId??null,observedRevision,
    stale:event.revision!==fingerprint(text),actor:'user',actorEvidence:'editor action; caller not authenticated as a human',
    source:'editor',labelStatus:'unconfirmed',
  });
  if(!created){
    const stored=JSON.parse(await readFile(path.join(contentHistoryDir(file),'events',contentHash('feedback:'+event.id)+'.json'),'utf8'));
    if(JSON.stringify(stored.clientPayload)!==JSON.stringify(event))throw new Error('EVENT_ID_CONFLICT');
  }
  return {ok:true,created,id:event.id};
}
