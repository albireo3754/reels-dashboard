import {readFile} from 'node:fs/promises';
import {LocalObjectStore} from '../../packages/icloud-object-sdk/index.mjs';
const [registry,key,start,end,etag]=process.argv.slice(2);
try{
 const record=JSON.parse(await readFile(registry,'utf8'));
 const objects=new LocalObjectStore(record.objects);
 const object=await objects.getObject({key,start:Number(start),end:Number(end),ifMatch:etag});
 process.stdout.write(object.body);
}catch(e){process.stderr.write(['SOURCE_CHANGED','SOURCE_UNAVAILABLE','NOT_LOCAL','INVALID_RANGE'].includes(e.message)?e.message:'SOURCE_UNAVAILABLE');process.exitCode=1;}
