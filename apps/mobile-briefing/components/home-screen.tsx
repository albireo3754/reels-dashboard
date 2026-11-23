'use client';
import {useEffect,useState} from 'react';
import {Download,Share,Smartphone,X} from 'lucide-react';
type InstallPrompt=Event&{prompt:()=>Promise<void>;userChoice:Promise<{outcome:'accepted'|'dismissed'}>};
export function HomeScreen(){
 const [installed,setInstalled]=useState(true),[ios,setIos]=useState(false),[open,setOpen]=useState(false),[prompt,setPrompt]=useState<InstallPrompt|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
 useEffect(()=>{
  const mode=window.matchMedia('(display-mode: standalone)');
  const update=()=>{const standalone=mode.matches||(navigator as Navigator&{standalone?:boolean}).standalone===true;setInstalled(standalone);document.documentElement.dataset.displayMode=standalone?'standalone':'browser';};
  update();mode.addEventListener('change',update);
  setIos(/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1));
  const before=(event:Event)=>{event.preventDefault();setPrompt(event as InstallPrompt);};
  const done=()=>{setInstalled(true);setPrompt(null);setOpen(false);};
  window.addEventListener('beforeinstallprompt',before);window.addEventListener('appinstalled',done);
  // Only generic offline UI is cached. Authenticated pages/API responses are never stored.
  if('serviceWorker' in navigator&&window.isSecureContext)void navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(()=>{});
  return()=>{mode.removeEventListener('change',update);window.removeEventListener('beforeinstallprompt',before);window.removeEventListener('appinstalled',done);};
 },[]);
 async function install(){
  if(!prompt){setOpen(true);return;}
  setBusy(true);setMessage('');
  try{await prompt.prompt();const choice=await prompt.userChoice;if(choice.outcome==='accepted'){setMessage('설치가 완료되면 홈 화면에서 열어주세요.');}else{setMessage('나중에 다시 추가할 수 있어요.');}}
  catch{setOpen(true);setMessage('브라우저 메뉴에서 홈 화면에 추가해주세요.');}
  finally{setPrompt(null);setBusy(false);}
 }
 if(installed)return null;
 return <section className="home-screen" aria-label="홈 화면 앱">
  <div className="home-screen-summary"><Smartphone size={20}/><div><strong>홈 화면에서 바로 열어요</strong><p>아이콘을 눌러 제작 현황과 게시 문안을 확인해요.</p></div><button onClick={()=>void install()} disabled={busy} aria-expanded={open} aria-controls="home-screen-guide"><Download size={15}/>{prompt?'앱 설치':'추가 방법'}</button></div>
  {message&&<p role="status" className="install-message">{message}</p>}
  {open&&<div id="home-screen-guide" className="home-screen-guide"><button className="install-close" onClick={()=>setOpen(false)} aria-label="설치 안내 닫기"><X size={18}/></button>
   <h2>{ios?'iPhone·iPad에 추가하기':'홈 화면에 추가하기'}</h2>
   {ios?<ol><li>Safari에서 이 페이지를 열어요.</li><li><Share size={14}/> 공유 메뉴에서 <strong>홈 화면에 추가</strong>를 선택해요.</li><li><strong>웹 앱으로 열기</strong>가 보이면 켜고 추가해요.</li></ol>:<ol><li>브라우저 메뉴에서 <strong>앱 설치</strong> 또는 <strong>홈 화면에 추가</strong>를 선택해요.</li><li>설치 항목이 없으면 Safari나 Chrome에서 다시 열어주세요.</li></ol>}
   <p>홈 화면에서 처음 열 때 로그인이 다시 필요할 수 있어요. 현황을 불러오려면 인터넷 연결이 필요해요.</p>
  </div>}
 </section>;
}
