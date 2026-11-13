import {open,readFile,realpath,stat} from "node:fs/promises";
import path from "node:path";
import {parseDocument} from "yaml";
import {z} from "zod";
import {parse} from "../shared/blog-markup";
import type {Project} from "../shared/contracts";
import type {CanonicalBlogProject} from "../shared/blog";
import {isPublishedOn} from "../shared/publications";
import {errorMessage} from "../shared/lib/errors";
import {LocalStore} from "../shared/lib/storage";
import type {EditorConfig} from "../app/blog-editor/store";

/**
 * Blog → 프로젝트 is a query over the dashboard's content table, not a registry of its own.
 * A content card is a blog project when one of its `document` resources is a blog-markup
 * manuscript (frontmatter `markup: 1`). The card gives id and title; every editor path is
 * derived from the manuscript's folder by convention, and a manuscript whose files live
 * elsewhere names them in its frontmatter `editor:` map (paths relative to the manuscript).
 *
 *   layout          publishing/smarteditor-draft-layout.html
 *   layers          reviews/
 *   requests        <layers>/requests/
 *   review          <layers>/bundle-review.json
 *   mediaEvidence   pointer file <layers>/media-evidence.json → { results: "<results.json>" }
 *   reviewGuidance  the nearest BLOG.md in the manuscript's folder or above
 *   media           frontmatter `media:` (required)
 *   assetFiles      the real files behind the photos and videos the manuscript references
 */
export type BlogProjectConfig=EditorConfig&{format:"markup"};
export interface BlogProject extends CanonicalBlogProject{config:BlogProjectConfig}
/** Why a card that looks like a blog project is not listed. */
export interface BlogProjectIssue{id:string;title:string;reason:string}

export const LAYOUT_FILE=path.join("publishing","smarteditor-draft-layout.html");
export const LAYERS_DIR="reviews";
export const EVIDENCE_POINTER="media-evidence.json";
const GUIDANCE_FILE="BLOG.md";
/** A manuscript's frontmatter is read from this many leading bytes before the full parse. */
const HEADER_BYTES=64*1024;

const relative=z.string().trim().min(1);
const overrides=z.strictObject({
  layout:relative.optional(),layers:relative.optional(),requests:relative.optional(),review:relative.optional(),
  mediaEvidence:relative.optional(),reviewGuidance:z.array(relative.refine(p=>/\.md$/i.test(p),"reviewGuidance는 .md 파일이어야 해요.")).optional(),
});
const pointer=z.object({version:z.literal(1),results:relative});

const missing=(e:unknown)=>["ENOENT","ENOTDIR"].includes((e as NodeJS.ErrnoException)?.code??"");
const exists=(file:string)=>stat(file).then(()=>true,e=>{if(missing(e))return false;throw e;});

/** The leading bytes of a file; undefined when it is not there or is a folder. */
async function head(file:string){
  let handle;
  try{handle=await open(file,"r");}catch(e){if(missing(e)||(e as NodeJS.ErrnoException).code==="EISDIR")return undefined;throw e;}
  try{
    const buffer=Buffer.alloc(HEADER_BYTES);
    const {bytesRead}=await handle.read(buffer,0,HEADER_BYTES,0);
    return buffer.subarray(0,bytesRead).toString("utf8");
  }catch(e){if((e as NodeJS.ErrnoException).code==="EISDIR")return undefined;throw e;}
  finally{await handle.close();}
}

/**
 * The frontmatter of a markdown file that declares itself blog markup (`markup: 1`), read
 * from its first bytes; undefined for any other file. A declared manuscript whose YAML does
 * not parse is an error, so the card is reported instead of silently missing.
 */
async function markupHeader(file:string){
  const text=await head(file);
  const header=text?.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if(!header||!/^markup:\s*1\s*$/m.test(header[1]))return undefined;
  const yaml=parseDocument(header[1]);
  if(yaml.errors.length)throw new Error("frontmatter YAML을 읽지 못했어요: "+yaml.errors[0].message);
  const metadata=yaml.toJSON();
  if(!metadata||typeof metadata!=="object"||Array.isArray(metadata)||metadata.markup!==1)return undefined;
  return metadata as Record<string,unknown>;
}

/** The manuscript's own `editor:` overrides (validated). */
export async function manuscriptOverrides(canon:string){
  const metadata=await markupHeader(canon);
  if(!metadata)throw new Error("blog-markup 원고(frontmatter markup: 1)가 아니에요.");
  const parsed=overrides.safeParse(metadata.editor??{});
  if(!parsed.success)throw new Error("frontmatter editor: 값이 올바르지 않아요. ("+parsed.error.issues.map(i=>[...i.path,i.message].join(" ")).join("; ")+")");
  return {metadata,own:parsed.data};
}

async function nearestGuidance(dir:string){
  for(let at=dir;;at=path.dirname(at)){
    const file=path.join(at,GUIDANCE_FILE);
    if(await exists(file))return file;
    if(path.dirname(at)===at)return undefined;
  }
}

/**
 * The results.json the layers folder's pointer names, if there is a usable pointer. The photo
 * picker is optional: a broken pointer leaves the project without it instead of hiding the
 * project (connectEvidence can then replace the pointer).
 */
export async function evidencePointer(layers:string){
  try{
    const value=pointer.parse(JSON.parse(await readFile(path.join(layers,EVIDENCE_POINTER),"utf8")));
    return path.resolve(layers,value.results);
  }catch{return undefined;}
}

/** Files the manuscript shows (photos, collage cells, video posters and videos), by name. */
function referencedMedia(text:string){
  const doc=parse(text);
  return [...new Set(doc.bundles.flatMap(b=>[...b.nodes,...b.nodes.flatMap(n=>n.kind==="component"&&n.children?n.children:[])]).flatMap(n=>{
    if(n.kind!=="component")return [];
    if(n.tag==="Photo")return [String(n.attrs.file)];
    if(n.tag==="Collage")return String(n.attrs.files).split(" · ");
    if(n.tag==="Video")return [n.attrs.file,n.attrs.poster].filter(Boolean).map(String);
    return [];
  }).map(name=>path.basename(name.trim())).filter(Boolean))];
}

/** Real paths behind linked media files, which the editor would otherwise refuse as moved. */
async function linkedAssets(media:string,text:string){
  let names:string[];
  try{names=referencedMedia(text);}catch{return [];}
  const files=await Promise.all(names.map(async name=>{
    const file=path.join(media,name);
    // A missing or unreadable file is left out; the editor then reports that one photo.
    try{const real=await realpath(file);return real===path.resolve(file)?undefined:real;}catch{return undefined;}
  }));
  return [...new Set(files.filter((f):f is string=>!!f))].sort();
}

/** The editor connection for one manuscript; throws with the reason it cannot be one. */
export async function manuscriptConfig(canon:string):Promise<BlogProjectConfig>{
  // The editor refuses a canon whose real path differs (a linked folder, NFD vs NFC names).
  canon=await realpath(canon);
  const {metadata,own}=await manuscriptOverrides(canon);
  const text=await readFile(canon,"utf8"),dir=path.dirname(canon),at=(p:string)=>path.resolve(dir,p);
  if(typeof metadata.media!=="string"||!metadata.media.trim())throw new Error("frontmatter media: 가 없어요.");
  const layers=own.layers?at(own.layers):path.join(dir,LAYERS_DIR);
  const media=at(metadata.media);
  const mediaEvidence=own.mediaEvidence?at(own.mediaEvidence):await evidencePointer(layers);
  const reviewGuidance=own.reviewGuidance?own.reviewGuidance.map(at):[await nearestGuidance(dir)].filter((f):f is string=>!!f);
  const assetFiles=await linkedAssets(media,text);
  return {
    format:"markup",canon,layers,
    layout:own.layout?at(own.layout):path.join(dir,LAYOUT_FILE),
    media,
    review:own.review?at(own.review):path.join(layers,"bundle-review.json"),
    requests:own.requests?at(own.requests):path.join(layers,"requests"),
    ...(reviewGuidance.length?{reviewGuidance}:{}),
    ...(assetFiles.length?{assetFiles}:{}),
    ...(mediaEvidence?{mediaEvidence}:{}),
  };
}

/** Blog projects among the content cards, plus the cards that point at a manuscript but cannot open. */
export async function blogProjectsFrom(cards:readonly Pick<Project,"id"|"title"|"resources"|"stage"|"publications">[]){
  const projects:BlogProject[]=[],issues:BlogProjectIssue[]=[],owners=new Map<string,string>();
  for(const card of cards){
    const issue=(reason:string)=>issues.push({id:card.id,title:card.title,reason});
    // One card's unreadable file (permissions, a link loop) is that card's issue, not the list's.
    try{
      const documents=[...new Set((card.resources??[]).filter(r=>r.role==="document"&&/\.md$/i.test(r.path)&&path.isAbsolute(r.path)).map(r=>path.resolve(r.path)))];
      const found=await Promise.all(documents.map(async file=>{
        try{return await markupHeader(file)?[await realpath(file)]:[];}
        catch(e){issue(`${file}: ${errorMessage(e)}`);return [];}
      }));
      const manuscripts=[...new Set(found.flat())];
      if(!manuscripts.length)continue;
      if(manuscripts.length>1){issue("blog-markup 원고가 여러 개 연결돼 있어요: "+manuscripts.join(", "));continue;}
      const [file]=manuscripts;
      const owner=owners.get(file);
      if(owner){issue(`같은 원고가 ${owner} 카드에 이미 연결돼 있어요.`);continue;}
      owners.set(file,card.id);
      // Channel records own blog completion; cards without them still use the project stage.
      const published=isPublishedOn(card,"blog")||(!card.publications?.length&&card.stage==="published");
      projects.push({id:card.id,title:card.title,published,config:{...await manuscriptConfig(file),projectId:card.id}});
    }catch(e){issue(errorMessage(e));}
  }
  return {projects,issues};
}

/** Reads the dashboard in the given user-data folder and returns its blog projects. */
export async function scanBlogProjects(root:string){
  return blogProjectsFrom((await new LocalStore(root).load()).projects);
}

export async function readBlogProjects(root:string){
  return (await scanBlogProjects(root)).projects;
}
