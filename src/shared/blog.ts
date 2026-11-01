import {z} from 'zod';
const color=z.string().regex(/^#[\da-f]{3}(?:[\da-f]{3})?$/i);
export const blogSpan=z.strictObject({text:z.string().min(1).max(1000),color:color.optional(),background:color.optional(),weight:z.number().int().min(100).max(900).optional(),occurrence:z.enum(['first','all']).optional()});
export const blogStyle=z.strictObject({bodyFont:z.string().regex(/^[\w -]{1,80}$/).optional(),infoFont:z.string().regex(/^[\w -]{1,80}$/).optional(),background:color.optional(),color:color.optional(),headingColor:color.optional(),paragraphSize:z.number().min(10).max(40).optional(),mobileParagraphSize:z.number().min(10).max(40).optional(),headingSize:z.number().min(10).max(60).optional(),lineHeight:z.number().min(1).max(3).optional(),align:z.enum(['left','center','right']).optional(),desktopWidth:z.number().min(250).max(1600).optional(),mobileWidth:z.number().min(250).max(900).optional(),padding:z.number().min(0).max(100).optional(),headingWeight:z.number().min(100).max(900).optional(),imageRadius:z.number().min(0).max(100).optional()});
export const blogBlock = z.discriminatedUnion('type', [
  z.strictObject({id:z.string().min(1).max(100),type:z.literal('text'),text:z.string().max(20000),role:z.enum(['paragraph','title','heading','info','source','native','tags']).optional(),spans:z.array(blogSpan).max(100).optional()}),
  z.strictObject({id:z.string().min(1).max(100),type:z.literal('image'),path:z.string().startsWith('/').max(4096),alt:z.string().max(500)})
]);
export const blogDraft = z.strictObject({projectId:z.string().min(1).max(160), revision:z.number().int().min(0), blocks:z.array(blogBlock).max(300),style:blogStyle.optional(),reviewGroups:z.array(z.strictObject({id:z.string().min(1).max(160),startBlockId:z.string().min(1).max(100),name:z.string().min(1).max(120),question:z.string().max(1000)})).max(300).optional()});
export type BlogSpan=z.infer<typeof blogSpan>;
export type BlogStyle=z.infer<typeof blogStyle>;
export type BlogBlock = z.infer<typeof blogBlock>;
export type BlogDraft = z.infer<typeof blogDraft>;
export interface BlogBridge {
  readDocument(projectId:string, documentPath:string):Promise<{text:string; fingerprint:string}>;
  load(projectId:string):Promise<BlogDraft>;
  save(draft:BlogDraft):Promise<BlogDraft>;
}
