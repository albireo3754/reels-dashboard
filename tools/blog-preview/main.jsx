import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import BlogPreview from './BlogPreview.jsx';
import ReferenceExplorer from './ReferenceExplorer.jsx';
import TemplateEngine from './TemplateEngine.jsx';
import './style.css';
const root=createRoot(document.getElementById('root'));
function App({spec,references,templates}){const[view,setView]=useState(location.hash==='#draft'?'draft':'engine');return view==='engine'?<TemplateEngine templates={templates} onBack={()=>setView('reference')}/>:view==='reference'?<><button className="back-reference" onClick={()=>setView('engine')}>템플릿 엔진</button><ReferenceExplorer references={references} onDraft={()=>setView('draft')}/></>:<><button className="back-reference" onClick={()=>setView('engine')}>템플릿 엔진</button><BlogPreview spec={spec}/></>}
Promise.all([fetch('./render-spec.md').then(r=>r.text()),fetch('./reference-structures.json').then(r=>r.json()),fetch('./reference-templates.json').then(r=>r.json())]).then(([md,references,templates])=>{const match=md.match(/```json\n([\s\S]*?)\n```/);if(!match)throw new Error('명세 JSON 없음');root.render(<App spec={JSON.parse(match[1])} references={references} templates={templates}/>)}).catch(e=>root.render(<p role="alert">미리보기를 열지 못했어요: {e.message}</p>));
