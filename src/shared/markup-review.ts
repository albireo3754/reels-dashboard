import {z} from "zod";
import {bundleParagraphs,parse,SE_FONT_STEPS} from "./blog-markup";
export const visualEvidenceSchema=z.strictObject({path:z.string().min(1),sha256:z.string().regex(/^[0-9a-f]{64}$/),bundleId:z.string(),width:z.number().int(),sourceFingerprint:z.string().regex(/^[0-9a-f]{64}$/)});
export type VisualEvidence=z.infer<typeof visualEvidenceSchema>;
export const emphasisDecision=z.strictObject({
 tid:z.string(),phrase:z.string().min(1),role:z.string().min(1),
 methods:z.array(z.enum(["weight","color","background","size","marker","none"])).min(1),
 action:z.enum(["keep","change","remove","unconfirmed"]),
 reason:z.string().min(1).max(2000),alternatives:z.string().min(1).max(2000),
 findingIds:z.array(z.string()),
});
export const visualReview=z.strictObject({status:z.enum(["pass","needs-work","unverified"]),evidence:z.array(z.string().regex(/^(?:(360|390|430)px SHA256: )?[0-9a-f]{64}$/i)),observation:z.string().min(1).max(4000)});
export const markupReviewInput=z.strictObject({
  id:z.string().uuid(),bundleIds:z.array(z.string()).min(1).max(100),
  source:z.string().min(1).max(180000),guidance:z.string().max(60000).default(""),visualEvidence:z.array(visualEvidenceSchema).max(60).default([]),annotations:z.array(z.unknown()).max(2000).default([]),
});
const proposal=z.union([
  z.strictObject({layer:z.literal("text"),tid:z.string(),before:z.string().min(1),after:z.string()}),
  z.strictObject({layer:z.literal("emphasis"),op:z.enum(["add","change","remove"]),entry:z.strictObject({
    id:z.string(),phrase:z.string().min(1),style:z.strictObject({color:z.string().regex(/^#[0-9a-f]{6}$/i).optional(),bg:z.string().regex(/^#[0-9a-f]{6}$/i).optional(),weight:z.literal(700).optional(),size:z.number().int().optional()}),role:z.string().min(1),
  })}),
  z.null(),
]);
export const markupReviewResult=z.strictObject({
  requestId:z.string().uuid(),reviews:z.array(z.strictObject({
    bundleId:z.string(),verdict:z.enum(["passed","needs-work","awaiting-visual"]),emphasisDecisions:z.array(emphasisDecision).max(100),visual:visualReview,summary:z.string().min(1).max(4000),
    findings:z.array(z.strictObject({id:z.string().min(1),axis:z.enum(["말투","끝맺음","강조","구성"]),severity:z.enum(["필수","권장","관찰"]),observation:z.string().min(1).max(4000),proposal})).max(50),
  })).max(100),
});
export type MarkupReviewResult=z.infer<typeof markupReviewResult>;
export function reviewDocument(source:string){
  const start=source.search(/^---\r?$/m);
  if(start<0)throw new Error("Review source requires markup frontmatter");
  return parse(source.slice(start));
}
export function validateMarkupReview(value:unknown,input:z.infer<typeof markupReviewInput>){
  const result=markupReviewResult.parse(value),doc=reviewDocument(input.source);
  if(result.requestId!==input.id)throw new Error("Review request ID mismatch");
  const ids=result.reviews.map(r=>r.bundleId);
  if(new Set(ids).size!==ids.length||ids.length!==input.bundleIds.length||input.bundleIds.some(id=>!ids.includes(id)))throw new Error("Review bundle selection mismatch");
  const findings=new Set<string>();
  for(const r of result.reviews){
    const b=doc.bundles.find(b=>b.id===r.bundleId);if(!b)throw new Error("Unknown bundle");
    const ps=bundleParagraphs(b);
    if(r.verdict==="passed"&&r.findings.length)throw new Error("Passed review contains findings");
    const byFinding=new Map(r.findings.map(f=>[f.id,f]));
    for(const decision of r.emphasisDecisions){
      if(!ps.find(p=>p.id===decision.tid)?.lines.join("\n").includes(decision.phrase))throw new Error("Emphasis decision target missing");
      if(decision.findingIds.some(id=>!byFinding.has(id)))throw new Error("Decision refers to missing finding");
      if(["change","remove"].includes(decision.action)&&!decision.findingIds.length)throw new Error("Unresolved emphasis change requires a proposal");
    }
    for(const p of ps)for(const mark of p.marks){
      const phrase=p.lines[mark.line].slice(mark.start,mark.end);
      if(!r.emphasisDecisions.some(d=>d.tid===p.id&&d.phrase===phrase))throw new Error("Existing emphasis has no role/choice decision: "+p.id+" / "+phrase);
    }
    for(const annotation of input.annotations as Array<any>){
      if(annotation.fresh===false||!ps.some(p=>p.id===annotation.paragraphId))continue;
      if(typeof annotation.quote==="string"&&!r.emphasisDecisions.some(d=>d.tid===annotation.paragraphId&&d.phrase===annotation.quote))throw new Error("User annotation has no explicit emphasis decision");
    }
    const evidence=(input.visualEvidence??[]).filter(e=>e.bundleId===r.bundleId);
    r.visual.evidence=r.visual.evidence.map(citation=>{
      const match=citation.match(/^(?:(360|390|430)px SHA256: )?([0-9a-f]{64})$/i)!;
      const hash=match[2].toLowerCase();
      if(match[1]&&!evidence.some(e=>e.width===Number(match[1])&&e.sha256===hash))throw new Error("Screenshot label/hash mismatch");
      return hash;
    });
    const widths=[360,390,430];
    if(!evidence.length&&r.visual.status!=="unverified")throw new Error("Visual pass requires supplied screenshots");
    if(r.visual.status!=="unverified"&&(widths.some(w=>!evidence.some(e=>e.width===w))||evidence.some(e=>!r.visual.evidence.includes(e.sha256))))throw new Error("Visual review did not cover all requested widths");
    if(r.visual.evidence.some(hash=>!evidence.some(e=>e.sha256===hash)))throw new Error("Unknown visual evidence");
    if(r.verdict==="passed"&&(r.visual.status!=="pass"||r.emphasisDecisions.some(d=>d.action!=="keep")))throw new Error("Cannot pass without confirmed visual/role review");
    if(r.visual.status==="needs-work"&&r.verdict!=="needs-work")throw new Error("Visual changes cannot be marked passed");
    if(r.visual.status==="unverified"&&r.verdict==="passed")throw new Error("Unverified visual review cannot pass");
    for(const f of r.findings){
      if(findings.has(f.id))throw new Error("Duplicate finding ID");findings.add(f.id);
      if(f.proposal?.layer==="text"){
        const tid=f.proposal.tid;const text=ps.find(p=>p.id===tid)?.lines.join("\n");
        if(!text?.includes(f.proposal.before))throw new Error("Finding does not match original paragraph");
      }else if(f.proposal?.layer==="emphasis"){
        const e=f.proposal.entry;
        if(!r.emphasisDecisions.some(d=>d.tid===e.id&&d.phrase===e.phrase&&d.findingIds.includes(f.id)))throw new Error("Emphasis proposal requires role/choice evidence");
        const text=ps.find(p=>p.id===e.id)?.lines.join("\n");
        if(!text?.includes(e.phrase))throw new Error("Emphasis does not match original paragraph: "+e.id+" / "+JSON.stringify(e.phrase));
        if(e.style.size!==undefined&&!(SE_FONT_STEPS as readonly number[]).includes(e.style.size))throw new Error("Unsupported emphasis size");
      }
    }
  }
  return result;
}
