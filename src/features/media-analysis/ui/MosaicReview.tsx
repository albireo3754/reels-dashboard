import { useEffect, useRef, useState } from 'react';
import type { AnalysisBridge, MosaicRegion } from '../../../shared/media-analysis';

export function MosaicReview({api, projectId, sampleId, candidates, frame}: {api: AnalysisBridge; projectId: string; sampleId: string; candidates: MosaicRegion[]; frame: boolean}) {
  const [image, setImage] = useState('');
  const [regions, setRegions] = useState<MosaicRegion[]>(() => candidates.map(r => ({...r})));
  const [selected, setSelected] = useState<number>();
  const [blockSize, setBlockSize] = useState(18);
  const [error, setError] = useState('');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const start = useRef<{x:number;y:number} | null>(null);
  useEffect(() => { let live = true; api.mosaicSample(projectId, sampleId).then(v => { if (live) setImage(v); }).catch(e => { if (live) setError(String(e)); }); return () => {live = false;}; }, [api, projectId, sampleId]);
  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {x: Math.max(0, Math.min(1, (event.clientX-bounds.left)/bounds.width)), y: Math.max(0, Math.min(1, (event.clientY-bounds.top)/bounds.height))};
  };
  return <div>
    <p>빨간 상자를 확인하세요. 이미지에서 드래그해 추가하고 상자를 선택해 삭제할 수 있어요. 얼굴 누락을 직접 확인해주세요.{frame ? ' 영상의 이 정지 프레임만 출력하며 영상 전체에는 적용되지 않아요.' : ''}</p>
    {image && <div aria-label="얼굴 영역 미리보기" style={{position:'relative', display:'inline-block', maxWidth:'100%', touchAction:'none', lineHeight:0}} onPointerDown={e => { if(e.target !== e.currentTarget && (e.target as HTMLElement).tagName !== 'IMG') return; start.current = point(e); e.currentTarget.setPointerCapture(e.pointerId); }} onPointerUp={e => { if(!start.current) return; const end=point(e), begin=start.current; start.current=null; const x=Math.min(begin.x,end.x), y=Math.min(begin.y,end.y), width=Math.abs(begin.x-end.x), height=Math.abs(begin.y-end.y); if(width > .005 && height > .005) {setRegions(v => [...v,{x,y,width,height}]); setSelected(regions.length);} }}>
      <img src={image} alt="분석 이미지" draggable={false} style={{display:'block', maxWidth:'100%', maxHeight:500}} />
      {regions.map((r,i) => <button key={i} aria-label={`얼굴 영역 ${i+1}`} onPointerDown={e => e.stopPropagation()} onClick={() => setSelected(i)} style={{position:'absolute', left:`${r.x*100}%`, top:`${r.y*100}%`, width:`${r.width*100}%`, height:`${r.height*100}%`, padding:0, border:`${selected===i ? 4 : 2}px solid ${selected===i ? 'yellow' : 'red'}`, background:'transparent', cursor:'pointer'}} />)}
    </div>}
    <p>선택한 영역: {selected === undefined ? '없음' : selected + 1} / {regions.length}개 <button disabled={selected === undefined} onClick={() => {setRegions(v => v.filter((_,i) => i !== selected)); setSelected(undefined);}}>선택 영역 삭제</button></p>
    <label>모자이크 강도 <input type="range" min={4} max={100} value={blockSize} onChange={e => setBlockSize(Number(e.target.value))} /> {blockSize}px</label>
    <button disabled={busy || !image} onClick={async () => {setBusy(true); setError(''); try {const result=await api.mosaicExport({projectId,sampleId,regions,blockSize}); if(result) setOutput(result);} catch(e) {setError(String(e));} finally {setBusy(false);}}}>모자이크 사본 저장</button>
    {output && <p role="status">저장됨: {output} · 영역 설정도 함께 저장했어요. 완성 이미지를 확인해주세요.</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
