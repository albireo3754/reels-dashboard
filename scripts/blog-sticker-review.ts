import path from "node:path";
import os from "node:os";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {readBlogProjects} from "../src/desktop/blog-projects";
import {prepareStickerReview,finishStickerReview,applyStickerReview} from "../src/app/blog-editor/sticker-review";

async function main(){
  const [command,first,second]=process.argv.slice(2),projects=await readBlogProjects(process.env.REELS_DASHBOARD_USER_DATA??path.join(os.homedir(),"Library/Application Support/Reels Dashboard"));
  if(!first||!["prepare","finish","apply"].includes(command))throw new Error("Usage: prepare <projectId> <new-absolute-dir> | finish <packet-dir> | apply <packet-dir> <plan.json>");
  const id=command==="prepare"?first:JSON.parse(await readFile(path.join(first,"packet.json"),"utf8")).projectId;
  const project=projects.find(p=>p.id===id);if(!project)throw new Error("Unknown registered project");
  const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
  const result=command==="prepare"?await prepareStickerReview(id,project.config,second,repo):command==="finish"?await finishStickerReview(first,project.config):await applyStickerReview(first,project.config,JSON.parse(await readFile(second,"utf8")));
  console.log(JSON.stringify(result,null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
