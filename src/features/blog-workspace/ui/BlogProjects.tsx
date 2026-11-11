import {useEffect,useState} from 'react';
import type {BlogBridge,CanonicalEditorTab} from '../../../shared/blog';
import {Button,IconButton,Notice,Spacer,StatusText,Toolbar} from '../../../shared/ui/primitives';
import {DocumentIcon,RefreshIcon} from './icons';

/**
 * 정본 블로그 프로젝트 목록. Notion 데이터베이스 행처럼 행 전체를 눌러 열고,
 * 행 끝의 '프로젝트 열기'는 키보드·보조기술용 같은 동작이다(hover·포커스 때 보인다).
 */
export function BlogProjects({api,onOpen,openIds=[]}:{api:BlogBridge;onOpen:(tab:CanonicalEditorTab)=>void;openIds?:string[]}){
  const [projects,setProjects]=useState<Array<{id:string;title:string}>>([]);
  const [loading,setLoading]=useState(true);
  const [opening,setOpening]=useState('');
  const [error,setError]=useState('');
  const refresh=async()=>{
    setLoading(true);setError('');
    try{setProjects(await api.canonicalProjects?.()??[]);}
    catch(e){setError(String(e));}
    finally{setLoading(false);}
  };
  useEffect(()=>{void refresh();},[api]);
  const open=async(id:string)=>{
    if(opening||!api.openCanonical)return;
    setOpening(id);setError('');
    try{onOpen(await api.openCanonical(id));}catch(e){setError(String(e));}finally{setOpening('');}
  };
  return <section className="blog-projects" aria-label="블로그 프로젝트 목록">
    <Toolbar className="blog-projects-bar">
      {loading?<StatusText live busy>프로젝트를 불러오는 중…</StatusText>
        :projects.length?<span className="ui-meta">프로젝트 {projects.length}개</span>:null}
      <Spacer/>
      <IconButton label="프로젝트 새로고침" disabled={loading||!!opening} onClick={()=>void refresh()}><RefreshIcon/></IconButton>
    </Toolbar>
    {error&&<Notice tone="danger">{error}</Notice>}
    {!loading&&!error&&!projects.length&&<p className="ui-meta blog-empty">아직 연결된 블로그 프로젝트가 없어요.</p>}
    {projects.length>0&&<ul className="ui-list blog-project-list" data-divided="">{projects.map(project=>{
      const isOpen=openIds.includes(project.id);
      return <li key={project.id}>
        <article className="ui-row blog-project-row" data-clickable="" aria-label={project.title} aria-busy={opening===project.id||undefined}
          onClick={()=>void open(project.id)}>
          <DocumentIcon className="ui-row-icon"/>
          <span className="ui-row-title">{project.title}</span>
          {isOpen&&<span className="ui-row-meta" title="위쪽 탭에 열려 있어요">열림</span>}
          <span className="ui-row-actions">
            <Button size="small" disabled={!!opening||!api.openCanonical} onClick={event=>{event.stopPropagation();void open(project.id);}}>
              {opening===project.id?'여는 중…':'프로젝트 열기'}
            </Button>
          </span>
        </article>
      </li>;
    })}</ul>}
  </section>;
}
