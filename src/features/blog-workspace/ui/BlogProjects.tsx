import {useEffect,useRef,useState} from 'react';
import type {BlogBridge,CanonicalBlogProject,CanonicalEditorTab} from '../../../shared/blog';
import {Badge,Button,IconButton,Notice,Segmented,Spacer,StatusText,Toolbar} from '../../../shared/ui/primitives';
import {DocumentIcon,RefreshIcon} from './icons';

type Filter='active'|'published'|'all';

/** 게시 완료 행의 오른쪽 날짜: 2026-11-10 → 11.10 (올해가 아니면 연도까지). */
const shortDate=(day:string)=>{
  const [y,m,d]=day.split('-');
  return (y===String(new Date().getFullYear())?'':y+'.')+Number(m)+'.'+Number(d);
};

/** 진행 중 행의 블로그 채널 상태: 기록이 없으면 그대로 말해 실제 게시 여부를 카드에서 확인하게 한다. */
const progressNote=(project:CanonicalBlogProject)=>project.blog?.status==='planned'?'블로그 게시 예정':'블로그 게시 기록 없음';

/** 진행 중은 제목순 그대로, 게시 완료는 최근 게시일 순. */
const byPublished=(a:CanonicalBlogProject,b:CanonicalBlogProject)=>(b.blog?.publishedAt??'').localeCompare(a.blog?.publishedAt??'');

function ProjectRow({project,isOpen,opening,canOpen,onOpen}:{project:CanonicalBlogProject;isOpen:boolean;opening:string;canOpen:boolean;onOpen:(id:string)=>void}){
  const day=project.blog?.publishedAt;
  return <li>
    <article className="ui-row blog-project-row" data-clickable="" data-published={project.published?'':undefined}
      aria-label={project.title} aria-busy={opening===project.id||undefined} onClick={()=>onOpen(project.id)}>
      <DocumentIcon className="ui-row-icon"/>
      <span className="ui-row-title" title={project.title}>{project.title}</span>
      {isOpen&&<span className="ui-row-meta" title="위쪽 탭에 열려 있어요">열림</span>}
      <span className="blog-project-status">
        {project.published
          ?<><Badge tone="primary">게시 완료</Badge>{day&&<time className="ui-row-meta" dateTime={day}>{shortDate(day)}</time>}</>
          :<><Badge>진행 중</Badge><span className="ui-row-meta">{progressNote(project)}</span></>}
      </span>
      <span className="ui-row-actions blog-project-actions">
        <Button size="small" disabled={!!opening||!canOpen} onClick={event=>{event.stopPropagation();onOpen(project.id);}}>
          {opening===project.id?'여는 중…':'프로젝트 열기'}
        </Button>
      </span>
    </article>
  </li>;
}

/**
 * 정본 블로그 프로젝트 목록: blog-markup 원고가 연결된 콘텐츠 카드(main 프로세스가 조회). Notion 데이터베이스 행처럼 행 전체를 눌러 열고,
 * 행 끝의 '프로젝트 열기'는 키보드·보조기술용 같은 동작이다(hover·포커스 때 보인다).
 *
 * 목록은 화면에 보일 때(`active`)마다, 현황이 바뀌었을 때(`revision`), 창으로 돌아왔을 때 다시 읽는다.
 * 카드 연결은 MCP·CLI·다른 세션이 앱 밖에서 바꾸기도 하므로 시작 시 한 번 읽은 목록을 계속 보여주면 새 프로젝트가 빠진다.
 */
export function BlogProjects({api,onOpen,openIds=[],active=true,revision}:{api:BlogBridge;onOpen:(tab:CanonicalEditorTab)=>void;openIds?:string[];
  /** 프로젝트 목록이 화면에 보이는지. 보이게 될 때 다시 읽는다. */
  active?:boolean;
  /** 현황(콘텐츠 카드)이 바뀌면 달라지는 값. */
  revision?:unknown}){
  const [projects,setProjects]=useState<CanonicalBlogProject[]>([]);
  const [filter,setFilter]=useState<Filter>('active');
  const [loaded,setLoaded]=useState(false);
  const [loading,setLoading]=useState(true);
  const [opening,setOpening]=useState('');
  const [error,setError]=useState('');
  const [issues,setIssues]=useState<Array<{id:string;title:string;reason:string}>>([]);
  const request=useRef(0);
  const inProgress=projects.filter(project=>!project.published);
  const published=projects.filter(project=>project.published).sort(byPublished);
  /** quiet: 자동 갱신은 목록을 그대로 둔 채 바꾼다(깜빡임 없음). 늦게 온 이전 응답은 버린다. */
  const refresh=async(quiet=false)=>{
    const id=++request.current;
    if(!quiet)setLoading(true);
    try{
      const [list,left]=await Promise.all([api.canonicalProjects?.()??[],api.canonicalIssues?.()??[]]);
      if(id!==request.current)return;
      setProjects(list);setIssues(left);setError('');setLoaded(true);
    }
    catch(e){if(id===request.current)setError(String(e));}
    finally{if(id===request.current)setLoading(false);}
  };
  useEffect(()=>{if(active)void refresh(loaded);},[api,active,revision]);
  useEffect(()=>{
    if(!active)return;
    const onFocus=()=>void refresh(true);
    window.addEventListener('focus',onFocus);
    return()=>window.removeEventListener('focus',onFocus);
  },[api,active]);
  const open=async(id:string)=>{
    if(opening||!api.openCanonical)return;
    setOpening(id);setError('');
    try{onOpen(await api.openCanonical(id));}catch(e){setError(String(e));}finally{setOpening('');}
  };
  const row=(project:CanonicalBlogProject)=><ProjectRow key={project.id} project={project} isOpen={openIds.includes(project.id)}
    opening={opening} canOpen={!!api.openCanonical} onOpen={id=>void open(id)}/>;
  const group=(title:string,list:CanonicalBlogProject[])=>list.length>0&&<section className="blog-project-group" aria-label={title}>
    <h3 className="blog-project-group-title">{title} <span className="ui-meta">{list.length}</span></h3>
    <ul className="ui-list blog-project-list" data-divided="">{list.map(row)}</ul>
  </section>;
  const visible=filter==='active'?inProgress:filter==='published'?published:projects;
  return <section className="blog-projects" aria-label="블로그 프로젝트 목록">
    <Toolbar className="blog-projects-bar">
      <Segmented<Filter> label="블로그 진행 필터" size="small" value={filter} onChange={setFilter} items={[
        {value:'active',label:`진행 중 ${inProgress.length}`,ariaLabel:'진행 중'},
        {value:'published',label:`게시 완료 ${published.length}`,ariaLabel:'게시 완료'},
        {value:'all',label:`전체 ${projects.length}`,ariaLabel:'전체'},
      ]}/>
      {loading&&<StatusText live busy>프로젝트를 불러오는 중…</StatusText>}
      <Spacer/>
      <IconButton label="프로젝트 새로고침" disabled={loading||!!opening} onClick={()=>void refresh()}><RefreshIcon/></IconButton>
    </Toolbar>
    {error&&<Notice tone="danger">{error}</Notice>}
    {!error&&issues.length>0&&<Notice tone="warning">
      <p>원고가 연결됐지만 목록에 넣지 못한 콘텐츠 {issues.length}개</p>
      <ul className="blog-project-issues">{issues.map(issue=><li key={issue.id+issue.reason}><strong>{issue.title}</strong> — {issue.reason}</li>)}</ul>
    </Notice>}
    {loaded&&!error&&!projects.length&&<div className="ui-meta blog-empty">
      <p>아직 연결된 블로그 프로젝트가 없어요.</p>
      <p>콘텐츠 카드에 blog-markup 원고(<code>markup: 1</code>)를 문서로 연결하면 여기에 나타나요.</p>
    </div>}
    {loaded&&!error&&projects.length>0&&!visible.length&&<div className="ui-meta blog-empty">
      <p>{filter==='active'?'진행 중인 블로그 프로젝트가 없어요.':'게시 완료한 블로그 프로젝트가 없어요.'}</p>
      <Button onClick={()=>setFilter('all')}>전체 보기</Button>
    </div>}
    {filter==='all'
      ?<>{group('진행 중',inProgress)}{group('게시 완료',published)}</>
      :visible.length>0&&<ul className="ui-list blog-project-list" data-divided="">{visible.map(row)}</ul>}
    {loaded&&projects.length>0&&<p className="ui-meta blog-projects-help">게시 완료는 콘텐츠 카드의 블로그 채널 게시 기록 기준이에요. 발행한 글이 진행 중에 있으면 카드에 블로그 게시 완료를 기록해주세요.</p>}
  </section>;
}
