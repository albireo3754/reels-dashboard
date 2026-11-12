import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {readBlogProjects,scanBlogProjects} from "../src/desktop/blog-projects";
import {prepareExternalReview,importExternalReview,reviewStatus,type Selection} from "../src/app/blog-editor/external-review";

/**
 * Bundle review loop for external executors (Claude Code workflow, Codex subagents).
 * Uses the same blog projects (content cards with a blog-markup manuscript), input contract, validation and review file as the
 * desktop editor's Codex SDK review. Packets and results must live outside this repository.
 */
const usage=`Usage:
  blog-review.ts projects
  blog-review.ts status <project-id>
  blog-review.ts prepare <project-id> <new-packet-dir> [--changed | --all | --bundles B1,B2]
  blog-review.ts import <project-id> <packet.json> <result.json> --provider <name> [--run <id>]
Env: REELS_DASHBOARD_USER_DATA (default: ~/Library/Application Support/Reels Dashboard)`;
const repoRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const userData=process.env.REELS_DASHBOARD_USER_DATA??path.join(os.homedir(),"Library","Application Support","Reels Dashboard");
const flag=(args:string[],name:string)=>{const i=args.indexOf(name);if(i<0)return undefined;const v=args[i+1];if(!v||v.startsWith("--"))throw new Error(name+" 값이 필요해요.");return v;};
async function project(id:string|undefined){
  if(!id)throw new Error(usage);
  const projects=await readBlogProjects(userData),found=projects.find(p=>p.id===id);
  if(!found)throw new Error(`등록된 블로그 프로젝트가 아니에요: ${id} (등록: ${projects.map(p=>p.id).join(", ")||"없음"})`);
  return found.config;
}
async function main(){
  const [command,...args]=process.argv.slice(2);
  let out:unknown;
  if(command==="projects"){
    const {projects,issues}=await scanBlogProjects(userData);
    out={projects:projects.map(p=>({id:p.id,title:p.title,canon:p.config.canon,layout:p.config.layout,review:p.config.review??null,mediaEvidence:p.config.mediaEvidence??null})),issues};
  }
  else if(command==="status")out=await reviewStatus(await project(args[0]));
  else if(command==="prepare"){
    const [id,dir,...rest]=args;if(!dir)throw new Error(usage);
    const bundles=flag(rest,"--bundles");
    const selection:Selection=bundles?{bundleIds:bundles.split(",").map(s=>s.trim()).filter(Boolean)}:{mode:rest.includes("--all")?"all":"changed"};
    out=await prepareExternalReview(await project(id),selection,path.resolve(dir),{forbiddenRoots:[repoRoot]});
  }
  else if(command==="import"){
    const [id,packet,result,...rest]=args;if(!result)throw new Error(usage);
    const provider=flag(rest,"--provider");if(!provider)throw new Error("--provider 가 필요해요 (예: \"Claude Code workflow\", \"Codex subagents\").");
    out=await importExternalReview(await project(id),path.resolve(packet),path.resolve(result),{provider,runId:flag(rest,"--run")});
  }
  else throw new Error(usage);
  console.log(JSON.stringify(out,null,2));
}
main().catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exitCode=1;});
