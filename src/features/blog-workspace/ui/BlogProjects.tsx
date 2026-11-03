import {useEffect,useState} from 'react';
import type {BlogBridge} from '../../../shared/blog';

export function BlogProjects({api}:{api:BlogBridge}){
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
  return <section aria-label="블로그 프로젝트 목록">
    <div className="blog-reference-toolbar"><h3>블로그 프로젝트</h3><button disabled={loading||!!opening} onClick={()=>void refresh()}>프로젝트 새로고침</button></div>
    <p>작업할 프로젝트를 열어 원고·사진·검토 결과를 이어서 편집해요.</p>
    {error&&<p role="alert">{error}</p>}
    {loading?<p role="status">프로젝트를 불러오는 중…</p>:!error&&!projects.length?<p>아직 연결된 블로그 프로젝트가 없어요.</p>:null}
    <div className="blog-project-grid">{projects.map(project=><article className="blog-project-card" aria-label={project.title} key={project.id}>
      <span>블로그</span><h4>{project.title}</h4><p>원고 · 사진 · 검토</p>
      <button disabled={!!opening||!api.openCanonical} onClick={async()=>{
        setOpening(project.id);setError('');
        try{await api.openCanonical!(project.id);}catch(e){setError(String(e));}finally{setOpening('');}
      }}>{opening===project.id?'여는 중…':'프로젝트 열기'}</button>
    </article>)}</div>
  </section>;
}
