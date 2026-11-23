'use client';
import {useState} from 'react';
import {Copy,Check} from 'lucide-react';
import type {PublishingCopy} from '../lib/contracts';

export function PublishingCopyPanel({copy}:{copy:PublishingCopy|null|undefined}){
 const [copied,setCopied]=useState(''),[error,setError]=useState('');
 async function copyText(id:string,text:string){
  try{await navigator.clipboard.writeText(text);setCopied(id);setError('');}
  catch{setError('자동 복사가 안 됐어요. 아래 문안을 길게 눌러 복사해주세요.');}
 }
 const state=copy?.publicationStatus==='published'?'게시 기록':copy?.publicationStatus==='draft'?'미게시 초안':'확정 여부 확인 필요';
 return <section className="publishing-copy" aria-label="게시 문안">
  <div className="section-heading"><h3>게시 문안</h3>{copy&&<span>{state}</span>}</div>
  {copy?.updatedAt&&<p className="asset-help">문안 수정 · {new Date(copy.updatedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul'})}</p>}
  {!copy||copy.status!=='ready'?<p className="copy-empty">{copy?.status==='unavailable'?'문안을 읽지 못했어요. 다음 동기화에서 다시 확인해요.':'아직 동기화된 게시 문안이 없어요.'}</p>:copy.sections.map(s=><article className="copy-block" key={s.id}>
   <div className="copy-heading"><h4>{s.label}</h4><button type="button" aria-label={`${s.label} 복사`} onClick={()=>void copyText(s.id,s.text)}>{copied===s.id?<Check size={15}/>:<Copy size={15}/>} {copied===s.id?'복사됨':'복사'}</button></div>
   {s.kind==='reply'&&<p className="reply-parent">{s.parentId?`${copy.sections.find(p=>p.id===s.parentId)?.label??'원댓글'}에 달 답글이에요.`:'답글을 달 원댓글을 확인해주세요.'}</p>}
   <pre>{s.text}</pre>
  </article>)}
  <p className="copy-feedback" role="status">{error|| (copied?'문안을 복사했어요.':'')}</p>
 </section>;
}
