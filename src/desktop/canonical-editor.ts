import {BrowserWindow,session} from "electron";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {startCanonicalEditor} from "../app/blog-editor/server";
import type {EditorConfig} from "../app/blog-editor/store";

/** Private per-install config. The packaged app contains no user's manuscript paths. */
export class DesktopCanonicalEditor{
  private handle?:Awaited<ReturnType<typeof startCanonicalEditor>>;
  private window?:BrowserWindow;
  private opening?:Promise<string>;
  constructor(private root:string,private webRoot:string,private background:boolean){}
  open():Promise<string>{
    if(this.opening)return this.opening;
    this.opening=this.openOnce().finally(()=>{this.opening=undefined;});
    return this.opening;
  }
  private async openOnce(){
    if(!this.handle){
      let config:EditorConfig;
      try{config=JSON.parse(await readFile(path.join(this.root,"canonical-blog.json"),"utf8"));}
      catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")throw new Error("연결된 마크업 정본이 없어요. 로컬 canonical-blog.json 설정을 확인해주세요.");throw e;}
      if(config.format!=="markup"||![config.canon,config.layout,config.media].every(v=>typeof v==="string"&&path.isAbsolute(v)))throw new Error("마크업 편집기 경로 설정이 올바르지 않아요.");
      this.handle=await startCanonicalEditor({...config,port:0},this.webRoot);
    }
    const url=this.handle.url+"/?blogEditor=1";
    if(this.window&&!this.window.isDestroyed()){if(!this.background){this.window.show();this.window.focus();}return url;}
    const partition="canonical-editor";
    const ses=session.fromPartition(partition);
    ses.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    ses.setPermissionCheckHandler(()=>false);
    this.window=new BrowserWindow({width:1440,height:1000,show:!this.background,focusable:!this.background,title:"블로그 정본",webPreferences:{partition,nodeIntegration:false,contextIsolation:true,sandbox:true}});
    const win=this.window,origin=this.handle.url;
    win.webContents.setWindowOpenHandler(()=>({action:"deny"}));
    win.webContents.on("will-navigate",(event,to)=>{if(new URL(to).origin!==origin)event.preventDefault();});
    win.on("closed",()=>{if(this.window===win)this.window=undefined;});
    await win.loadURL(url);
    return url;
  }
  async dispose(){
    if(this.window&&!this.window.isDestroyed())this.window.destroy();
    await this.handle?.close();this.handle=undefined;
  }
}
