import { readFile, writeFile, open, rename, mkdir, readdir, unlink, stat } from "node:fs/promises";
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
/** A save holds the lock for milliseconds, so a lock this old was left behind by a crash. */
const STALE_LOCK_MS=120_000;
async function acquire(lockFile:string){
  try {return await open(lockFile,"wx");}
  catch(e) {
    if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;
    const age=await stat(lockFile).then(s=>Date.now()-s.mtimeMs,()=>0);
    if(age<STALE_LOCK_MS)throw new Error("BUSY");
    await unlink(lockFile).catch(()=>{});
    return open(lockFile,"wx").catch(()=>{throw new Error("BUSY");});
  }
}
/** The text behind a fingerprint, when a save or tool kept it. Lets edits outlive a restart. */
export async function recoverBase(file:string,wanted:string) {
  const dir=historyDir(file);
  const names=await readdir(dir).catch(e=>{if(e.code==="ENOENT")return [] as string[];throw e;});
  for(const name of names.filter(n=>n.endsWith(".md")).sort().reverse()) {
    const text=await readFile(path.join(dir,name),"utf8").catch(()=>undefined);
    if(text!==undefined&&fingerprint(text)===wanted)return {text,fingerprint:wanted};
  }
  return undefined;
}
const CONFLICT_COPIES=30;
export async function save(file:string,mine:string,base:{text:string;fingerprint:string},opts:{actor:"user"|"agent";historyLimit?:number;preserveExistingSizeErrors?:boolean;
  /** Errors already in the file are not this save's fault; only new ones refuse it. */
  tolerateExistingErrors?:boolean;
  /** Skip the snapshot of our own recent save, so frequent autosaves keep a long history. */
  historyCoalesceMs?:number;
  /** Keep the version being replaced outside the rotating history (a conflict was resolved). */
  conflictCopy?:boolean;
  /** New paragraph id -> the paragraph it was split from: its old errors are still old. */
  moved?:Record<string,string>}) {
  if(fingerprint(base.text)!==base.fingerprint)throw new Error("INVALID_BASE");
  const lock=await acquire(file+".lock");
  const temp=file+"."+randomUUID()+".tmp";
  try {
    const current=await readFile(file,"utf8");
    let result:string;
    if(fingerprint(current)===base.fingerprint) result=normalize(mine);
    else { const merged=merge3(base.text,mine,current);if(!merged.ok)return merged;result=merged.text; }
    const doc=parse(result);
    let errors=validate(doc).filter(i=>i.level==="error");
    const origin=(id:string)=>opts.moved?.[id]??id;
    const asBefore=<T extends {where:string}>(i:T)=>JSON.stringify({...i,where:i.where.replace(/[^/]+$/,origin)});
    if(opts.actor==="user" && opts.preserveExistingSizeErrors){
      const prior=parse(current);
      const sizeMarks=(d:typeof doc)=>paragraphNodes(d).flatMap(p=>p.marks.filter(m=>m.style.size!==undefined && !(SE_FONT_STEPS as readonly number[]).includes(m.style.size)).map(m=>JSON.stringify([origin(p.id),p.lines[m.line]?.slice(m.start,m.end),m.style.size,m.style.sizeRole]))).sort();
      const allowed=sizeMarks(prior);
      const unchanged=sizeMarks(doc).every(mark=>{const i=allowed.indexOf(mark);if(i<0)return false;allowed.splice(i,1);return true;});
      if(unchanged){
        const existing=new Set(validate(prior).filter(i=>i.level==="error"&&i.message.includes("px은 SmartEditor에 없음")).map(i=>JSON.stringify(i)));
        errors=errors.filter(i=>!existing.has(asBefore(i)));
      }
    }
    if(opts.actor==="user" && opts.tolerateExistingErrors && errors.length){
      const existing=new Set(validate(parse(current)).filter(i=>i.level==="error").map(i=>JSON.stringify(i)));
      errors=errors.filter(i=>!existing.has(asBefore(i)));
    }
    if(errors.length)return {ok:false as const,conflicts:[{kind:"validation",errors}]};
    // Compare both authored edit and merged result: concurrent user text is preserved.
    if(opts.actor==="agent" && (protectedText(parse(base.text))!==protectedText(parse(mine)) ||
      protectedText(parse(current))!==protectedText(doc)))
      throw new Error("TEXT_GUARD");
    const dir=historyDir(file);await mkdir(dir,{recursive:true});
    const copies=(await readdir(dir)).filter(n=>/^\d+-/.test(n)).sort();
    const lastTool=await readFile(path.join(dir,"last-tool.md"),"utf8").catch(()=>undefined);
    const recent=!!opts.historyCoalesceMs&&lastTool===current&&!!copies.length&&Date.now()-Number(copies.at(-1)!.split("-")[0])<opts.historyCoalesceMs;
    if(opts.conflictCopy)await writeFile(path.join(dir,"conflict-"+Date.now()+"-"+randomUUID()+".md"),current,{flag:"wx"});
    else if(!recent)await writeFile(path.join(dir,Date.now()+"-"+randomUUID()+".md"),current,{flag:"wx"});
    await writeFile(temp,result,{flag:"wx"});
    // Obsidian does not honor our lock; close the main read/write race as far as possible.
    if(await readFile(file,"utf8")!==current)return {ok:false as const,conflicts:[{kind:"external-change-during-save"}]};
    await rename(temp,file);
    await writeFile(path.join(dir,"last-tool.md"),result);
    const verified=await readFile(file,"utf8")===result;
    const names=await readdir(dir);
    const entries=names.filter(n=>/^\d+-/.test(n)).sort(),conflicts=names.filter(n=>n.startsWith("conflict-")).sort();
    for(const name of entries.slice(0,Math.max(0,entries.length-Math.max(1,opts.historyLimit??20))))await unlink(path.join(dir,name));
    for(const name of conflicts.slice(0,Math.max(0,conflicts.length-CONFLICT_COPIES)))await unlink(path.join(dir,name));
    return {ok:true as const,text:result,fingerprint:fingerprint(result),warnings:verified?[]:["OVERWRITTEN_AFTER_SAVE"]};
  } finally {
    await unlink(temp).catch(e=>{if(e.code!=="ENOENT")throw e;});
    await lock.close();await unlink(file+".lock");
  }
}
