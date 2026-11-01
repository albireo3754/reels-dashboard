import { readFile, writeFile, open, rename, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse, validate, SE_FONT_STEPS } from "./blog-markup";
import { fingerprint, merge3, normalize, protectedText, paragraphNodes } from "./blog-markup-source";

const historyDir = (file:string) => path.join(path.dirname(file),".history",path.basename(file));
export async function load(file:string) {
  const text=await readFile(file,"utf8");
  const warnings:string[]=[];
  try {
    const last=await readFile(path.join(historyDir(file),"last-tool.md"),"utf8");
    if(last!==text) warnings.push("EXTERNAL_CHANGE: 마지막 도구 저장본과 다릅니다. Obsidian 덮어쓰기 여부를 비교하세요.");
  } catch(e) {if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  return {text,fingerprint:fingerprint(text),warnings};
}
export async function save(file:string,mine:string,base:{text:string;fingerprint:string},opts:{actor:"user"|"agent";historyLimit?:number;preserveExistingSizeErrors?:boolean}) {
  if(fingerprint(base.text)!==base.fingerprint)throw new Error("INVALID_BASE");
  const lock=await open(file+".lock","wx").catch(e=>{if(e.code==="EEXIST")throw new Error("BUSY");throw e;});
  const temp=file+"."+randomUUID()+".tmp";
  try {
    const current=await readFile(file,"utf8");
    let result:string;
    if(fingerprint(current)===base.fingerprint) result=normalize(mine);
    else { const merged=merge3(base.text,mine,current);if(!merged.ok)return merged;result=merged.text; }
    const doc=parse(result);
    let errors=validate(doc).filter(i=>i.level==="error");
    if(opts.actor==="user" && opts.preserveExistingSizeErrors){
      const prior=parse(current);
      const sizeMarks=(d:typeof doc)=>paragraphNodes(d).flatMap(p=>p.marks.filter(m=>m.style.size!==undefined && !(SE_FONT_STEPS as readonly number[]).includes(m.style.size)).map(m=>JSON.stringify([p.id,p.lines[m.line]?.slice(m.start,m.end),m.style.size,m.style.sizeRole]))).sort();
      const allowed=sizeMarks(prior);
      const unchanged=sizeMarks(doc).every(mark=>{const i=allowed.indexOf(mark);if(i<0)return false;allowed.splice(i,1);return true;});
      if(unchanged){
        const existing=new Set(validate(prior).filter(i=>i.level==="error"&&i.message.includes("px은 SmartEditor에 없음")).map(i=>JSON.stringify(i)));
        errors=errors.filter(i=>!existing.has(JSON.stringify(i)));
      }
    }
    if(errors.length)return {ok:false as const,conflicts:[{kind:"validation",errors}]};
    // Compare both authored edit and merged result: concurrent user text is preserved.
    if(opts.actor==="agent" && (protectedText(parse(base.text))!==protectedText(parse(mine)) ||
      protectedText(parse(current))!==protectedText(doc)))
      throw new Error("TEXT_GUARD");
    const dir=historyDir(file);await mkdir(dir,{recursive:true});
    await writeFile(path.join(dir,Date.now()+"-"+randomUUID()+".md"),current,{flag:"wx"});
    await writeFile(temp,result,{flag:"wx"});
    // Obsidian does not honor our lock; close the main read/write race as far as possible.
    if(await readFile(file,"utf8")!==current)return {ok:false as const,conflicts:[{kind:"external-change-during-save"}]};
    await rename(temp,file);
    await writeFile(path.join(dir,"last-tool.md"),result);
    const verified=await readFile(file,"utf8")===result;
    const entries=(await readdir(dir)).filter(n=>n!=="last-tool.md").sort();
    for(const name of entries.slice(0,Math.max(0,entries.length-Math.max(1,opts.historyLimit??20))))await unlink(path.join(dir,name));
    return {ok:true as const,text:result,fingerprint:fingerprint(result),warnings:verified?[]:["OVERWRITTEN_AFTER_SAVE"]};
  } finally {
    await unlink(temp).catch(e=>{if(e.code!=="ENOENT")throw e;});
    await lock.close();await unlink(file+".lock");
  }
}
