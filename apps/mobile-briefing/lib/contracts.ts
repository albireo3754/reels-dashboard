import { z } from 'zod';
import {monitorSchema,progressShape} from './monitor';
import {routeMapSchema} from './route-map';
const safeText=(max:number)=>z.string().max(max).refine(v=>!v.includes('\0'));
export const publishingCopySchema=z.object({
 status:z.enum(['ready','empty','unavailable']),publicationStatus:safeText(40),updatedAt:z.string().datetime().nullable(),
 sections:z.array(z.object({id:safeText(80),kind:z.enum(['caption','comment','reply']),label:safeText(80),parentId:safeText(80).nullable(),text:safeText(20000)}).strict()).max(30),
}).strict();
export type PublishingCopy=z.infer<typeof publishingCopySchema>;
export const snapshotSchema=z.object({
 monitor:monitorSchema.nullable().optional(),
 sourceId:z.literal('primary-mac'),sourceLabel:safeText(100),sourceRevision:safeText(100),sourceUpdatedAt:z.string().datetime(),
 contents:z.array(z.object({id:safeText(160),title:safeText(500),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),dateBasis:z.enum(['capture','publication','record']),stage:z.enum(['idea','captured','selected','editing','review','done','published']),nextAction:safeText(2000),publicURL:safeText(2048).refine(v=>!v||/^https?:\/\//.test(v)),...progressShape,publishingCopy:publishingCopySchema.nullable().optional(),routeMap:routeMapSchema.nullable().optional(),routeMapStatus:z.enum(['ready','unavailable']).nullable().optional()}).strict().refine(value=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=1900000,'Content row exceeds database limit')).max(500),
 assets:z.array(z.object({id:z.string().regex(/^[a-f0-9]{64}$/),contentId:safeText(160),objectKey:z.string().regex(/^[a-f0-9]{64}$/),role:z.enum(['footage','final','cover','draft','document','folder']),label:safeText(300),fileName:safeText(255),mimeType:safeText(120),bytes:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),isDirectory:z.boolean(),available:z.boolean(),itemCount:z.number().int().min(0).nullable(),etag:safeText(100)}).strict()).max(5000),
}).strict();
export function rangeFor(header:string|null,size:number,maxLength=2*1024*1024){
 if(!header)return {start:0,end:size-1,partial:false};
 const m=/^bytes=(\d*)-(\d*)$/.exec(header);if(!m||(!m[1]&&!m[2]))throw new Error('INVALID_RANGE');
 let start=m[1]?Number(m[1]):Math.max(0,size-Number(m[2]));let end=m[1]?(m[2]?Number(m[2]):size-1):size-1;
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>=size||start<0||end<start)throw new Error('INVALID_RANGE');
 return {start,end:Math.min(end,size-1,start+maxLength-1),partial:true};
}
