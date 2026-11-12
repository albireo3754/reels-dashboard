import {captureMarkupReview} from "./markup-review-capture";
import {clipboard,dialog,type BrowserWindow,type WebContents,type WebFrameMain} from "electron";
import {startCanonicalEditor} from "../app/blog-editor/server";
import type {EditorConfig} from "../app/blog-editor/store";
import type {CanonicalEditorTab} from "../shared/blog";
import {readBlogProjects,scanBlogProjects} from "./blog-projects";

/** The one external page an embedded editor may open (the sticker help link). */
export const CANONICAL_EDITOR_HELP_URL="https://help.naver.com/service/5593/contents/15529?lang=ko";

/** The warning the editor window used to show; kept word for word when an embedded editor has changes not in its file. */
const UNSAVED_DIALOG:Electron.MessageBoxSyncOptions={type:"warning",buttons:["그래도 닫기","계속 편집"],defaultId:1,cancelId:1,message:"아직 파일에 저장되지 않은 변경이 있어요.",detail:"닫으면 저장되지 않은 내용이 사라질 수 있어요."};
/** Any other screen's unsaved guard (원고·배치 draft, experience form): same buttons, no claim about files. */
const GENERAL_UNSAVED_DIALOG:Electron.MessageBoxSyncOptions={...UNSAVED_DIALOG,message:"저장하지 않은 변경이 있어요.",detail:"닫으면 저장하지 않은 내용이 사라질 수 있어요."};

/** How long a closed tab's server stays up for the page's pagehide (keepalive) save. */
const RELEASE_GRACE_MS=3000;
/** A probe that does not answer in this time counts as unsaved. */
const PROBE_TIMEOUT_MS=2000;

/**
 * Asks the editor page's own beforeunload rule whether it would refuse to unload, without
 * unloading it. Removing an iframe runs no beforeunload, and a real one needs a user
 * gesture inside the frame, so tab close, window close and quit all ask this way.
 */
const UNSAVED_PROBE=`(()=>{const e=new Event("beforeunload",{cancelable:true});dispatchEvent(e);return e.defaultPrevented;})()`;

const originOf=(url:string|undefined)=>{
  try{const origin=url?new URL(url).origin:"null";return origin==="null"?undefined:origin;}catch{return undefined;}
};

/**
 * Blog → 프로젝트 editors, embedded as iframes in the dashboard window's blog tab.
 * Each project gets its own loopback server (and so its own origin); the page gets no
 * preload and no bridge. Private per-install config: the packaged app contains no
 * user's manuscript paths.
 */
export class DesktopCanonicalEditor{
  private editors=new Map<string,ProjectEditor>();
  private releases=new Map<string,ReturnType<typeof setTimeout>>();
  /** `background`: proceed without dialogs (background QA; see main.ts for the stubbed-dialog QA switch). */
  constructor(private root:string,private webRoot:string,private background:boolean){}
  async projects(){return (await readBlogProjects(this.root)).map(({id,title})=>({id,title}));}
  /** Content cards that point at a manuscript but cannot be listed, with the reason. */
  async issues(){return (await scanBlogProjects(this.root)).issues;}
  /**
   * Starts (or reuses) the project's server and returns what the renderer puts in its tab.
   * A changed connection is refused while the project has an embedded frame in `contents`;
   * once all its tabs are closed the old server is dropped and the new connection opens.
   */
  async open(projectId:string,contents?:WebContents):Promise<CanonicalEditorTab>{
    const project=(await readBlogProjects(this.root)).find(p=>p.id===projectId);
    if(!project)throw new Error("연결된 블로그 프로젝트를 선택해주세요.");
    this.cancelRelease(projectId);
    let editor=this.editors.get(projectId);
    if(editor&&editor.connection!==JSON.stringify(project.config)){
      if(!contents||this.frames(contents,projectId).length)throw new Error("프로젝트 연결이 변경됐어요. 편집 내용을 저장한 뒤 열린 탭을 닫고 다시 열어주세요.");
      await this.drop(projectId,editor);
      editor=undefined;
    }
    if(!editor){editor=new ProjectEditor(project.config,this.webRoot);this.editors.set(projectId,editor);}
    return {projectId,title:project.title,url:await editor.open()};
  }
  /**
   * After a tab close was allowed: once the project has no frame left in `contents`, stop its
   * server. The grace period lets the removed page's pagehide save reach the server first,
   * and a reopen in the meantime cancels it.
   */
  release(projectId:string,contents:WebContents){
    this.cancelRelease(projectId);
    this.releases.set(projectId,setTimeout(()=>{
      this.releases.delete(projectId);
      const editor=this.editors.get(projectId);
      if(!editor||editor.busy)return;
      if(!contents.isDestroyed()&&this.frames(contents,projectId).length)return;
      void this.drop(projectId,editor);
    },RELEASE_GRACE_MS));
  }
  private cancelRelease(projectId:string){
    const timer=this.releases.get(projectId);
    if(timer)clearTimeout(timer);
    this.releases.delete(projectId);
  }
  private async drop(projectId:string,editor:ProjectEditor){
    if(this.editors.get(projectId)===editor)this.editors.delete(projectId);
    await editor.dispose();
  }
  /** True for a URL served by one of the running editor servers (exact scheme, host and port). */
  owns(url:string|undefined){
    const origin=originOf(url);
    return !!origin&&[...this.editors.values()].some(editor=>editor.origin===origin);
  }
  /** Editor frames (each editor document and its manuscript frame) inside the given contents. */
  frames(contents:WebContents,projectId?:string):WebFrameMain[]{
    const origin=projectId===undefined?undefined:this.editors.get(projectId)?.origin;
    if(projectId!==undefined&&!origin)return [];
    return contents.mainFrame.framesInSubtree.filter(frame=>frame!==contents.mainFrame&&(origin?originOf(frame.url)===origin:this.owns(frame.url)));
  }
  /**
   * May these editors go away? Asks once when a page reports changes not in the file yet
   * (the editor window's wording) or, with `includeHost`, when the dashboard page itself
   * refuses to unload (general wording). A probe that fails or does not answer counts as
   * unsaved. Background QA proceeds without a dialog.
   */
  async confirmDiscard(contents:WebContents,parent:BrowserWindow|undefined,projectId?:string,includeHost=false){
    const [editors,host]=await Promise.all([
      Promise.all(this.frames(contents,projectId).map(probe)),
      includeHost?probe(contents.mainFrame):Promise.resolve(false),
    ]);
    const editorUnsaved=editors.some(Boolean),unsaved=editorUnsaved||host;
    if(!unsaved||this.background)return {close:true,unsaved};
    return {close:this.ask(parent,editorUnsaved?UNSAVED_DIALOG:GENERAL_UNSAVED_DIALOG),unsaved};
  }
  /** For will-prevent-unload: a real beforeunload refusal no probe settled first. Any screen may cause it. */
  confirmUnload(parent:BrowserWindow){
    return this.background||this.ask(parent,GENERAL_UNSAVED_DIALOG);
  }
  private ask(parent:BrowserWindow|undefined,options:Electron.MessageBoxSyncOptions){
    const choice=parent&&!parent.isDestroyed()?dialog.showMessageBoxSync(parent,options):dialog.showMessageBoxSync(options);
    return choice===0;
  }
  async dispose(){
    for(const id of [...this.releases.keys()])this.cancelRelease(id);
    await Promise.all([...this.editors.values()].map(editor=>editor.dispose()));this.editors.clear();
  }
}

/** true when the page would refuse to unload; a rejected or unanswered probe counts as unsaved. */
function probe(frame:WebFrameMain):Promise<boolean>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  return Promise.race([
    frame.executeJavaScript(UNSAVED_PROBE).then(value=>value===true,()=>true),
    new Promise<boolean>(resolve=>{timer=setTimeout(resolve,PROBE_TIMEOUT_MS,true);}),
  ]).finally(()=>clearTimeout(timer));
}

class ProjectEditor{
  private handle?:Awaited<ReturnType<typeof startCanonicalEditor>>;
  private opening?:Promise<string>;
  readonly connection:string;
  constructor(private config:EditorConfig,private webRoot:string){this.connection=JSON.stringify(config);}
  get origin(){return this.handle?.url;}
  /** Starting: a release must not close the server under it. */
  get busy(){return !!this.opening;}
  open():Promise<string>{
    if(this.opening)return this.opening;
    this.opening=this.openOnce().finally(()=>{this.opening=undefined;});
    return this.opening;
  }
  private async openOnce(){
    if(!this.handle){
      this.handle=await startCanonicalEditor({...this.config,port:0},this.webRoot,captureMarkupReview,text=>clipboard.writeText(text),{desktopFrame:true});
    }
    return this.handle.url+"/?blogEditor=1";
  }
  async dispose(){
    await this.handle?.close();this.handle=undefined;
  }
}
