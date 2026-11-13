import type {InlineProposal} from "../../../shared/inline-review";
import type {CanonicalDocument} from "../../../shared/canonical-blog";
const clip=(text:string,limit:number)=>text.length>limit?text.slice(0,limit)+"…":text;
/**
 * Whether the frame draws this proposal in the manuscript: an in-text diff at the
 * target phrase, or a small marker (format, note, blocked). Stale proposals (the
 * target text changed) are not drawn; the panel explains them.
 */
export function hasBodyMark(item:InlineProposal,doc:CanonicalDocument){
  if(item.state==="applied"||item.state==="decided"||item.state==="changed")return false;
  if(item.kind==="note")return !!item.paragraphId||doc.bundles.some(b=>b.id===item.bundleId);
  return !!item.paragraphId;
}
export function proposalChip(item:InlineProposal):{label:string;tone:string}{
  if(item.state==="decided")return item.decision==="현재 유지"?{label:"현재 유지",tone:"kept"}:{label:item.decision??"적용 · 저장 전",tone:"applied"};
  if(item.state==="applied")return {label:"반영됨",tone:"applied"};
  if(item.state==="changed")return {label:"본문 변경됨",tone:"blocked"};
  if(item.kind==="note")return {label:"의견",tone:"note"};
  if(item.canApply)return {label:"적용 가능",tone:"available"};
  return {label:"위치 확인 불가",tone:"blocked"};
}
export function proposalSummary(item:InlineProposal){
  if(item.kind==="text")return `${clip(item.before??"",40)} → ${item.after?clip(item.after,40):"(삭제)"}`;
  if(item.kind==="format")return `“${clip(item.phrase??"",40)}” 서식`;
  return clip(item.observation.split("\n")[0]??"",80);
}
