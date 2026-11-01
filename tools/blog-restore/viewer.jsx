import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {TemplateBlock} from '../blog-preview/TemplateEngine.jsx';
import {blockKind, summarizeBlock, sourceValues, NON_AUTHOR_KINDS} from '../../src/shared/blog-restore';
import '../blog-preview/style.css';
import './viewer.css';

function anchorLink(pageUrl, anchor) { if (!anchor) return null; const u = new URL(pageUrl); u.hash = anchor; return u.href; }

function Restore({templates, report}) {
  const params = new URLSearchParams(location.search);
  const [author, setAuthor] = useState(() => Math.min(Math.max(Number(params.get('author')) || 0, 0), templates.length - 1)), [flow, setFlow] = useState(true), [selected, setSelected] = useState(null), [zoom, setZoom] = useState(1);
  const [showText, setShowText] = useState(params.get('text') !== '0'), [showImages, setShowImages] = useState(params.get('images') !== '0');
  const t = templates[author], rep = report?.entries?.find(e => e.templateId === t.id), fid = rep?.fidelity;
  useEffect(() => { document.body.dataset.restoreReady = `${author}:${flow}:${showText}:${showImages}`; }, [author, flow, showText, showImages]);
  return <div className="restore">
    <nav className="restore-nav"><b>레퍼런스 복원</b>{templates.map((x, i) => <button key={x.id} className={i === author ? 'active' : ''} onClick={() => { setAuthor(i); setSelected(null); }}>{x.name}</button>)}
      <label><input type="checkbox" checked={showText} onChange={e => setShowText(e.target.checked)}/> 원문 글</label>
      <label><input type="checkbox" checked={showImages} onChange={e => setShowImages(e.target.checked)}/> 원본 사진(URL)</label>
      <label><input type="checkbox" checked={flow} onChange={e => setFlow(e.target.checked)}/> 글 길이로 높이 재계산</label>
      <label>배율 <select value={zoom} onChange={e => setZoom(Number(e.target.value))}><option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option></select></label>
      {rep && <a href={rep.url} target="_blank" rel="noopener noreferrer">원본 새 창</a>}</nav>
    <p className="restore-notice">원본 DOM 트리·계산 서식을 현재 TemplateEngine 컴포넌트로 다시 그린 화면이에요. 글은 {showText ? '원문' : '길이·문장부호만 보존한 가림 문자'}, 사진은 {showImages ? '원본 CDN URL을 볼 때마다 불러와요(파일 미저장)' : '자리표시'}. {rep && <>관찰 {rep.capturedAt} · 뷰포트 {rep.viewport.width}×{rep.viewport.height} · 폭 {Math.round(t.referenceWidth)}px</>}</p>
    {fid && <p className="restore-summary" data-testid="fidelity-summary">높이 ±5% 이내 {fid.summary.within5pct}/{fid.summary.measured} · ±15% 이내 {fid.summary.within15pct}/{fid.summary.measured} · 제외 {fid.summary.excluded.map(x => `#${x.order + 1} ${x.kind}`).join(', ') || '없음'} · 총높이 원본 {fid.summary.originalTotalHeight}px / 복원 {fid.summary.restoredTotalHeight}px{rep.warnings?.length ? ` · 경고 ${rep.warnings.length}` : ''}</p>}
    <div className="restore-grid">
      <div className="restore-canvas"><div className="template-surface" style={{width: t.referenceWidth, zoom}} data-restore-surface>
        {t.blocks.map((b, i) => <div key={b.id} data-restore-block={i} className={selected === i ? 'restore-selected' : ''} onClick={() => setSelected(i)}>{NON_AUTHOR_KINDS.includes(blockKind(b.sourceClass)) ? null : <TemplateBlock block={b} values={sourceValues(b, {text: showText, images: showImages})} flow={flow} example={true}/>}</div>)}
      </div></div>
      <details className="restore-index"><summary>블록 목차 · {t.blocks.length}개</summary><div className="restore-table"><table><thead><tr><th>#</th><th>종류</th><th>원본 높이</th><th>복원</th><th>글자</th><th>사진</th></tr></thead><tbody>
        {t.blocks.map((b, i) => { const s = summarizeBlock(b), row = fid?.blocks[i], off = row && fid.summary.outliers.some(o => o.order === i); const link = rep && anchorLink(rep.pageUrl, b.sourceAnchor);
          return <tr key={b.id} className={(selected === i ? 'active ' : '') + (off ? 'off' : '')} onClick={() => { setSelected(i); document.querySelector(`[data-restore-block="${i}"]`)?.scrollIntoView({block: 'center'}); }}>
            <td>{link ? <a href={link} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>{i + 1}</a> : i + 1}</td><td>{blockKind(b.sourceClass)}</td><td>{row?.originalHeight ?? Math.round(b.rect?.height ?? 0)}</td><td>{row ? `${row.restoredHeight} (${row.ratio})` : '-'}</td><td>{s.characters}</td><td>{s.images}{s.unloadedImages ? ` (미로딩 ${s.unloadedImages})` : ''}</td></tr>; })}
      </tbody></table></div></details>
    </div>
  </div>;
}

const root = createRoot(document.getElementById('root'));
Promise.all([fetch('./reference-templates.json').then(r => r.json()), fetch('./restore-report.json').then(r => r.ok ? r.json() : null).catch(() => null)])
  .then(([templates, report]) => { if (!Array.isArray(templates) || !templates.length) throw new Error('reference-templates.json 비어 있음'); root.render(<Restore templates={templates} report={report}/>); })
  .catch(e => root.render(<p role="alert">복원 화면을 열지 못했어요: {e.message}</p>));
