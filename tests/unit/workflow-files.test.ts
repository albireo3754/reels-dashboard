import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,realpath,rm,symlink,writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {readWorkspaceJson} from "../../src/app/workflow/files";

async function withWorkspace(run:(workspace:string,outside:string)=>Promise<void>){
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),"workflow-files-")));
 const workspace=path.join(root,"ws"),outside=path.join(root,"outside");
 await mkdir(workspace);await mkdir(outside);
 try{await run(workspace,outside);}finally{await rm(root,{recursive:true,force:true});}
}

test("readWorkspaceJson parses a JSON file inside the workspace",async()=>{
 await withWorkspace(async ws=>{
  await mkdir(path.join(ws,"sub"));
  await writeFile(path.join(ws,"sub","a.json"),JSON.stringify({a:[1,2]}));
  assert.deepStrictEqual(await readWorkspaceJson(ws,"sub/a.json",1000,"too big"),{a:[1,2]});
 });
});

test("readWorkspaceJson rejects a file over the limit with the given message",async()=>{
 await withWorkspace(async ws=>{
  await writeFile(path.join(ws,"a.json"),JSON.stringify({a:"x".repeat(20)}));
  await assert.rejects(readWorkspaceJson(ws,"a.json",10,"File is too large"),{message:"File is too large"});
 });
});

test("readWorkspaceJson rejects paths that escape the workspace",async()=>{
 await withWorkspace(async(ws,outside)=>{
  await writeFile(path.join(outside,"o.json"),"{}");
  await symlink(path.join(outside,"o.json"),path.join(ws,"link.json"));
  await assert.rejects(readWorkspaceJson(ws,"../outside/o.json",1000,"x"),{message:"Use workspace-relative paths without '..'"});
  await assert.rejects(readWorkspaceJson(ws,path.join(outside,"o.json"),1000,"x"),{message:"Use workspace-relative paths without '..'"});
  await assert.rejects(readWorkspaceJson(ws,"link.json",1000,"x"),{message:"File escapes workspace"});
 });
});
