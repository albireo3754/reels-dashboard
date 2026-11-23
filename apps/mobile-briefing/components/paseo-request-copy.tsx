'use client';
import {useRef,useState} from 'react';
import {Copy,Check} from 'lucide-react';
import {buildPaseoRequest} from '../lib/paseo-request.mjs';

// Copies a fixed request for the user's own Paseo session. Copying does not
// send, run or approve anything; there is no server write.
export function PaseoRequestCopy({target,basisAt}:{target:string;basisAt:string|null}){
 const request=buildPaseoRequest({target,basisAt});
 const [state,setState]=useState<'idle'|'pending'|'copied'|'failed'>('idle');
 const busy=useRef(false);
 async function copy(){
  if(!request.ok||busy.current)return;
  // Clear any earlier result first: a previous success must not stand in for this attempt.
  busy.current=true;setState('pending');
  try{await navigator.clipboard.writeText(request.text);setState('copied');}
  catch{setState('failed');}
  finally{busy.current=false;}
 }
 return <div className="paseo-request" aria-label="Paseo 요청">
  <button type="button" className="paseo-copy-button" disabled={!request.ok||state==='pending'} aria-busy={state==='pending'} aria-describedby="paseo-request-note" onClick={()=>void copy()}>{state==='copied'?<Check size={15}/>:<Copy size={15}/>} Paseo에 붙여 넣을 요청 복사</button>
  <p className="paseo-request-note" id="paseo-request-note">{request.ok?'복사만 해요. 보내기·실행·승인은 Paseo에서 직접 해요.':request.reason}{' · '}화면 기준 시각 {request.basis??'확인 불가'}</p>
  <p className="paseo-request-feedback" role="status">{state==='pending'?'복사하는 중이에요…':state==='copied'?'복사했어요. Paseo에서 확인 후 보내세요':state==='failed'?'자동 복사가 안 됐어요. 아래 요청을 길게 눌러 복사해 주세요.':''}</p>
  {state==='failed'&&request.ok&&<pre className="paseo-request-text" aria-label="복사할 Paseo 요청">{request.text}</pre>}
 </div>;
}
