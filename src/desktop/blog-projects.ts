import {readFile} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";

const absolutePath=z.string().refine(path.isAbsolute,"절대 경로가 필요해요.");
const config=z.object({
  format:z.literal("markup"),canon:absolutePath,layers:absolutePath,layout:absolutePath,media:absolutePath,
  review:absolutePath.optional(),requests:absolutePath.optional(),
  reviewGuidance:z.array(absolutePath).optional(),assetFiles:z.array(absolutePath).optional(),
});
const registry=z.object({version:z.literal(1),projects:z.array(z.object({
  id:z.string().min(1).max(160),title:z.string().trim().min(1).max(300),config,
})).superRefine((projects,ctx)=>{
  const ids=new Set<string>(),sources=new Set<string>();
  for(const project of projects){
    if(ids.has(project.id)||sources.has(path.normalize(project.config.canon)))ctx.addIssue({code:"custom",message:"프로젝트 ID와 원고는 중복 연결할 수 없어요."});
    ids.add(project.id);sources.add(path.normalize(project.config.canon));
  }
})});

/** Explicit local project connections; no implicit default manuscript. */
export async function readBlogProjects(root:string){
  let raw:string;
  try{raw=await readFile(path.join(root,"blog-projects.json"),"utf8");}
  catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return [];throw error;}
  return registry.parse(JSON.parse(raw)).projects;
}
