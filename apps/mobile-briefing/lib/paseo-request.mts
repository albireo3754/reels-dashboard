// Builds the fixed request a user pastes into their own Paseo session.
// Only the target identifier and the snapshot time are interpolated; free card
// text (title, why, decision, doneWhen, outcome) is never included, and targets
// carrying specific character/format risks (line breaks, controls, invisible
// format or tag characters, lone surrogates) are rejected. The target is still
// an identifier from synchronized data: the receiving agent must treat it as
// data, not as an instruction.
export const PASEO_REQUEST_LEAD='Reels Dashboard 오늘 볼 항목을 확인해 줘. reels autopilot inbox로 이 항목의 현재 상태를 읽고, 내가 판단할 한 가지와 근거를 보여줘.';
export const PASEO_TARGET_MAX=2048;
const PROJECT_ID_MAX=160;
// Rejected by Unicode property rather than by listed ranges: whitespace and
// separators (Z, \s), controls (Cc), format characters (Cf: zero-width, bidi,
// BOM, U+E0000–E007F tags, U+1D173–1D17A), other default-ignorable code points,
// surrogates (Cs: in /u mode a lone surrogate matches), private use (Co) and
// unassigned code points (Cn). Hangul, other letters and emoji stay allowed.
const UNSAFE=/[\s\p{Z}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\p{Cs}\p{Co}\p{Cn}]/u;

export type PaseoRequest=
 {ok:true;text:string;target:string;basis:string}|
 {ok:false;reason:string;basis:string|null};

/** Returns the target only when it satisfies the existing monitor contract
 * (http(s) URL or project:<id>, at most 2048 chars) and has no characters
 * that could start a new line or hide text in the copied request. */
export function validPaseoTarget(target:unknown):string|null{
 if(typeof target!=='string'||!target||target.length>PASEO_TARGET_MAX||UNSAFE.test(target))return null;
 if(target.startsWith('project:')){const id=target.slice(8);return id&&id.length<=PROJECT_ID_MAX?target:null;}
 if(!/^https?:\/\//.test(target))return null;
 try{const u=new URL(target);return (u.protocol==='http:'||u.protocol==='https:')&&u.hostname?target:null;}catch{return null;}
}

/** Formats an ISO timestamp as Asia/Seoul wall time without relying on Intl data. */
export function formatPaseoBasis(at:unknown):string|null{
 if(typeof at!=='string'||!at)return null;
 const ms=Date.parse(at);if(!Number.isFinite(ms))return null;
 const d=new Date(ms+9*3600_000),p=(n:number)=>String(n).padStart(2,'0');
 if(!Number.isFinite(d.getTime()))return null;
 return `${d.getUTCFullYear()}-${p(d.getUTCMonth()+1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} KST`;
}

export function buildPaseoRequest({target,basisAt}:{target:unknown;basisAt:unknown}):PaseoRequest{
 const basis=formatPaseoBasis(basisAt);
 if(typeof target!=='string'||!target)return {ok:false,reason:'오늘 항목에 연결된 대상이 없어 요청을 만들 수 없어요.',basis};
 const safe=validPaseoTarget(target);
 if(!safe)return {ok:false,reason:'대상 형식이 올바르지 않아 요청을 만들 수 없어요. 데스크톱에서 오늘 항목을 확인해 주세요.',basis};
 if(!basis)return {ok:false,reason:'동기화 시각을 확인할 수 없어 요청을 만들 수 없어요.',basis};
 return {ok:true,target:safe,basis,text:`${PASEO_REQUEST_LEAD}\n대상: ${safe}\n화면 기준 시각: ${basis}`};
}
