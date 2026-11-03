import {createHash} from "node:crypto";
import {mkdir,readFile,writeFile,realpath} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {parse,serialize} from "../../shared/blog-markup";
import {fingerprint} from "../../shared/blog-markup-source";
import {replaceStickers,stickerPlan,stickerAnchors,STICKER_PRESETS} from "../../shared/blog-stickers";
import {MarkupStore} from "./markup-store";
import type {EditorConfig} from "./store";

const sha=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const json=async(file:string)=>JSON.parse(await readFile(file,"utf8"));
const writeJson=(file:string,value:unknown)=>writeFile(file,JSON.stringify(value,null,2)+"\n");
const placement=z.strictObject({id:z.string(),preset:z.enum(STICKER_PRESETS.map(p=>p.id)),bundleId:z.string(),before:z.number().int().nonnegative(),note:z.string().max(120).optional()});
const evidence=z.strictObject({bundleId:z.string(),width:z.number(),path:z.string(),sha256:z.string()});
export const stickerPacket=z.object({
  version:z.literal(1),kind:z.literal("blog.sticker-review"),projectId:z.string(),fingerprint:z.string(),canon:z.string(),layout:z.string(),
  bundles:z.array(z.object({id:z.string(),name:z.string(),markup:z.string()})),placements:z.array(placement),
  anchors:z.array(z.object({bundleId:z.string(),before:z.number(),label:z.string()})),
  evidence:z.array(evidence),scopeBundleIds:z.array(z.string()),renderFingerprint:z.string(),
});
export const stickerReview=z.strictObject({
  role:z.enum(["context","visual"]),fingerprint:z.string(),
  decisions:z.array(z.strictObject({bundleId:z.string(),stickerId:z.string().nullable(),decision:z.enum(["keep","move","remove","add","omit","unconfirmed"]),reason:z.string().min(1),evidence:z.array(z.string()),proposal:placement.optional()})),
  inspectedImages:z.array(z.string()),limitations:z.array(z.string()),
});
type Packet=z.infer<typeof stickerPacket>;
type Review=z.infer<typeof stickerReview>;
export function checkStickerReview(packet:Packet,input:unknown,role:Review["role"]):Review {
  const result=stickerReview.parse(input);
  if(result.role!==role||result.fingerprint!==packet.fingerprint)throw new Error("Review role or fingerprint mismatch");
  const ids=new Set(packet.placements.map(p=>p.id)),bundles=new Set(packet.bundles.map(b=>b.id));
  const covered=new Set<string>(),seen=new Set<string>();
  for(const d of result.decisions){
    if(!bundles.has(d.bundleId))throw new Error("Unknown bundle in sticker decision");
    if(d.stickerId!==null){
      const original=packet.placements.find(p=>p.id===d.stickerId);
      if(!original||original.bundleId!==d.bundleId||seen.has(d.stickerId))throw new Error("Unknown, duplicated or misplaced sticker decision");
      if(d.decision==="add"||d.decision==="omit")throw new Error("Existing stickers need keep/move/remove/unconfirmed");
      seen.add(d.stickerId);
    }else if(!["add","omit","unconfirmed"].includes(d.decision))throw new Error("Decision needs an existing sticker ID");
    if(d.decision==="omit"&&packet.placements.some(p=>p.bundleId===d.bundleId))throw new Error("Cannot omit an existing sticker");
    if(d.decision==="add"||d.decision==="move"){
      if(!d.proposal || (d.decision==="move" && d.proposal.id!==d.stickerId) || (d.decision==="add"&&ids.has(d.proposal.id)))throw new Error("Missing or invalid placement proposal");
      const doc=parse(packet.bundles.map(b=>b.markup).join("\n"));
      replaceStickers(doc,[...packet.placements.filter(p=>p.id!==d.stickerId),d.proposal]);
    }else if(d.proposal)throw new Error("Unexpected placement proposal");
    if(role==="visual"&&d.stickerId){
      const captures=packet.evidence.filter(e=>e.bundleId===d.bundleId);
      if(![360,390,430].every(w=>captures.some(e=>e.width===w)))throw new Error("Missing mobile evidence width");
      if(captures.some(e=>!result.inspectedImages.includes(e.path)||!d.evidence.includes(e.path)))throw new Error("Visual decision did not inspect/cite all supplied widths");
    }
    covered.add(d.bundleId);
  }
  if(packet.placements.some(p=>!seen.has(p.id)))throw new Error("Missing existing sticker decision");
  if(role==="context"&&packet.bundles.some(b=>!covered.has(b.id)))throw new Error("Context review must decide each bundle, including deliberate omission");
  if(result.inspectedImages.some(file=>!packet.evidence.some(e=>e.path===file)))throw new Error("Unknown inspected evidence");
  return result;
}
async function freshPacket(dir:string,config?:EditorConfig){
  const packet=stickerPacket.parse(await json(path.join(dir,"packet.json")));
  if(config&&path.resolve(config.canon)!==path.resolve(packet.canon))throw new Error("Project manuscript does not match packet");
  if(fingerprint(await readFile(path.join(dir,"source.md"),"utf8"))!==packet.fingerprint)throw new Error("Packet source was changed");
  if(fingerprint(await readFile(packet.canon,"utf8"))!==packet.fingerprint)throw new Error("Stale manuscript; prepare a new sticker packet");
  return packet;
}

/** Freeze manuscript and real local-rendered evidence. Never consumes model jobs. */
export async function prepareStickerReview(projectId:string,config:EditorConfig,outDir:string,forbiddenRoot?:string){
  if(!path.isAbsolute(outDir))throw new Error("Absolute packet path required");
  await mkdir(path.dirname(outDir),{recursive:true});
  const parent=await realpath(path.dirname(outDir));
  if(forbiddenRoot&&(parent===forbiddenRoot||parent.startsWith(forbiddenRoot+path.sep)))throw new Error("Personal review packets must stay outside the app repository");
  await mkdir(outDir);await mkdir(path.join(outDir,"out"));await mkdir(path.join(outDir,"screens"));
  const store=new MarkupStore(config),x=await store.inputs(),source=x.base.text,doc=x.doc;
  const placements=stickerPlan(doc),scopeBundleIds=[...new Set(placements.map(p=>p.bundleId))];
  const packet:Packet={version:1,kind:"blog.sticker-review",projectId,canon:config.canon,layout:config.layout,fingerprint:fingerprint(source),renderFingerprint:fingerprint(source+x.styles),
    bundles:doc.bundles.map(b=>({id:b.id,name:b.name,markup:serialize({version:1,bundles:[b]})})),placements,anchors:stickerAnchors(doc),scopeBundleIds,evidence:[]};
  await writeFile(path.join(outDir,"source.md"),source);
  // Lazy imports keep validation/apply usable without launching a browser.
  if(scopeBundleIds.length){
    const {chromium}=await import("@playwright/test");
    const {startCanonicalEditor}=await import("./server");
    const server=await startCanonicalEditor({...config,review:undefined,requests:undefined,port:0});
    let browser;
    try{
      browser=await chromium.launch({headless:true});const page=await browser.newPage();
      for(const width of [360,390,430]){
        await page.setViewportSize({width,height:1000});await page.goto(server.url+"/api/blog/frame");
        await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode()));});
        if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error("Horizontal overflow in source preview");
        for(const bundleId of scopeBundleIds){
          const clip=await page.evaluate(id=>{
            const all=[...document.querySelectorAll<HTMLElement>(".editor-bundle")],el=all.find(n=>n.dataset.bundle===id)!;
            const r=el.getBoundingClientRect(),next=all[all.indexOf(el)+1];
            const top=Math.max(0,r.top+scrollY-70),bottom=r.bottom+scrollY+(next?Math.min(180,next.getBoundingClientRect().height):20);
            return {x:0,y:top,width:innerWidth,height:Math.min(document.documentElement.scrollHeight,bottom)-top};
          },bundleId);
          // Bundle IDs are manuscript data; never interpolate them into a filesystem path.
          const file=path.join(outDir,"screens",`bundle-${scopeBundleIds.indexOf(bundleId)+1}-${width}.png`);
          const bytes=await page.screenshot({path:file,fullPage:true,clip});
          packet.evidence.push({bundleId,width,path:file,sha256:sha(bytes)});
        }
      }
    }finally{await browser?.close();await server.close();}
  }
  const current=await store.inputs();
  if(fingerprint(current.base.text+current.styles)!==packet.renderFingerprint)throw new Error("Manuscript or styles changed during capture; prepare a fresh packet");
  await writeJson(path.join(outDir,"packet.json"),packet);
  return {ok:true,packetDir:outDir,...packet};
}

export async function finishStickerReview(dir:string,config:EditorConfig){
  const packet=await freshPacket(dir,config),x=await new MarkupStore(config).inputs();
  if(fingerprint(x.base.text+x.styles)!==packet.renderFingerprint)throw new Error("Stale rendered styles; capture again");
  for(const e of packet.evidence)if(sha(await readFile(e.path))!==e.sha256)throw new Error("Screenshot bytes changed");
  const reviews=await Promise.all((["context","visual"] as const).map(async role=>checkStickerReview(packet,await json(path.join(dir,"out",role+".json")),role)));
  const pending=reviews.reduce((n,r)=>n+r.decisions.filter(d=>!["keep","omit"].includes(d.decision)).length+r.limitations.length,0);
  const passed=pending===0,resultPath=path.join(dir,"result.json"),evaluationPath=path.join(dir,"evaluation.md");
  const result={ok:true,passed,status:passed?"passed":"needs-work",fingerprint:packet.fingerprint,pending,nativeStickerStatus:"unverified",scope:"sticker-context-and-local-layout",reviews,resultPath,evaluationPath};
  await writeJson(resultPath,result);
  const cell=(s:string)=>s.replace(/\|/g,"\\|").replace(/\n/g," ");
  await writeFile(evaluationPath,`# 스티커 맥락·화면 검토\n\n정본: ${packet.fingerprint}\n\n결과: ${result.status}. 네이버 실제 기본 스티커 이미지·크기·발행 화면은 미확인. 문체 검토 결과는 갱신하지 않는다.\n\n| 역할 | 묶음 | 스티커 | 결정 | 근거 |\n| --- | --- | --- | --- | --- |\n`+reviews.flatMap(r=>r.decisions.map(d=>`| ${r.role} | ${cell(d.bundleId)} | ${cell(d.stickerId??"미배치")} | ${d.decision} | ${cell(d.reason)} |`)).join("\n")+"\n\n"+reviews.flatMap(r=>r.limitations.map(l=>`- ${r.role}: ${l}`)).join("\n")+"\n");
  return result;
}

export async function applyStickerReview(dir:string,config:EditorConfig,input:unknown){
  const packet=await freshPacket(dir,config);
  const plan=z.strictObject({fingerprint:z.string(),placements:z.array(placement).max(30),decisions:z.array(z.strictObject({stickerId:z.string().nullable(),decision:z.string(),reason:z.string().min(1)})).min(1)}).parse(input);
  if(plan.fingerprint!==packet.fingerprint)throw new Error("Decision uses stale source");
  const source=await readFile(packet.canon,"utf8"),doc=parse(source),next=structuredClone(doc);
  replaceStickers(next,plan.placements);
  const changed=serialize(doc)!==serialize(next),store=new MarkupStore(config),base=await store.load();
  if(base.revision!==packet.fingerprint)throw new Error("Manuscript changed before apply");
  let newRevision=base.revision;
  if(changed){
    await writeFile(path.join(dir,"canon-before-apply.md"),source,{flag:"wx"});
    const result=await store.save({revision:base.revision,edits:[],stickers:plan.placements});newRevision=result.document.revision;
  }
  const logPath=path.join(dir,"decision.json");
  await writeJson(logPath,{...plan,changed,newRevision,requiresNewReview:changed});
  return {ok:true,changed,newRevision,logPath};
}
