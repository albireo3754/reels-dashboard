import {z} from "zod";
import {parse,SE_FONT_STEPS} from "./blog-markup";
export const markupReviewInput=z.strictObject({
  id:z.string().uuid(),bundleIds:z.array(z.string()).min(1).max(100),
  source:z.string().min(1).max(180000),annotations:z.array(z.unknown()).max(2000).default([]),
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
    bundleId:z.string(),verdict:z.enum(["passed","needs-work"]),summary:z.string().min(1).max(4000),
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
    const ps=b.nodes.flatMap(n=>n.kind==="paragraph"?[n]:n.children??[]);
    if(r.verdict==="passed"&&r.findings.length)throw new Error("Passed review contains findings");
    for(const f of r.findings){
      if(findings.has(f.id))throw new Error("Duplicate finding ID");findings.add(f.id);
      if(f.proposal?.layer==="text"){
        const tid=f.proposal.tid;const text=ps.find(p=>p.id===tid)?.lines.join("\n");
        if(!text?.includes(f.proposal.before))throw new Error("Finding does not match original paragraph");
      }else if(f.proposal?.layer==="emphasis"){
        const e=f.proposal.entry,text=ps.find(p=>p.id===e.id)?.lines.join("\n");
        if(!text?.includes(e.phrase))throw new Error("Emphasis does not match original paragraph: "+e.id+" / "+JSON.stringify(e.phrase));
        if(e.style.size!==undefined&&!(SE_FONT_STEPS as readonly number[]).includes(e.style.size))throw new Error("Unsupported emphasis size");
      }
    }
  }
  return result;
}
