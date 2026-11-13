import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {BlogBlock,BlogBridge,BlogDraft,BlogSpan,BlogStyle,CanonicalEditorTab} from '../../../shared/blog';
import type {Project} from '../../../shared/contracts';
import type {ContentMediaBridge,ContentMediaItem} from '../../../shared/content-media';
import './blog.css';
import {BlogReferences} from './BlogReferences';
import {BlogProjects} from './BlogProjects';
import {importSpec} from '../model/import-spec';
import {blogTerminalContext} from '../model/terminal-context';
import {BlogTerminal} from './BlogTerminal';
import {Button,CloseIcon,Notice,Spacer,Toolbar} from '../../../shared/ui/primitives';
import {DocumentIcon} from './icons';

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
/**
 * Project editors live in this tab as iframes, one per opened project, each on its own
 * loopback server. They have no preload or bridge (the dashboard main process accepts IPC
 * from its main frame only) and stay mounted until their tab is closed, so switching tabs
 * or menus keeps unsaved edits.
 */
const EDITOR_SANDBOX='allow-scripts allow-same-origin allow-forms allow-modals allow-popups';
const editorKey=(projectId:string)=>`editor:${projectId}`;
/** DOM id용(aria-controls). 프로젝트 id에 공백·특수문자가 있어도 안전하게. */
const domId=(projectId:string)=>projectId.replace(/[^\w-]/g,'_');
/**
 * In-flow space the page keeps below the editor host: bottom padding/border of each ancestor up to the
 * page column (.main) plus any visible siblings after it. With the terminal panel open the shell pads
 * .main by --terminal-height + 24px while the editor only reserves --terminal-height + 12px, so the
 * host cancels the difference with a negative margin (blog.css) and the dashboard page never scrolls
 * under the editor, which scrolls on its own (one scroll).
 */
function spaceBelow(host:HTMLElement){
  let below=0;
  for(let el:HTMLElement|null=host;el&&el!==document.body;el=el.parentElement){
    for(let sib=el.nextElementSibling;sib;sib=sib.nextElementSibling){
      const style=getComputedStyle(sib);
      if(style.display==='none'||style.position==='fixed'||style.position==='absolute')continue;
      below+=sib.getBoundingClientRect().height+parseFloat(style.marginTop)+parseFloat(style.marginBottom);
    }
    if(el===host)continue;
    const style=getComputedStyle(el);
    below+=parseFloat(style.paddingBottom)+parseFloat(style.borderBottomWidth);
    if(el.classList.contains('main'))break;
  }
  return Math.round(below);
}
function EmbeddedEditors({editors,mode}:{editors:CanonicalEditorTab[];mode:string}){
  const host=useRef<HTMLDivElement>(null);
  const active=editors.some(tab=>mode===editorKey(tab.projectId));
  // The frame fills the window below the tab row; --blog-editor-reserve (styles.css) keeps it clear of the
  // terminal panel and --blog-editor-below lets the host cancel the page's own bottom padding.
  // Re-measured on resize and whenever the workspace or the page column changes size (tab row wraps,
  // a notice appears, the terminal opens, folds or is resized).
  useLayoutEffect(()=>{
    if(!active)return;
    const el=host.current;
    if(!el)return;
    const set=(name:string,value:string)=>{if(el.style.getPropertyValue(name)!==value)el.style.setProperty(name,value);};
    const measure=()=>{
      if(el.offsetParent===null)return;
      set('--blog-editor-top',`${Math.round(el.getBoundingClientRect().top+window.scrollY)}px`);
      set('--blog-editor-below',`${spaceBelow(el)}px`);
    };
    let frame=0;
    const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure);};
    measure();
    window.addEventListener('resize',measure);
    const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(schedule);
    const workspace=el.closest<HTMLElement>('.blog-workspace'),page=el.closest<HTMLElement>('.main');
    if(workspace)observer?.observe(workspace);
    if(page)observer?.observe(page,{box:'border-box'});
    return()=>{window.removeEventListener('resize',measure);observer?.disconnect();cancelAnimationFrame(frame);};
  },[active,editors.length]);
  return <div className="blog-editor-host" ref={host} hidden={!active}>
    {editors.map(tab=><iframe key={tab.projectId} id={`blog-editor-${domId(tab.projectId)}`} role="tabpanel" aria-labelledby={`blog-tab-editor-${domId(tab.projectId)}`} className="blog-editor-frame" hidden={mode!==editorKey(tab.projectId)} src={tab.url} title={`${tab.title} 스마트에디터`} data-blog-editor={tab.projectId} sandbox={EDITOR_SANDBOX} referrerPolicy="no-referrer"/>)}
  </div>;
}

const MODES=[{value:'projects',label:'프로젝트'},{value:'draft',label:'원고·배치'},{value:'reference',label:'레퍼런스 추출·탐색'}] as const;

/**
 * 모드 탭(프로젝트·원고·배치·레퍼런스)과 열린 문서 탭을 한 tablist에 둔다. 둘 사이는 hairline으로 나눈다.
 * 선택 탭만 tabIndex 0이고 ←→/Home/End로 이동하며 바로 고른다. 문서 탭의 ×는 탭 옆 별도 버튼이다.
 */
function WorkspaceTabs({mode,editors,closing,onSelect,onClose}:{mode:string;editors:CanonicalEditorTab[];closing:string;onSelect:(mode:string)=>void;onClose:(tab:CanonicalEditorTab)=>void}){
  return <div role="tablist" aria-label="블로그 화면" className="ui-tabs blog-workspace-tabs" onKeyDown={event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const tabs=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')].filter(el=>!el.disabled);
    const at=tabs.indexOf(document.activeElement as HTMLButtonElement);
    if(!tabs.length||at<0)return;
    const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:(at+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;
    event.preventDefault();tabs[next].focus();onSelect(tabs[next].dataset.mode!);
  }}>
    {MODES.map(item=><button key={item.value} type="button" role="tab" id={`blog-tab-${item.value}`} aria-controls={`blog-panel-${item.value}`} aria-selected={mode===item.value} tabIndex={mode===item.value?0:-1} data-mode={item.value} onClick={()=>onSelect(item.value)}>{item.label}</button>)}
    {editors.length>0&&<span className="blog-tabs-divider" aria-hidden="true"/>}
    {editors.map(tab=>{
      const key=editorKey(tab.projectId),selected=mode===key;
      return <div className="blog-doc-tab" key={tab.projectId} data-selected={selected||undefined}
        onAuxClick={event=>{if(event.button===1&&closing!==tab.projectId){event.preventDefault();onClose(tab);}}}>
        <button type="button" role="tab" id={`blog-tab-editor-${domId(tab.projectId)}`} aria-controls={`blog-editor-${domId(tab.projectId)}`} aria-selected={selected} tabIndex={selected?0:-1} data-mode={key} title={tab.title} onClick={()=>onSelect(key)}>
          <DocumentIcon/><span className="blog-doc-tab-title">{tab.title}</span>
        </button>
        <button type="button" className="icon-button small blog-doc-tab-close" aria-label={`${tab.title} 탭 닫기`} title="탭 닫기" disabled={closing===tab.projectId} onClick={()=>onClose(tab)}><CloseIcon/></button>
      </div>;
    })}
  </div>;
}

export function BlogWorkspace({api,media,projects,active=true,onStartTerminal}:{api?:BlogBridge;media?:ContentMediaBridge;projects:Project[];
  /** 블로그 탭이 보이는지. 프로젝트 목록은 보일 때 다시 읽는다. */
  active?:boolean;
  /** @deprecated 터미널 패널은 상단 툴바의 터미널 버튼·⌘N으로 연다. 호환을 위해 받기만 한다. */
  onOpenTerminal?:()=>void;onStartTerminal?:(task:string,permission:import('../../../shared/workbench').AgentPermission)=>Promise<void>}) {
  const [mode,setMode]=useState<string>('projects');
  const [editors,setEditors]=useState<CanonicalEditorTab[]>([]);
  const [closingEditor,setClosingEditor]=useState('');
  const openEditor=(tab:CanonicalEditorTab)=>{setEditors(old=>old.some(e=>e.projectId===tab.projectId)?old:[...old,tab]);setMode(editorKey(tab.projectId));};
  const closeEditor=async(tab:CanonicalEditorTab)=>{
    setClosingEditor(tab.projectId);setError('');
    try{
      const result=await api!.closeCanonical?.(tab.projectId)??{close:true};
      if(!result.close)return;
      setEditors(old=>old.filter(e=>e.projectId!==tab.projectId));
      setMode(current=>current===editorKey(tab.projectId)?'projects':current);
    }catch(e){setError(String(e));}finally{setClosingEditor('');}
  };
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
  if(!api || !media)return <section className="blog-workspace"><p className="ui-meta blog-empty">블로그 작업은 데스크톱 앱에서 사용할 수 있어요.</p></section>;
  const view=mode.startsWith('editor:')?'editor':mode;
  return <section className="blog-workspace" aria-label="블로그 작업" data-view={view}>
    <div className="blog-workspace-header">
      <h2>블로그 작업</h2>
      <WorkspaceTabs mode={mode} editors={editors} closing={closingEditor} onSelect={setMode} onClose={tab=>void closeEditor(tab)}/>
      {onStartTerminal&&<BlogTerminal context={blogTerminalContext({mode,editors,project,dirty})} onStart={onStartTerminal}/>}
    </div>
    {/* 상태·오류는 패널 위에 둔다. 편집기 탭은 창 높이를 채우므로 아래에 두면 보이지 않는다. */}
    {notice&&<p role="status" className="ui-meta blog-notice">{notice}</p>}{error&&<Notice tone="danger" className="blog-error">{error}</Notice>}
    <div role="tabpanel" id="blog-panel-projects" aria-labelledby="blog-tab-projects" hidden={mode!=='projects'}><BlogProjects api={api} onOpen={openEditor} openIds={editors.map(e=>e.projectId)} active={active&&mode==='projects'} revision={projects}/></div>
    <EmbeddedEditors editors={editors} mode={mode}/>
    <div role="tabpanel" id="blog-panel-reference" aria-labelledby="blog-tab-reference" hidden={mode!=='reference'}><BlogReferences api={api}/></div>
    <div role="tabpanel" id="blog-panel-draft" aria-labelledby="blog-tab-draft" className="blog-draft" hidden={mode!=='draft'}>
    <Toolbar className="blog-draft-bar">
      <select aria-label="블로그 프로젝트" className="ui-inline" value={projectId} disabled={busy} onChange={e=>void switchProject(e.target.value)}><option value="">프로젝트 선택</option>{projects.map(p=><option key={p.id} value={p.id}>{p.title}</option>)}</select>
    </Toolbar>
    {!project&&<p className="ui-meta blog-empty" title="원고 파일은 수정하지 않으며, 이 화면에서 선택한 내용만 미리보기에 들어가요.">프로젝트를 고르면 원고와 사진을 골라 배치할 수 있어요.</p>}
    {project && draft && <>
      <details className="blog-source-tools" open={sourceTools} onToggle={e=>setSourceTools(e.currentTarget.open)}><summary>원고·사진 가져오기 및 블록 배치</summary><div className="blog-columns"><div>
        <h3>원고에서 가져오기</h3><p className="ui-meta">기록 전체가 본문은 아니에요. 필요한 구간만 선택해 추가하세요.</p>
        <div className="blog-field-row"><label>연결된 Markdown <select aria-label="블로그 원고" value={documentPath} onChange={e=>{setDocumentPath(e.target.value);setText('');}}><option value="">문서 선택</option>{documents.map(r=><option key={r.path} value={r.path}>{r.label}</option>)}</select></label>
        <Button variant="secondary" size="large" disabled={!documentPath||busy} onClick={async()=>{setBusy(true);setError('');try{setText((await api.readDocument(projectId,documentPath)).text);}catch(e){setError(String(e));}finally{setBusy(false);}}}>원고 열기</Button></div>
        {!documents.length && <p className="ui-meta">프로젝트에 Markdown 문서를 먼저 연결해주세요.</p>}
        {text && <><textarea ref={textRef} className="blog-source-text" aria-label="원고 내용 선택" readOnly value={text}/><div className="blog-actions"><Button onClick={()=>{const el=textRef.current;if(!el)return;const selected=el.value.slice(el.selectionStart,el.selectionEnd).trim();if(!selected){setError('원고에서 가져올 구간을 선택해주세요.');return;}if(selected.length>20000){setError('선택 구간은 2만 자 이하로 나눠주세요.');return;}change([...draft.blocks,...markdownBlocks(selected)]);setError('');}}>선택한 구간 추가</Button><Button onClick={()=>{const el=textRef.current;if(!el)return;const selected=el.value.slice(el.selectionStart,el.selectionEnd).trim();if(!selected){setError('render-spec JSON 또는 코드 블록을 선택해주세요.');return;}try{setPending(importSpec(selected,folder,()=>crypto.randomUUID()));setError('');}catch(e){setError(String(e));}}}>선택한 render-spec 가져오기</Button></div></>}
        {pending && <section className="blog-import-review"><h4>가져올 블록 {pending.blocks.length}개 확인</h4><p className="ui-meta">비공개 내용이 없는지 확인한 뒤 적용하세요.</p><ol>{pending.blocks.map(b=><li key={b.id}>{b.type==='text'?b.text:b.alt}</li>)}</ol><div className="blog-actions"><Button variant="secondary" disabled={busy} onClick={()=>{if(draft.blocks.length+pending.blocks.length>300){setError('블록은 300개까지 넣을 수 있어요.');return;}setDraft({...draft,blocks:[...draft.blocks,...pending.blocks],style:pending.style});setDirty(true);setPending(undefined);}}>확인하고 배치에 추가</Button><Button onClick={()=>setPending(undefined)}>가져오기 취소</Button></div></section>}
        <h3>연결된 사진 추가</h3><div className="blog-field-row"><label>사진 폴더 <select aria-label="블로그 사진 폴더" value={folder} onChange={e=>{setFolder(e.target.value);void list(e.target.value);}}><option value="">연결 자료</option>{folders.map(r=><option key={r.path} value={r.path}>{r.label}</option>)}</select></label><Button variant="secondary" size="large" onClick={()=>void list(folder)}>사진 불러오기</Button></div>
        <div className="blog-media">{items.filter(i=>i.kind==='image').map(i=><Button size="small" key={i.path} onClick={()=>change([...draft.blocks,{id:crypto.randomUUID(),type:'image',path:i.path,alt:i.label}])}>{i.label} 추가</Button>)}</div>{next!==null && <Button size="small" onClick={()=>void list(folder,next)}>사진 더 보기</Button>}
      </div><div>
        <h3>배치 {dirty?'· 저장 전':''}</h3><p className="ui-meta">저장하면 이 기기의 비공개 초안으로 남아요.</p>
        <ol className="blog-block-list">{draft.blocks.map((b,i)=><li className="blog-block" key={b.id}><span>{i+1}. {b.type==='text'?b.text.slice(0,80):b.alt}</span><div className="blog-block-actions"><button className="small" aria-label={`${i+1} 위로`} disabled={i===0} onClick={()=>{const v=[...draft.blocks];[v[i-1],v[i]]=[v[i],v[i-1]];change(v);}}>↑</button><button className="small" aria-label={`${i+1} 아래로`} disabled={i===draft.blocks.length-1} onClick={()=>{const v=[...draft.blocks];[v[i],v[i+1]]=[v[i+1],v[i]];change(v);}}>↓</button><button className="small" aria-label={`${i+1} 삭제`} onClick={()=>change(draft.blocks.filter((_,j)=>j!==i))}>삭제</button></div></li>)}</ol>
        <div className="blog-actions">
        <Button variant="primary" disabled={!dirty||busy} onClick={async()=>{setBusy(true);setError('');try{const saved=await api.save(draft);setDraft(saved);setDirty(false);setNotice('배치를 저장했어요.');}catch(e){setError(String(e));}finally{setBusy(false);}}}>배치 저장</Button>
        <Button disabled={busy} onClick={async()=>{if(dirty&&!window.confirm('저장하지 않은 배치를 버리고 다시 불러올까요?'))return;setBusy(true);try{setDraft(await api.load(projectId));setDirty(false);setNotice('저장된 배치를 불러왔어요.');}catch(e){setError(String(e));}finally{setBusy(false);}}}>저장된 배치 불러오기</Button>
        </div>
      </div></div></details>
      <Toolbar className="blog-preview-bar">
        <h3>미리보기</h3>
        <span className="ui-meta ui-truncate" title="지정한 글꼴이 기기에 없으면 대체 글꼴로 보여요. 지도·질문 카드와 게시 기능은 포함하지 않아요.">네이버 실제 편집기와 다를 수 있어요</span>
        <Spacer/>
        <Button onClick={()=>setMobile(!mobile)}>{mobile?'PC 폭 보기':'모바일 폭 보기'}</Button>
      </Toolbar>
      <article className={`blog-preview ${mobile?'blog-preview-mobile':''}`} style={{backgroundColor:draft.style?.background,color:draft.style?.color,fontFamily:draft.style?.bodyFont ? `"${draft.style.bodyFont}", sans-serif` : undefined,fontSize:mobile?draft.style?.mobileParagraphSize:draft.style?.paragraphSize,lineHeight:draft.style?.lineHeight,textAlign:draft.style?.align,maxWidth:mobile?draft.style?.mobileWidth:draft.style?.desktopWidth,padding:draft.style?.padding, '--blog-heading-weight':draft.style?.headingWeight,'--blog-image-radius':draft.style?.imageRadius === undefined ? undefined : `${draft.style.imageRadius}px`, '--blog-heading-color':draft.style?.headingColor,'--blog-heading-size':draft.style?.headingSize ? `${draft.style.headingSize}px` : undefined,'--blog-info-font':draft.style?.infoFont ? `"${draft.style.infoFont}", sans-serif` : undefined} as React.CSSProperties}><PreviewBlocks blocks={draft.blocks} api={media} projectId={projectId}/></article>
    </>}
    </div>
  </section>;
}
