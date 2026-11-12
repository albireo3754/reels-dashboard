import {readdir,stat} from "node:fs/promises";
import path from "node:path";

export async function snapshot(root:string){
 const out:Record<string,string>={};
 async function walk(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())await walk(f);else{const s=await stat(f);out[path.relative(root,f)]=s.size+":"+s.mtimeMs;}}}
 await walk(root);return out;
}
