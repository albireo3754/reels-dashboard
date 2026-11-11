import { useState } from "react";
import { CloseIcon } from "../../../shared/ui/primitives";
import { STICKER_PRESETS, stickerGuidance, stickerKey, type StickerAnchor, type StickerPlacement } from "../../../shared/blog-stickers";

/** Non-modal right sheet: the writer clicks the manuscript to choose a position while it stays open. */
export function StickerPlanner({ placements, anchors, target, disabled, nativeClipboard, onTarget, onChange, onReveal, onClose }: {
  nativeClipboard?: boolean;
  placements: StickerPlacement[]; anchors: StickerAnchor[]; target: string; disabled: boolean;
  onTarget: (key: string) => void; onChange: (items: StickerPlacement[]) => void; onReveal: (id: string) => void;
  onClose?: () => void;
}) {
  const [copyState, setCopyState] = useState("");
  const anchor = anchors.find(a => stickerKey(a) === target) ?? anchors.find(a => a.label.includes("문단 ·")) ?? anchors[0];
  const occupied = anchor && placements.some(s => stickerKey(s) === stickerKey(anchor));
  const patch = (id: string, values: Partial<StickerPlacement>) => onChange(placements.map(s => s.id === id ? { ...s, ...values } : s));
  const ordered = [...placements].sort((a,b) => anchors.findIndex(p => stickerKey(p) === stickerKey(a)) - anchors.findIndex(p => stickerKey(p) === stickerKey(b)));
  async function copyGuide() {
    const lines = ordered.map((s,i) => {
      const p = STICKER_PRESETS.find(p => p.id === s.preset)!;
      return `${i+1}. ${anchors.find(a => stickerKey(a) === stickerKey(s))?.label}\n   기본 스티커: ${p.label} · ${p.expression}${s.note ? ` / 선택 메모: ${s.note}` : ""}`;
    });
    try {
      const text=["스티커 배치 메모 (현재 화면 기준)", "각 자리에서 SmartEditor 도구 막대 → 스티커 → 기본 목록의 표정을 본문으로 끌어 놓기. 자리 표시를 실제 스티커로 교체하고 중복·간격 확인.", ...lines].join("\n\n");
      if(nativeClipboard){
        const response=await fetch("/api/blog/copy-sticker-plan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({text})});
        if(!response.ok)throw new Error("Copy failed");
      }else await navigator.clipboard.writeText(text);
      setCopyState("현재 배치 메모를 복사했어요.");
    } catch { setCopyState("복사하지 못했어요. 아래 위치 목록을 보고 옮겨주세요."); }
  }
  return <section className="ce-sticker-panel" aria-label="기본 스티커 배치" onKeyDown={e => { if (e.key === "Escape" && onClose) { e.stopPropagation(); onClose(); } }}>
    <header className="ce-sheet-head"><div><h2>스티커 자리</h2><p className="ui-meta">{placements.length}개 배치 · 아이콘은 용도 표시예요</p></div>{onClose && <button className="icon-button" aria-label="스티커 닫기" title="스티커 닫기" onClick={onClose}><CloseIcon /></button>}</header>
    <label className="ce-sticker-target">넣을 위치<select aria-label="새 스티커 위치" value={anchor ? stickerKey(anchor) : ""} disabled={disabled} onChange={e=>onTarget(e.target.value)}>{anchors.map(a=><option key={stickerKey(a)} value={stickerKey(a)}>{a.label}</option>)}</select></label>
    <p className="ce-sticker-hint">본문의 사진·문단을 누르면 그 뒤가 선택돼요.</p>
    <div className="ce-sticker-presets">{STICKER_PRESETS.map(p=><button key={p.id} aria-label={`${p.label} 스티커 자리 추가`} disabled={disabled || !anchor || !!occupied || placements.length>=30} title={p.tip} onClick={()=>{if(anchor)onChange([...placements,{id:crypto.randomUUID(),preset:p.id,bundleId:anchor.bundleId,before:anchor.before}]);}}><span aria-hidden="true">{p.icon}</span><strong>{p.label}</strong><small>{p.placement}</small></button>)}</div>
    {occupied && <p role="status">이 자리에는 이미 스티커가 있어요. 위치를 바꾸거나 아래 스티커의 용도를 바꿔주세요.</p>}
    {stickerGuidance(placements).map(text=><p key={text} className="ce-sticker-hint" role="status">{text}</p>)}
    {ordered.length ? <ol className="ce-sticker-list">{ordered.map((s,i)=><li key={s.id}>
      <strong>{i+1}</strong><label>용도<select aria-label={`스티커 ${i+1} 용도`} value={s.preset} disabled={disabled} onChange={e=>patch(s.id,{preset:e.target.value as StickerPlacement["preset"]})}>{STICKER_PRESETS.map(p=><option key={p.id} value={p.id}>{p.label} · {p.expression}</option>)}</select></label>
      <label className="ce-sticker-position">위치<select aria-label={`스티커 ${i+1} 위치`} value={stickerKey(s)} disabled={disabled} onChange={e=>{const a=anchors.find(a=>stickerKey(a)===e.target.value);if(a)patch(s.id,{bundleId:a.bundleId,before:a.before});}}>{anchors.map(a=><option key={stickerKey(a)} value={stickerKey(a)} disabled={placements.some(other=>other.id!==s.id && stickerKey(other)===stickerKey(a))}>{a.label}</option>)}</select></label>
      <label>선택 메모<input aria-label={`스티커 ${i+1} 선택 메모`} value={s.note??""} maxLength={120} disabled={disabled} placeholder="예: 기본 목록의 손 흔드는 캐릭터" onChange={e=>patch(s.id,{note:e.target.value.replace(/[\r\n]/g," ")})}/></label>
      <button className="small" disabled={disabled} aria-label={`스티커 ${i+1} 위치 보기`} onClick={()=>onReveal(s.id)}>위치 보기</button><button className="small" disabled={disabled} aria-label={`스티커 ${i+1} 삭제`} onClick={()=>onChange(placements.filter(p=>p.id!==s.id))}>삭제</button>
    </li>)}</ol> : <p className="ce-sticker-hint">아직 스티커가 없어요. 모든 묶음에 넣을 필요는 없어요.</p>}
    <details><summary>네이버에서 기본 스티커 넣는 방법</summary><p>저장한 순서대로 본문을 옮긴 뒤, 표시한 위치에서 도구 막대의 <b>스티커</b>를 열어요. 기본 목록에서 위 용도에 맞는 표정을 골라 본문으로 끌어 놓고, 자리 표시를 교체해 주세요. 선택한 캐릭터·표정은 메모로 남겨두면 다시 찾기 쉬워요.</p><p>대시보드는 자리와 선택 메모를 저장해요. 실제 스티커 삽입·발행은 네이버에서 확인해 주세요.</p><a href="https://help.naver.com/service/5593/contents/15529?lang=ko" target="_blank" rel="noreferrer">네이버 공식 스티커 첨부 안내 ↗</a></details>
    <div className="ce-sticker-copy"><button className="secondary small" disabled={!placements.length || disabled} onClick={()=>void copyGuide()}>배치 메모 복사</button><span role="status">{copyState}</span><small className="ui-meta">본문과 함께 자동 저장돼요.</small></div>
  </section>;
}
