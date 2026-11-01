import {BrowserWindow} from "electron";
import {mkdir,writeFile} from "node:fs/promises";
import path from "node:path";
import {createHash,randomUUID} from "node:crypto";
import type {VisualEvidence} from "../shared/markup-review";
export async function captureMarkupReview(frameUrl:string,bundleIds:string[],directory:string,sourceFingerprint:string):Promise<VisualEvidence[]>{
 if(bundleIds.length>20)throw new Error("화면 검토는 한 번에 20개 묶음까지 선택해주세요.");
 await mkdir(directory,{recursive:true});
 const win=new BrowserWindow({width:430,height:1000,show:false,focusable:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,partition:"markup-capture-"+randomUUID(),backgroundThrottling:false}});
 win.webContents.setWindowOpenHandler(()=>({action:"deny"}));
 win.webContents.session.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
 const evidence:VisualEvidence[]=[];
 try{
  for(const width of [360,390,430]){
   win.setContentSize(width,1000);
   await win.loadURL(frameUrl);
   await win.webContents.executeJavaScript("(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(img=>img.complete?Promise.resolve():new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('사진 로딩 시간 초과')),15000);img.onload=()=>{clearTimeout(timer);resolve()};img.onerror=()=>{clearTimeout(timer);reject(new Error('사진 로딩 실패'))}})));if([...document.images].some(img=>!img.naturalWidth))throw new Error('사진 로딩 실패');if([...document.fonts].some(font=>font.status==='error'))throw new Error('글꼴 로딩 실패');document.querySelectorAll('[data-annotation-badge]').forEach(el=>el.remove());})()");
   for(const [index,id] of bundleIds.entries()){
    const select='[...document.querySelectorAll(".editor-bundle")].find(el=>el.dataset.bundle==='+JSON.stringify(id)+')';
    const height=await win.webContents.executeJavaScript('(()=>{const el='+select+';if(!el)throw new Error("묶음 없음");return Math.ceil(el.getBoundingClientRect().height)})()');
    if(height>6000||height<1)throw new Error("캡처 가능한 묶음 높이를 벗어났어요.");
    win.setContentSize(width,Math.max(1000,height+100));
    const rect=await win.webContents.executeJavaScript('(async()=>{const el='+select+';el.scrollIntoView({block:"start",behavior:"instant"});await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);const r=el.getBoundingClientRect();return {x:0,y:Math.max(0,Math.floor(r.top)),width:innerWidth,height:Math.ceil(r.height)}})()');
    const img=await win.webContents.capturePage(rect,{stayHidden:true,stayAwake:true});
    if(img.isEmpty())throw new Error("빈 화면 캡처");
    const png=img.toPNG(),file=path.join(directory,width+"-"+index+".png");
    await writeFile(file,png,{flag:"wx"});
    evidence.push({path:file,bundleId:id,width,sourceFingerprint,sha256:createHash("sha256").update(png).digest("hex")});
   }
  }
  return evidence;
 }finally{win.destroy();}
}
