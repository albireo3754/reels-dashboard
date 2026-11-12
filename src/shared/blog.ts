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
/** An opened project editor: the blog tab embeds `url` (its own loopback server) under `title`. */
export interface CanonicalEditorTab {projectId:string;title:string;url:string}
export interface BlogBridge {
  canonicalProjects?():Promise<Array<{id:string;title:string}>>;
  /** Cards with a blog-markup manuscript that are left out of the list, and why. */
  canonicalIssues?():Promise<Array<{id:string;title:string;reason:string}>>;
  openCanonical?(projectId:string):Promise<CanonicalEditorTab>;
  /** Asks before an editor tab closes; `close` false means the writer chose to keep editing. */
  closeCanonical?(projectId:string):Promise<{close:boolean;unsaved:boolean}>;
  /** URL → in-app extraction → result folder registered in results(). Same service as MCP reels_extract_blog_reference. */
  extract(input:import('./blog-restore').BlogExtractInput):Promise<import('./blog-restore').BlogExtractResult>;
  extractDirectory():Promise<string|null>;
  /** Fires after any link/unlink, including MCP calls. */
  onResultsChanged(callback:()=>void):()=>void;
  removeResult(id:string):Promise<{removed:string}>;
  chooseExtractDirectory():Promise<string|null>;
  onExtractProgress(callback:(event:import('./blog-restore').BlogExtractProgress)=>void):()=>void;
  results():Promise<BlogResult[]>;
  addResult():Promise<BlogResult|null>;
  readResult(id:string):Promise<string>;
  previewResult(id:string):Promise<string>;
  readDocument(projectId:string, documentPath:string):Promise<{text:string; fingerprint:string}>;
  load(projectId:string):Promise<BlogDraft>;
  save(draft:BlogDraft):Promise<BlogDraft>;
}

export interface BlogResult {id:string;directory:string;names:string[];blocks:number;preview:boolean;error?:string}
