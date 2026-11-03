import {captureMarkupReview} from "./markup-review-capture";
import {app,BrowserWindow,session,clipboard,shell} from "electron";
import {startCanonicalEditor} from "../app/blog-editor/server";
import type {EditorConfig} from "../app/blog-editor/store";
import {readBlogProjects} from "./blog-projects";

/** Private per-install config. The packaged app contains no user's manuscript paths. */
export class DesktopCanonicalEditor{
  private editors=new Map<string,ProjectEditor>();
  constructor(private root:string,private webRoot:string,private background:boolean){}
  async projects(){return (await readBlogProjects(this.root)).map(({id,title})=>({id,title}));}
  async open(projectId:string){
    const project=(await readBlogProjects(this.root)).find(p=>p.id===projectId);
    if(!project)throw new Error("연결된 블로그 프로젝트를 선택해주세요.");
    let editor=this.editors.get(projectId);
    if(!editor){editor=new ProjectEditor(project.title,project.config,this.webRoot,this.background);this.editors.set(projectId,editor);}
    if(editor.connection!==JSON.stringify(project.config))throw new Error("프로젝트 연결이 변경됐어요. 편집 내용을 저장한 뒤 앱을 다시 열어주세요.");
    return editor.open();
  }
  async dispose(){await Promise.all([...this.editors.values()].map(editor=>editor.dispose()));this.editors.clear();}
}

class ProjectEditor{
  private handle?:Awaited<ReturnType<typeof startCanonicalEditor>>;
  private window?:BrowserWindow;
  private opening?:Promise<string>;
  readonly connection:string;
  constructor(private title:string,private config:EditorConfig,private webRoot:string,private background:boolean){this.connection=JSON.stringify(config);}
  open():Promise<string>{
    if(this.opening)return this.opening;
    this.opening=this.openOnce().finally(()=>{this.opening=undefined;});
    return this.opening;
  }
  private async openOnce(){
    if(!this.handle){
      this.handle=await startCanonicalEditor({...this.config,port:0},this.webRoot,captureMarkupReview,text=>clipboard.writeText(text));
    }
    const url=this.handle.url+"/?blogEditor=1";
    if(this.window&&!this.window.isDestroyed()){if(!this.background){this.window.show();this.window.focus();}return url;}
    const partition="canonical-editor";
    const ses=session.fromPartition(partition);
    ses.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    ses.setPermissionCheckHandler(()=>false);
    this.window=new BrowserWindow({width:1440,height:1000,show:!this.background,focusable:!this.background,title:app.isPackaged?this.title:`${this.title} — Dev`,webPreferences:{partition,nodeIntegration:false,contextIsolation:true,sandbox:true}});
    const win=this.window,origin=this.handle.url;
    win.webContents.setWindowOpenHandler(({url})=>{
      if(url==="https://help.naver.com/service/5593/contents/15529?lang=ko")void shell.openExternal(url);
      return {action:"deny"};
    });
    win.webContents.on("page-title-updated",event=>event.preventDefault());
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
