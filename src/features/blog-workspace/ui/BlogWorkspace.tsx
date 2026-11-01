import {useEffect,useRef,useState} from 'react';
import type {BlogBlock,BlogBridge,BlogDraft,BlogSpan,BlogStyle} from '../../../shared/blog';
import type {Project} from '../../../shared/contracts';
import type {ContentMediaBridge,ContentMediaItem} from '../../../shared/content-media';
import './blog.css';
import {BlogReferences} from './BlogReferences';
import {importSpec} from '../model/import-spec';

function Rich({text,spans=[]}:{text:string;spans?:BlogSpan[]}) {
  const matches: Array<{start:number;end:number;span?:BlogSpan;bold?:boolean;href?:string;label?:string}>=[];
  for(const m of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gi)) {try {const url=new URL(m[2]);if(url.protocol!=='http:'&&url.protocol!=='https:')continue;matches.push({start:m.index!,end:m.index!+m[0].length,href:url.href,label:m[1]});} catch {/* Invalid links remain plain text. */}}
  for(const span of spans) {let at=0;while((at=text.indexOf(span.text,at))>=0){if(!matches.some(m=>at<m.end&&at+span.text.length>m.start))matches.push({start:at,end:at+span.text.length,span});at+=span.text.length;if(span.occurrence==='first')break;}}
  for(const m of text.matchAll(/\*\*([^*]+)\*\*/g)) {const start=m.index!;if(!matches.some(v=>start<v.end&&start+m[0].length>v.start))matches.push({start,end:start+m[0].length,bold:true});}
  matches.sort((a,b)=>a.start-b.start);const parts:React.ReactNode[]=[];let cursor=0;
  for(const m of matches){parts.push(text.slice(cursor,m.start));const value=text.slice(m.start,m.end);parts.push(m.href?<a key={m.start} href={m.href} target="_blank" rel="noopener noreferrer">{m.label}</a>:m.bold?<strong key={m.start}>{value.slice(2,-2)}</strong>:<span key={m.start} style={{color:m.span?.color,backgroundColor:m.span?.background,fontWeight:m.span?.weight}}>{value}</span>);cursor=m.end;}parts.push(text.slice(cursor));return <>{parts}</>;
}
function TextBlock({block}:{block:Extract<BlogBlock,{type:'text'}>}) {
 const content=<Rich text={block.text} spans={block.spans}/>;
 if(block.role==='title')return <h2 className="blog-title">{content}</h2>;
 if(block.role==='heading')return <h3 className="blog-heading">{content}</h3>;
 if(block.role==='info')return <p className="blog-info">{content}</p>;
 if(block.role==='source')return <p className="blog-source">{content}</p>;
 if(block.role==='native')return <aside className="blog-native">네이버 전용 요소 자리 표시 · {content}</aside>;
 if(block.role==='tags')return <p className="blog-tags">{content}</p>;
 return <p>{content}</p>;
}
function markdownBlocks(text:string):BlogBlock[] {return text.split(/\n\s*\n/).filter(Boolean).map(part=>{const heading=part.match(/^#{1,6}\s+([^\n]+)$/);return {id:crypto.randomUUID(),type:'text' as const,text:heading?heading[1]:part,role:heading?'heading' as const:'paragraph' as const};});}

function PreviewBlocks({blocks,api,projectId}:{blocks:BlogBlock[];api:ContentMediaBridge;projectId:string}) {
  const rendered:React.ReactNode[]=[];
  for(let i=0;i<blocks.length;i++){const b=blocks[i];if(b.type==='text'&&b.role==='info') {const group:Extract<BlogBlock,{type:'text'}>[]=[];while(i<blocks.length){const next=blocks[i];if(next.type!=='text'||(next.role!=='info'&&next.role!=='source'))break;group.push(next);i++;}i--;rendered.push(<section className="blog-info-card" aria-label="방문 정보" key={b.id}>{group.map(item=><TextBlock key={item.id} block={item}/>)}</section>);}else rendered.push(b.type==='text'?<TextBlock key={b.id} block={b}/>:<Photo key={b.id} api={api} projectId={projectId} path={b.path} alt={b.alt}/>);}
  return <>{rendered}</>;
}
function Photo({api,projectId,path,alt}:{api:ContentMediaBridge;projectId:string;path:string;alt:string}) {
  const [url,setUrl]=useState(''); const [error,setError]=useState(false);
  useEffect(()=>{let live=true;setUrl('');setError(false);api.open(projectId,path).then(v=>{if(live && v.kind==='image')setUrl(v.url);}).catch(()=>{if(live)setError(true);});return()=>{live=false;};},[api,projectId,path]);
  return error?<p>연결된 사진을 읽지 못했어요.</p>:url?<img src={url} alt={alt}/>:<p>사진 불러오는 중…</p>;
}
export function BlogWorkspace({api,media,projects}:{api?:BlogBridge;media?:ContentMediaBridge;projects:Project[]}) {
  const [mode,setMode]=useState<'draft'|'reference'>('draft');
  const [sourceTools,setSourceTools]=useState(true);
  const [projectId,setProjectId]=useState(''); const project=projects.find(p=>p.id===projectId);
  const [draft,setDraft]=useState<BlogDraft>(); const [dirty,setDirty]=useState(false); const [busy,setBusy]=useState(false);
  const [documentPath,setDocumentPath]=useState(''); const [text,setText]=useState(''); const [error,setError]=useState(''); const [notice,setNotice]=useState('');
  const [pending,setPending]=useState<{blocks:BlogBlock[];style:BlogStyle}>();
  const [folder,setFolder]=useState(''); const [items,setItems]=useState<ContentMediaItem[]>([]); const [next,setNext]=useState<number|null>(null); const [mobile,setMobile]=useState(true);
  const textRef=useRef<HTMLTextAreaElement>(null); const documents=project?.resources?.filter(r=>r.role==='document' && /\.md$/i.test(r.path))??[];
  const folders=project?.resources?.filter(r=>r.role==='folder')??[];
  useEffect(()=>{const listener=(e:BeforeUnloadEvent)=>{if(dirty){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',listener);return()=>window.removeEventListener('beforeunload',listener);},[dirty]);
  const switchProject=async(id:string)=>{if(dirty && !window.confirm('저장하지 않은 블로그 배치를 버리고 프로젝트를 바꿀까요?'))return;setError('');setNotice('');setBusy(true);try{const result=id?await api!.load(id):undefined;setProjectId(id);setDraft(result);setSourceTools(!result?.blocks.length);setDirty(false);setDocumentPath('');setText('');setPending(undefined);setFolder('');setItems([]);setNext(null);}catch(e){setError(String(e));}finally{setBusy(false);}};
  const change=(blocks:BlogBlock[])=>{if(draft && !busy){setDraft({...draft,blocks});setDirty(true);setNotice('');}};
  const list=async(directory:string,offset=0)=>{if(!projectId || !media)return;try{const page=await media.list(projectId,directory||undefined,offset);setItems(offset?old=>[...old,...page.items]:page.items);setNext(page.nextOffset);}catch(e){setError(String(e));}};
  if(!api || !media)return <section className="blog-workspace"><p>블로그 작업은 데스크톱 앱에서 사용할 수 있어요.</p></section>;
  return <section className="blog-workspace" aria-label="블로그 작업">
    <h2>블로그 작업</h2><div className="blog-reference-toolbar"><button disabled={busy||!api.openCanonical} onClick={async()=>{setBusy(true);setError('');try{await api.openCanonical?.();}catch(e){setError(String(e));}finally{setBusy(false);}}}>정본 스마트 에디터 열기</button><button aria-pressed={mode==='draft'} onClick={()=>setMode('draft')}>원고·배치</button><button aria-pressed={mode==='reference'} onClick={()=>setMode('reference')}>레퍼런스 추출·탐색</button></div><div hidden={mode!=='reference'}><BlogReferences api={api}/></div><div hidden={mode!=='draft'}><p>기존 프로젝트의 원고와 사진을 골라 배치해요. 원고 파일은 수정하지 않으며, 이 화면에서 선택한 내용만 미리보기에 들어가요.</p>
    <label>프로젝트 <select aria-label="블로그 프로젝트" value={projectId} disabled={busy} onChange={e=>void switchProject(e.target.value)}><option value="">프로젝트 선택</option>{projects.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select></label>
    {project && draft && <>
      <details className="blog-source-tools" open={sourceTools} onToggle={e=>setSourceTools(e.currentTarget.open)}><summary>원고·사진 가져오기 및 블록 배치</summary><div className="blog-columns"><div>
        <h3>원고에서 가져오기</h3><p>기록 전체가 게시 본문은 아니에요. 아래에서 필요한 구간만 직접 선택해 추가해주세요.</p>
        <label>연결된 Markdown <select aria-label="블로그 원고" value={documentPath} onChange={e=>{setDocumentPath(e.target.value);setText('');}}><option value="">문서 선택</option>{documents.map(r=><option key={r.path} value={r.path}>{r.label}</option>)}</select></label>
        <button disabled={!documentPath||busy} onClick={async()=>{setBusy(true);setError('');try{setText((await api.readDocument(projectId,documentPath)).text);}catch(e){setError(String(e));}finally{setBusy(false);}}}>원고 열기</button>
        {!documents.length && <p>프로젝트에 Markdown 문서를 먼저 연결해주세요.</p>}
        {text && <><textarea ref={textRef} aria-label="원고 내용 선택" readOnly value={text}/><button onClick={()=>{const el=textRef.current;if(!el)return;const selected=el.value.slice(el.selectionStart,el.selectionEnd).trim();if(!selected){setError('원고에서 가져올 구간을 선택해주세요.');return;}if(selected.length>20000){setError('선택 구간은 2만 자 이하로 나눠주세요.');return;}change([...draft.blocks,...markdownBlocks(selected)]);setError('');}}>선택한 구간 추가</button><button onClick={()=>{const el=textRef.current;if(!el)return;const selected=el.value.slice(el.selectionStart,el.selectionEnd).trim();if(!selected){setError('render-spec JSON 또는 코드 블록을 선택해주세요.');return;}try{setPending(importSpec(selected,folder,()=>crypto.randomUUID()));setError('');}catch(e){setError(String(e));}}}>선택한 render-spec 가져오기</button></>}
        {pending && <section className="blog-import-review"><h4>가져올 블록 {pending.blocks.length}개 확인</h4><p>선택한 명세에서 가져온 내용이에요. 비공개 내용이 없는지 확인한 후 적용해주세요.</p><ol>{pending.blocks.map(b=><li key={b.id}>{b.type==='text'?b.text:b.alt}</li>)}</ol><button disabled={busy} onClick={()=>{if(draft.blocks.length+pending.blocks.length>300){setError('블록은 300개까지 넣을 수 있어요.');return;}setDraft({...draft,blocks:[...draft.blocks,...pending.blocks],style:pending.style});setDirty(true);setPending(undefined);}}>확인하고 배치에 추가</button><button onClick={()=>setPending(undefined)}>가져오기 취소</button></section>}
        <h3>연결된 사진 추가</h3><label>사진 폴더 <select aria-label="블로그 사진 폴더" value={folder} onChange={e=>{setFolder(e.target.value);void list(e.target.value);}}><option value="">연결 자료</option>{folders.map(r=><option key={r.path} value={r.path}>{r.label}</option>)}</select></label><button onClick={()=>void list(folder)}>사진 불러오기</button>
        <div className="blog-media">{items.filter(i=>i.kind==='image').map(i=><button key={i.path} onClick={()=>change([...draft.blocks,{id:crypto.randomUUID(),type:'image',path:i.path,alt:i.label}])}>{i.label} 추가</button>)}</div>{next!==null && <button onClick={()=>void list(folder,next)}>사진 더 보기</button>}
      </div><div>
        <h3>배치 {dirty?'· 저장 전':''}</h3><p>순서를 조정하고 저장하면 이 기기의 비공개 초안으로 남아요.</p>
        {draft.blocks.map((b,i)=><div className="blog-block" key={b.id}><span>{i+1}. {b.type==='text'?b.text.slice(0,80):b.alt}</span><div><button aria-label={`${i+1} 위로`} disabled={i===0} onClick={()=>{const v=[...draft.blocks];[v[i-1],v[i]]=[v[i],v[i-1]];change(v);}}>↑</button><button aria-label={`${i+1} 아래로`} disabled={i===draft.blocks.length-1} onClick={()=>{const v=[...draft.blocks];[v[i],v[i+1]]=[v[i+1],v[i]];change(v);}}>↓</button><button aria-label={`${i+1} 삭제`} onClick={()=>change(draft.blocks.filter((_,j)=>j!==i))}>삭제</button></div></div>)}
        <button disabled={!dirty||busy} onClick={async()=>{setBusy(true);setError('');try{const saved=await api.save(draft);setDraft(saved);setDirty(false);setNotice('배치를 저장했어요.');}catch(e){setError(String(e));}finally{setBusy(false);}}}>배치 저장</button>
        <button disabled={busy} onClick={async()=>{if(dirty&&!window.confirm('저장하지 않은 배치를 버리고 다시 불러올까요?'))return;setBusy(true);try{setDraft(await api.load(projectId));setDirty(false);setNotice('저장된 배치를 불러왔어요.');}catch(e){setError(String(e));}finally{setBusy(false);}}}>저장된 배치 불러오기</button>
      </div></div></details>
      <h3>미리보기</h3><button onClick={()=>setMobile(!mobile)}>{mobile?'PC 폭 보기':'모바일 폭 보기'}</button><p>네이버 실제 편집기와 다를 수 있어요. 지정한 글꼴이 기기에 없으면 대체 글꼴로 보여요. 지도·질문 카드와 게시 기능은 포함하지 않아요.</p>
      <article className={`blog-preview ${mobile?'blog-preview-mobile':''}`} style={{backgroundColor:draft.style?.background,color:draft.style?.color,fontFamily:draft.style?.bodyFont ? `"${draft.style.bodyFont}", sans-serif` : undefined,fontSize:mobile?draft.style?.mobileParagraphSize:draft.style?.paragraphSize,lineHeight:draft.style?.lineHeight,textAlign:draft.style?.align,maxWidth:mobile?draft.style?.mobileWidth:draft.style?.desktopWidth,padding:draft.style?.padding, '--blog-heading-weight':draft.style?.headingWeight,'--blog-image-radius':draft.style?.imageRadius === undefined ? undefined : `${draft.style.imageRadius}px`, '--blog-heading-color':draft.style?.headingColor,'--blog-heading-size':draft.style?.headingSize ? `${draft.style.headingSize}px` : undefined,'--blog-info-font':draft.style?.infoFont ? `"${draft.style.infoFont}", sans-serif` : undefined} as React.CSSProperties}><PreviewBlocks blocks={draft.blocks} api={media} projectId={projectId}/></article>
    </>}
    </div>
    {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
  </section>;
}
