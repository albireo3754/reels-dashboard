import { StickerPlanner } from "./StickerPlanner";
import { PhotoPicker } from "./PhotoPicker";
import { evidenceImageUrl, type PhotoInsert } from "../../../shared/blog-evidence";
import { movedGap, stickerHtml, stickerKey, type StickerPlacement } from "../../../shared/blog-stickers";
import {applyFinding,findingApplicability,findingTarget,replaceInlineText} from "../../../shared/review-applicability";
import {UserAnnotations,type AnnotationTarget} from "./UserAnnotations";
import {BlogChat,type ChatAttachment} from "./BlogChat";
import {CHAT_LIMITS,type BlogChatRewrite} from "../../../shared/blog-chat";
import { FormattingToolbar, type SelectionFormat } from "./FormattingToolbar";
import { CanonicalSdkReview } from "./CanonicalSdkReview";
import { useEffect, useMemo, useRef, useState } from "react";
import {planInlineProposals,proposalSignature,type InlineProposal} from "../../../shared/inline-review";
import {safeRuns} from "../../../shared/blog-markup-edit";
import {createAutosave,type AutosaveState} from "../model/autosave";
import {
  escapeHtml,
  inlineHtml,
  inlineSource,
  readInline,
  type CanonicalDocument,
  type CanonicalFinding,
  type InlineRun,
} from "../../../shared/canonical-blog";
import "./canonical-editor.css";
async function api(action: string, input?: unknown, signal?: AbortSignal) {
  const r = await fetch(
    `/api/blog/${action}`,
    input
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
          signal,
        }
      : { signal },
  );
  const value = await r.json();
  if (!r.ok) throw new Error(value.error ?? "작업에 실패했어요.");
  return value;
}
/** Deleting and placing photos stay undoable for this long; everything else saves on the quiet delay. */
const UNDO_GRACE_MS=8000;
/** What the server would not take is tried again on its own, less and less often. */
const REFUSED_RETRY_MS=30_000,REFUSED_RETRY_MAX_MS=300_000;
/** Browsers refuse keepalive bodies above 64KB, so a larger page-hide save cannot be sent at all. */
const KEEPALIVE_LIMIT=60_000;
const bodyBytes=(body:object)=>new TextEncoder().encode(JSON.stringify(body)).length;
const documentSources=(d:CanonicalDocument)=>new Map<string,string>([...d.paragraphs.map(p=>[p.id,p.source] as [string,string]),["$title",d.title]]);
/** What one save carried, so the reply clears exactly that and leaves newer typing alone. */
interface SaveSnapshot{
  revision:string;edits:Record<string,string>;title?:string;stickers?:StickerPlacement[];
  photos:PhotoInsert[];deleteBundles:string[];deleteParagraphs:string[];
}
interface SaveReply{
  document:CanonicalDocument;conflicts?:{id:string;kind?:string}[];
  skipped?:{kind:string;id:string;reason:string}[];splits?:Record<string,string[]>;
  /** Each edit as the server understood it, before any merge. */
  written?:Record<string,string>;
}
const SUGGEST_STALE="본문이 바뀌어 추천을 버렸어요. 다시 요청해주세요.";
const errorText=(e:unknown)=>e instanceof Error?e.message:String(e);
const clip=(text:string,limit:number)=>text.length>limit?text.slice(0,limit)+"…":text;
/**
 * Whether the frame draws this proposal in the manuscript: an in-text diff at the
 * target phrase, or a small marker (format, note, blocked). Stale proposals (the
 * target text changed) are not drawn; the panel explains them.
 */
function hasBodyMark(item:InlineProposal,doc:CanonicalDocument){
  if(item.state==="applied"||item.state==="decided"||item.state==="changed")return false;
  if(item.kind==="note")return !!item.paragraphId||doc.bundles.some(b=>b.id===item.bundleId);
  return !!item.paragraphId;
}
function proposalChip(item:InlineProposal):{label:string;tone:string}{
  if(item.state==="decided")return item.decision==="현재 유지"?{label:"현재 유지",tone:"kept"}:{label:item.decision??"적용 · 저장 전",tone:"applied"};
  if(item.state==="applied")return {label:"반영됨",tone:"applied"};
  if(item.state==="changed")return {label:"본문 변경됨",tone:"blocked"};
  if(item.kind==="note")return {label:"의견",tone:"note"};
  if(item.canApply)return {label:"적용 가능",tone:"available"};
  return {label:"위치 확인 불가",tone:"blocked"};
}
function proposalSummary(item:InlineProposal){
  if(item.kind==="text")return `${clip(item.before??"",40)} → ${item.after?clip(item.after,40):"(삭제)"}`;
  if(item.kind==="format")return `“${clip(item.phrase??"",40)}” 서식`;
  return clip(item.observation.split("\n")[0]??"",80);
}
export function CanonicalBlogEditor() {
  const [annotationTarget,setAnnotationTarget]=useState<AnnotationTarget>();
  // Phrases attached to the selection chat with `채팅에 추가` (screen only).
  const [chatAttachments,setChatAttachments]=useState<ChatAttachment[]>([]);
  const [chatFocus,setChatFocus]=useState("");
  const [doc, setDoc] = useState<CanonicalDocument>();
  const [stickers,setStickers]=useState<StickerPlacement[]>([]);
  const [stickerOpen,setStickerOpen]=useState(false);
  const [stickerTarget,setStickerTarget]=useState("");
  const stickersRef=useRef(stickers);stickersRef.current=stickers;
  const [photos,setPhotos]=useState<PhotoInsert[]>([]);
  const [photoOpen,setPhotoOpen]=useState(false);
  const photosRef=useRef(photos);photosRef.current=photos;
  const [edits, setEdits] = useState<Record<string, string>>({});
  // Bundles removed on this screen; they leave the source only when saved.
  const [deleted, setDeleted] = useState<string[]>([]);
  // Paragraphs removed with Backspace/Delete while empty; also only applied on save.
  const [removedParas, setRemovedParas] = useState<string[]>([]);
  // Undo order across bundle and paragraph removals ("삭제 취소" restores the latest).
  const [removals, setRemovals] = useState<{ kind: "bundle" | "paragraph"; id: string }[]>([]);
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [typography, setTypography] = useState<
    Record<string, { fontFamily: string; fontSize: number }>
  >({});
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState("");
  const [height, setHeight] = useState(2000);
  const [width, setWidth] = useState(430);
  const [busy, setBusy] = useState(false);
  const [saveState,setSaveState]=useState<"idle"|"saving"|"failed">("idle");
  const [saveRetry,setSaveRetry]=useState<{error:string;retryInMs:number}>();
  // Small, non-blocking: both sides changed a paragraph, or part of a save had to wait.
  const [syncNote,setSyncNote]=useState("");
  const [savedForReview,setSavedForReview]=useState(false);
  const [frameEpoch,setFrameEpoch]=useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [changed, setChanged] = useState<string[]>([]);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [reviewJobs,setReviewJobs]=useState<Array<{id:string;bundleIds:string[];status:string;error?:string}>>([]);
  const [reviewStatusError,setReviewStatusError]=useState("");
  const [reviewPreparing,setReviewPreparing]=useState(false);
  const [queued, setQueued] = useState<string[]>([]);
  const [selectionFormat, setSelectionFormat] = useState<SelectionFormat>();
  const [narrow, setNarrow] = useState(() => window.innerWidth <= 1080);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const reviewPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    const media = matchMedia("(max-width:1080px)");
    const update = () => setNarrow(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!doc || !root.current) return;
    const el = root.current,
      header = el.querySelector(".ce-header")!,
      toolbar = el.querySelector(".ce-toolbar")!;
    const measure = () => {
      const h = header.getBoundingClientRect().height;
      el.style.setProperty("--ce-header-height", h + "px");
      el.style.setProperty(
        "--ce-chrome-height",
        h + toolbar.getBoundingClientRect().height + "px",
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(toolbar);
    measure();
    return () => observer.disconnect();
  }, [!!doc]);
  useEffect(() => {
    if (!narrow || !reviewOpen) return;
    const prior = document.activeElement as HTMLElement;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const panel = reviewPanel.current;
    panel?.querySelector<HTMLButtonElement>(".ce-review-close")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setReviewOpen(false);
      }
      if (e.key === "Tab" && panel) {
        const nodes = [
          ...panel.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary, a[href], select:not(:disabled)",
          ),
        ].filter((n) => n.getClientRects().length);
        if (!nodes.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", key);
      prior?.focus();
    };
  }, [narrow, reviewOpen]);
  const frame = useRef<HTMLIFrameElement>(null);
  const stickersDirty=!!doc && JSON.stringify(stickers)!==JSON.stringify(doc.stickers??[]);
  const live=doc?.format==="markup";
  // An emptied title cannot be saved: it waits, and the status says so instead of promising a save.
  const titleBlank=live&&!title.trim();
  const dirty =
    stickersDirty ||
    photos.length > 0 ||
    deleted.length > 0 ||
    removedParas.length > 0 ||
    Object.keys(edits).length > 0 ||
    Object.keys(invalid).length > 0 ||
    (!!doc && title !== doc.title && !titleBlank);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const docRef = useRef(doc);
  docRef.current = doc;
  // Manual inline suggestion ("✦ 추천 받기"): one request at a time, cancellable.
  // The frame owns the caret, spinner and ghost text; nothing reaches edits until
  // the writer accepts (an ordinary insert that arrives as a "change").
  const [suggesting, setSuggesting] = useState(false);
  const suggestRef = useRef<{ requestId: string; token: string; controller: AbortController } | null>(null);
  useEffect(() => {
    frame.current?.contentWindow?.postMessage(
      { editor: true, type: "lock", locked: busy },
      location.origin,
    );
  }, [busy]);
  const send = (data: object) =>
    frame.current?.contentWindow?.postMessage(
      { editor: true, ...data },
      location.origin,
    );
  const sendStickers=()=>send({type:"stickers",items:stickersRef.current.map(s=>({...s,html:stickerHtml(s)}))});
  useEffect(()=>{if(doc?.format==="markup")sendStickers();},[stickers,doc?.frameVersion]);
  const sendPhotos=()=>send({type:"photos",items:photosRef.current.filter(p=>!deletedRef.current.includes(p.bundleId)).map(p=>({...p,src:evidenceImageUrl(p.imageId)}))});
  useEffect(()=>{if(doc?.format==="markup")sendPhotos();},[photos,deleted,doc?.frameVersion]);
  function changePhotos(next:PhotoInsert[]){
    setChanged(old=>[...new Set([...old,...photos.map(p=>p.bundleId),...next.map(p=>p.bundleId)])]);
    holdForUndo();
    setPhotos(next);setQueued([]);
  }
  function changeStickers(next:StickerPlacement[]){
    setChanged(old=>[...new Set([...old,...stickers.map(s=>s.bundleId),...next.map(s=>s.bundleId)])]);
    setStickers(next);setQueued([]);
  }
  const editsRef = useRef(edits);
  editsRef.current = edits;
  // Review-only descriptors for every stored review. They are recomputed after
  // each edit/apply, so the rest of a paragraph's proposals are re-validated
  // against the newest text. They never enter edits, the saved body or outputs.
  const proposals = useMemo(
    () =>
      doc
        ? planInlineProposals({
            doc,
            edits,
            decisions,
            changed,
            baseSizes: Object.fromEntries(
              Object.entries(typography).map(([id, t]) => [id, t.fontSize]),
            ),
          }).filter((item) => !deleted.includes(item.bundleId) && !(item.paragraphId && removedParas.includes(item.paragraphId)))
        : [],
    [doc, edits, decisions, changed, typography, deleted, removedParas],
  );
  const proposalsRef = useRef(proposals);
  proposalsRef.current = proposals;
  const handledRef = useRef(new Set<string>());
  useEffect(() => {
    send({ type: "proposals", items: proposals, locked: busy });
  }, [proposals, busy]);
  async function load() {
    setBusy(true);
    setError("");
    try {
      const d = await api("document");
      setDoc(d);setStickers(d.stickers??[]);setStickerTarget("");setPhotos([]);
      setFrameEpoch(v=>v+1);
      setSaveState("idle");setSavedForReview(false);setNotice("");
      setTitle(d.title);
      setEdits({});setDeleted([]);setRemovedParas([]);setRemovals([]);
      setSelectionFormat(undefined);
      setSelected((old) =>
        d.bundles.some((b: any) => b.id === old)
          ? old
          : (d.bundles[0]?.id ?? ""),
      );
      setChanged([]);
      setDecisions({});
      handledRef.current = new Set();
      setQueued([]);
      setInvalid({});
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      // Live pages hand pending changes over on pagehide; only a failing save needs a warning.
      if (live ? saveState === "failed" || heldTotal() > 0 || tooLargeToHandOver() : dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, live, saveState]);
  /** What the server could not take stays local; it goes again on a slow retry or an explicit save. */
  const refusedRef=useRef<{edits:Record<string,string>;photos:Set<string>;stickers?:string}>({edits:{},photos:new Set()});
  const retryRef=useRef<{timer?:ReturnType<typeof setTimeout>;count:number;now:boolean}>({count:0,now:false});
  /** Skip notes already shown, so a retry does not bring back one the writer closed. */
  const notedRef=useRef(new Set<string>());
  /** The text an edit or the title really started from, when doc has moved on since. */
  const heldBaseRef=useRef<Record<string,string>>({});
  /** Paragraphs the file lost: typing in one that is still on screen brings it back in place. */
  const goneRef=useRef<Record<string,{source:string;after?:string;bundleId?:string}>>({});
  /** The save on its way to the server: until the reply, doc does not show what the file will be. */
  const inflightRef=useRef<SaveSnapshot>(undefined);
  /** Newest frame change seen here; a sync carries it so the frame can spot typing that crossed it. */
  const seenSeqRef=useRef(0);
  const graceUntilRef=useRef(0);
  const graceTimerRef=useRef<ReturnType<typeof setTimeout>>(undefined);
  const syncsRef=useRef(new Map<string,Map<string,string>>());
  const waitingSplitRef=useRef(false);
  const externalRef=useRef(false);
  const titleRef=useRef(title);titleRef.current=title;
  const saveReasonRef=useRef<"auto"|"manual"|"review">("auto");
  function changeEdits(next:(old:Record<string,string>)=>Record<string,string>){
    editsRef.current=next(editsRef.current);
    setEdits(editsRef.current);
  }
  function holdForUndo(){graceUntilRef.current=Date.now()+UNDO_GRACE_MS;}
  function heldItems(){
    const refused=refusedRef.current;
    return {
      paragraphs:Object.entries(editsRef.current).filter(([id,source])=>refused.edits[id]===source).length,
      photos:photosRef.current.filter(p=>refused.photos.has(p.id)).length,
      stickers:refused.stickers===JSON.stringify(stickersRef.current)?1:0,
    };
  }
  function heldTotal(){const held=heldItems();return held.paragraphs+held.photos+held.stickers;}
  /** Page-hide cannot carry this much: warn, and start an ordinary save that has no such limit. */
  function tooLargeToHandOver(){
    const snap=snapshot(true);
    if(!snap||bodyBytes(pageHideBody(snap.body))<=KEEPALIVE_LIMIT)return false;
    void autosave.current?.flush(true);
    return true;
  }
  /** The server still knows this base without the text, and the text would eat the keepalive limit. */
  function pageHideBody(body:object){const {baseText:_,...rest}=body as {baseText?:string};return rest;}
  function scheduleRefusedRetry(){
    const retry=retryRef.current;
    clearTimeout(retry.timer);
    if(!heldTotal()){retry.count=0;notedRef.current.clear();return;}
    const wait=Math.min(REFUSED_RETRY_MAX_MS,REFUSED_RETRY_MS*2**retry.count++);
    retry.timer=setTimeout(()=>{retry.now=true;void autosave.current?.flush();},wait);
  }
  /** The state to save now, or undefined when nothing can go yet. */
  function snapshot(force:boolean):{sent:SaveSnapshot;body:object}|undefined{
    const d=docRef.current;if(!d)return undefined;
    const graceOver=force||Date.now()>=graceUntilRef.current;
    const removedNow=removedParasRef.current,deletedNow=deletedRef.current;
    const again=force||retryRef.current.now,refused=refusedRef.current;
    const edits=Object.fromEntries(Object.entries(editsRef.current).filter(([id,source])=>!removedNow.includes(id)&&(again||refused.edits[id]!==source)));
    const usable=titleRef.current.trim();
    const title=usable&&titleRef.current!==d.title?titleRef.current:undefined;
    const stickerText=JSON.stringify(stickersRef.current);
    const stickers=stickerText!==JSON.stringify(d.stickers??[])&&(again||refused.stickers!==stickerText)?stickersRef.current:undefined;
    // An outside change moves the gaps, so photos go with the base they were placed on.
    const photos=graceOver||externalRef.current?photosRef.current.filter(p=>!deletedNow.includes(p.bundleId)&&(again||!refused.photos.has(p.id))):[];
    const deleteBundles=graceOver?deletedNow:[],deleteParagraphs=graceOver?removedNow:[];
    if(!Object.keys(edits).length&&title===undefined&&!stickers&&!photos.length&&!deleteBundles.length&&!deleteParagraphs.length)return undefined;
    const sent={revision:d.revision,edits,title,stickers,photos,deleteBundles,deleteParagraphs};
    return {sent,body:{
      revision:d.revision,baseText:d.sourceText,
      edits:Object.entries(edits).map(([id,source])=>({id,source,...(heldBaseRef.current[id]!==undefined?{base:heldBaseRef.current[id]}:{}),...(goneRef.current[id]?.after?{after:goneRef.current[id].after}:{})})),
      ...(title!==undefined?{title,...(heldBaseRef.current.$title!==undefined?{titleBase:heldBaseRef.current.$title}:{})}:{}),...(stickers?{stickers}:{}),...(photos.length?{photos}:{}),
      ...(deleteBundles.length?{deleteBundles}:{}),...(deleteParagraphs.length?{deleteParagraphs}:{}),
    }};
  }
  /** Moves the page to a new document in place. `sent` clears what that save carried. */
  function applyDocument(d:CanonicalDocument,sent?:SaveSnapshot,reply?:SaveReply){
    const prev=docRef.current;
    docRef.current=d;setDoc(d);
    const skips=reply?.skipped??[],written=reply?.written??{},splits=reply?.splits??{},refused=refusedRef.current;
    const skipped=new Set(skips.filter(s=>s.kind==="paragraph").map(s=>s.id));
    const sources=documentSources(d),before=prev?documentSources(prev):new Map<string,string>();
    for(const id of skipped)if(sent?.edits[id]!==undefined)refused.edits[id]=sent.edits[id];
    changeEdits(old=>Object.fromEntries(Object.entries(old).filter(([id,source])=>{
      if(skipped.has(id))return true;
      if(sent?.edits[id]===source||sent?.deleteParagraphs.includes(id)||sources.get(id)===source){
        delete heldBaseRef.current[id];delete refused.edits[id];return false;
      }
      return true;
    })));
    prev?.paragraphs.forEach((p,i)=>{
      if(!sources.has(p.id)&&!sent?.deleteParagraphs.includes(p.id))goneRef.current[p.id]={source:p.source,after:prev.paragraphs[i-1]?.id,bundleId:prev.bundles.find(b=>b.paragraphIds.includes(p.id))?.id};
    });
    for(const id of Object.keys(goneRef.current))if(sources.has(id))delete goneRef.current[id];
    /** Text that stays local now stands on what this save wrote, or on what it stood on before. */
    const rebase=(id:string)=>{
      const from=written[id]??heldBaseRef.current[id]??before.get(id);
      if(splits[id]||from===undefined||from===sources.get(id))delete heldBaseRef.current[id];
      else heldBaseRef.current[id]=from;
    };
    Object.keys(editsRef.current).forEach(rebase);
    if(sent?.title!==undefined&&sent.title===titleRef.current)delete heldBaseRef.current.$title;
    if(titleRef.current===(sent?.title??prev?.title)){titleRef.current=d.title;setTitle(d.title);}
    else rebase("$title");
    const shifted=<T extends {bundleId:string;before:number}>(items:T[])=>prev?items.map(item=>({...item,before:movedGap(prev.stickerAnchors??[],d.stickerAnchors??[],item)})):items;
    const stickerRefused=skips.some(s=>s.kind==="sticker");
    if(!stickerRefused&&JSON.stringify(stickersRef.current)===JSON.stringify(sent?.stickers??prev?.stickers??[])){stickersRef.current=d.stickers??[];setStickers(stickersRef.current);}
    else{stickersRef.current=shifted(stickersRef.current);setStickers(stickersRef.current);}
    if(stickerRefused)refused.stickers=JSON.stringify(stickersRef.current);
    else if(sent?.stickers)delete refused.stickers;
    const bundles=new Set(d.bundles.map(b=>b.id)),paragraphs=new Set(d.paragraphs.map(p=>p.id));
    if(sent?.photos.length){
      const gone=new Set(sent.photos.map(p=>p.id));
      for(const s of skips)if(s.kind==="photo"){gone.delete(s.id);refused.photos.add(s.id);}
      for(const id of gone)refused.photos.delete(id);
      photosRef.current=photosRef.current.filter(p=>!gone.has(p.id));setStickerTarget("");
    }
    photosRef.current=shifted(photosRef.current.filter(p=>bundles.has(p.bundleId)));setPhotos(photosRef.current);
    // The server would not delete these (the last bundle, say): they come back rather than wait forever.
    const undeleted=new Set(skips.some(s=>s.kind==="delete")?sent?.deleteBundles:[]);
    deletedRef.current=deletedRef.current.filter(id=>bundles.has(id)&&!undeleted.has(id));setDeleted(deletedRef.current);
    removedParasRef.current=removedParasRef.current.filter(id=>paragraphs.has(id));setRemovedParas(removedParasRef.current);
    setRemovals(old=>old.filter(r=>(r.kind==="bundle"?bundles.has(r.id)&&!undeleted.has(r.id):paragraphs.has(r.id))));
    setChanged(old=>old.filter(id=>bundles.has(id)));
    setSelected(old=>bundles.has(old)?old:(d.bundles[0]?.id??""));
    handledRef.current=new Set();
    if(prev&&d.frameVersion!==prev.frameVersion){setFrameEpoch(v=>v+1);return;}
    // What the frame's text stood on before this sync: this save's own text is not an outside change.
    syncsRef.current.set(pushDocument(splits),new Map([...before,...Object.entries(written)]));
  }
  function pushDocument(splits:Record<string,string[]>={}){
    const d=docRef.current!,token=crypto.randomUUID();
    if(Object.keys(splits).length)waitingSplitRef.current=true;
    send({type:"sync",token,html:d.articleHtml??"",title:d.title,splits,seen:seenSeqRef.current,
      keep:[...Object.keys(editsRef.current),...(titleRef.current!==d.title?["$title"]:[])]});
    return token;
  }
  /** Typing that crossed a sync on its way here started from the text the frame had then. */
  function noteCrossedBase(id:string,now:string|undefined){
    if(heldBaseRef.current[id]!==undefined)return;
    for(const before of syncsRef.current.values()){
      const old=before.get(id);
      if(old!==undefined&&old!==now){heldBaseRef.current[id]=old;return;}
    }
  }
  function markChanged(id:string){
    const latest=docRef.current,owner=goneRef.current[id]?.bundleId;
    if(!latest)return;
    const i=latest.bundles.findIndex(b=>b.paragraphIds.includes(id)||b.id===owner);
    if(i<0)return;
    setChanged(old=>[...new Set([...old,...latest.bundles.slice(Math.max(0,i-1),i+2).map(b=>b.id)])].filter(x=>!deletedRef.current.includes(x)));
    setQueued([]);
  }
  function reportReply(reply:SaveReply){
    const notes:string[]=[];
    const conflicts=reply.conflicts??[];
    const kept=conflicts.filter(c=>c.kind!=="delete"),removed=conflicts.filter(c=>c.kind==="delete");
    if(kept.length)notes.push(`다른 곳에서도 고친 부분(${kept.map(c=>c.id==="$title"?"제목":c.id).join(", ")})은 지금 쓰신 글을 남겼어요. 다른 버전은 원고 폴더의 .history에 보관했어요.`);
    if(removed.length)notes.push(`지운 부분(${removed.map(c=>c.id).join(", ")})은 다른 곳에서도 고쳐졌지만 삭제를 유지했어요. 고친 글은 원고 폴더의 .history에 보관했어요.`);
    for(const s of reply.skipped??[]){
      const key=[s.kind,s.id,s.reason].join("\n");
      if(notedRef.current.has(key))continue;
      notedRef.current.add(key);
      notes.push(s.kind==="title"?s.reason:`${s.kind==="paragraph"?s.id+" 문단":s.kind==="photo"?"사진 1장":s.kind==="sticker"?"스티커 배치":"삭제"}은 저장하지 못했고 나머지는 저장했어요. ${s.reason}`);
    }
    if(notes.length)setSyncNote(notes.join(" "));
  }
  /** Runs inside the autosave cycle: one at a time, always from the latest state. */
  async function runSave(force:boolean){
    const d=docRef.current;
    if(!d)return;
    // A split waiting for an IME composition still owns that paragraph's text.
    if(waitingSplitRef.current){setTimeout(()=>autosave.current?.touch(),300);return;}
    const snap=snapshot(force);
    retryRef.current.now=false;
    if(!snap){
      if(externalRef.current){
        externalRef.current=false;
        const latest=await api("document");
        if(latest.revision!==docRef.current?.revision)applyDocument(latest);
      }
    }else{
      externalRef.current=false;
      inflightRef.current=snap.sent;
      let reply:SaveReply;
      try{reply=await api("save",snap.body);}
      finally{inflightRef.current=undefined;}
      applyDocument(reply.document,snap.sent,reply);
      reportReply(reply);
      scheduleRefusedRetry();
      setSavedForReview(saveReasonRef.current==="review");
      if(saveReasonRef.current==="manual")setNotice("정본과 미리보기를 저장했어요. 저장 전 사본도 보관했어요.");
      saveReasonRef.current="auto";
    }
    armGrace();
  }
  /** Undoable changes wait out their grace period, then save like any other change. */
  function armGrace(){
    clearTimeout(graceTimerRef.current);
    if(!deletedRef.current.length&&!removedParasRef.current.length&&!photosRef.current.some(p=>!refusedRef.current.photos.has(p.id)))return;
    const wait=graceUntilRef.current-Date.now();
    // Past the grace period, what remains either goes with this timer or has nothing left to send.
    if(wait<=0&&!snapshot(false))return;
    graceTimerRef.current=setTimeout(()=>void autosave.current?.flush(),wait>0?wait+20:1000);
  }
  const runSaveRef=useRef(runSave);runSaveRef.current=runSave;
  const autosave=useRef<ReturnType<typeof createAutosave>>(undefined);
  useEffect(()=>{
    const saver=createAutosave({
      save:force=>runSaveRef.current(force),
      onState:(s:AutosaveState)=>{
        if(s.phase==="failed"){setSaveState("failed");setSaveRetry({error:s.error??"",retryInMs:s.retryInMs??0});return;}
        if(s.phase==="saving"){setSaveState("saving");return;}
        setSaveState("idle");setSaveRetry(undefined);
      },
    });
    autosave.current=saver;
    return ()=>{saver.stop();clearTimeout(graceTimerRef.current);clearTimeout(retryRef.current.timer);};
  },[]);
  useEffect(()=>{
    if(!live||!dirty)return;
    autosave.current?.touch();armGrace();
  },[live,edits,title,stickers,photos,deleted,removedParas]);
  useEffect(()=>{
    if(!live)return;
    const hide=()=>{if(document.visibilityState==="hidden"&&autosave.current?.pending)void autosave.current.flush();};
    // The page is going away: last chance, so undoable changes go too. A save in flight may
    // carry the same edits: the server takes the same text and the same split twice unharmed.
    const leave=()=>{
      const snap=snapshot(true);if(!snap)return;
      const body=pageHideBody(snap.body);
      // beforeunload already warned and started an ordinary save for a body this large.
      if(bodyBytes(body)>KEEPALIVE_LIMIT)return;
      void fetch("/api/blog/save",{method:"POST",keepalive:true,headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).catch(()=>{});
    };
    document.addEventListener("visibilitychange",hide);window.addEventListener("pagehide",leave);
    return()=>{document.removeEventListener("visibilitychange",hide);window.removeEventListener("pagehide",leave);};
  },[live]);
  /** Saves everything now, undoable changes included. */
  async function flushNow(reason:"manual"|"review"):Promise<CanonicalDocument|undefined>{
    saveReasonRef.current=reason;
    const ok=await autosave.current?.flush(true);
    return ok?docRef.current:undefined;
  }
  async function save(reason:"manual"|"review"="manual"): Promise<CanonicalDocument | undefined> {
    if (!doc) return;
    if (doc.format==="markup") return flushNow(reason);
    if (Object.keys(invalid).length) {
      setSaveState("failed");
      setError("입력 오류가 있는 문단을 고친 뒤 저장해주세요.");
      return;
    }
    setBusy(true);setSaveState("saving");
    setError("");
    try {
      const result = await api("save", {
        revision: doc.revision,
        edits: Object.entries(edits).filter(([id]) => !removedParas.includes(id)).map(([id, source]) => ({ id, source })),
        ...(removedParas.length ? { deleteParagraphs: removedParas } : {}),
        ...(title !== doc.title ? { title } : {}),
        ...(stickersDirty ? {stickers} : {}),
        ...(photos.some(p=>!deleted.includes(p.bundleId)) ? {photos:photos.filter(p=>!deleted.includes(p.bundleId))} : {}),
        ...(deleted.length ? { deleteBundles: deleted } : {}),
      });
      setDoc(result.document);setStickers(result.document.stickers??[]);
      // Saved photos renumber the gaps, so an old position would point somewhere else.
      if(photos.length){setPhotos([]);setStickerTarget("");}
      setFrameEpoch(v=>v+1);setSaveState("idle");setSavedForReview(reason==="review");
      setTitle(result.document.title);
      setEdits({});setDeleted([]);setRemovedParas([]);setRemovals([]);
      setChanged((old) => old.filter((id) => result.document.bundles.some((b: { id: string }) => b.id === id)));
      setSelected((old) => result.document.bundles.some((b: { id: string }) => b.id === old) ? old : (result.document.bundles[0]?.id ?? ""));
      handledRef.current = new Set();
      setSelectionFormat(undefined);
      setNotice(
        "정본과 미리보기를 저장했어요. 저장 전 사본도 보관했어요.",
      );
      return result.document;
    } catch (e) {
      setSaveState("failed");setError("저장하지 못했어요. 편집 내용은 화면에 남아 있어요. "+String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }
  function cancelSuggest(message?: string) {
    const s = suggestRef.current;
    if (!s) return;
    suggestRef.current = null;
    s.controller.abort();
    setSuggesting(false);
    send({ type: "suggest-cancel", token: s.token });
    if (message) setNotice(message);
  }
  async function runSuggest(token: string, paragraphId: unknown, runs: unknown, offset: unknown) {
    const d = docRef.current;
    if (!d) return;
    const fail = (message: string) => {
      send({ type: "suggest-result", token, error: true });
      setError(message);
    };
    if (d.format !== "markup") return fail("이 형식에서는 추천을 지원하지 않아요.");
    if (busyRef.current) return fail("저장이나 검토 준비가 끝난 뒤 다시 요청해주세요.");
    if (typeof paragraphId !== "string" || !d.paragraphs.some((p) => p.id === paragraphId) || !Array.isArray(runs) || typeof offset !== "number" || !Number.isInteger(offset) || offset < 0)
      return fail("추천할 문단을 찾지 못했어요. 본문 문단을 클릭한 뒤 다시 요청해주세요.");
    let source: string;
    try {
      source = inlineSource(runs as InlineRun[]);
      readInline(source);
    } catch (e) {
      return fail("이 문단의 입력 오류를 고친 뒤 추천을 요청해주세요. " + errorText(e));
    }
    suggestRef.current?.controller.abort();
    const controller = new AbortController(),
      requestId = crypto.randomUUID(),
      revision = d.revision;
    suggestRef.current = { requestId, token, controller };
    setSuggesting(true);
    setError("");
    setNotice("커서 위치에 이어 쓸 문장을 추천받는 중이에요. Esc로 취소할 수 있어요.");
    try {
      const result = await api("suggest", { requestId, revision, paragraphId, source, offset }, controller.signal);
      if (suggestRef.current?.requestId !== requestId) return;
      const suggestions = (Array.isArray(result?.suggestions) ? result.suggestions : [])
        .map((s: unknown) => (typeof s === "string" ? s : (s as { text?: unknown } | null)?.text))
        .filter((s: unknown): s is string => typeof s === "string" && !!s.trim())
        .slice(0, 3);
      // Autosave changes the revision without touching the caret, so for markup the
      // frame's own check of paragraph text, caret and focus decides.
      const stale =
        (docRef.current?.format !== "markup" && docRef.current?.revision !== revision) ||
        (typeof result?.paragraphId === "string" && result.paragraphId !== paragraphId) ||
        (typeof result?.offset === "number" && result.offset !== offset);
      send({ type: "suggest-result", token, suggestions, stale });
    } catch (e) {
      if (controller.signal.aborted || suggestRef.current?.requestId !== requestId) return;
      send({ type: "suggest-result", token, error: true });
      setError("추천을 받지 못했어요. " + errorText(e));
    } finally {
      if (suggestRef.current?.requestId === requestId) {
        suggestRef.current = null;
        setSuggesting(false);
      }
    }
  }
  const runSuggestRef = useRef(runSuggest);
  runSuggestRef.current = runSuggest;
  const cancelSuggestRef = useRef(cancelSuggest);
  cancelSuggestRef.current = cancelSuggest;
  useEffect(() => {
    // Saving, reloading or reviewing replaces the frame: drop a pending request.
    if (busy) cancelSuggestRef.current();
  }, [busy]);
  useEffect(() => {
    if (!suggesting) return;
    const key = (e: KeyboardEvent) => {
      // Esc that ends an IME composition (e.g. Korean in a host field) is not a cancel.
      if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing && e.keyCode !== 229) cancelSuggestRef.current("추천 요청을 취소했어요.");
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [suggesting]);
  useEffect(() => () => suggestRef.current?.controller.abort(), []);
  async function request(scope: "selected" | "changed", only?: string[]) {
    if (!doc || busy) return;
    const ids = (only ?? (scope === "selected" ? [selected] : changed)).filter((id) => !deleted.includes(id));
    if (!ids.length) return;
    const savedBeforeReview=dirty;
    const current = savedBeforeReview ? await save("review") : doc;
    if (!current) return;
    setBusy(true);setReviewPreparing(true);
    setError("");
    try {
      await api("review", { revision: current.revision, bundleIds: ids });
      setReviewOpen(true);
      setQueued((old) => [...new Set([...old, ...ids])]);
      setNotice(
        savedBeforeReview ? "변경 내용을 먼저 저장하고 검토를 요청했어요. 따로 저장하지 않아도 됩니다." : doc.format==="markup" ? "저장된 내용으로 검토를 요청했어요. 실행 상태와 결과가 자동으로 갱신됩니다." : "저장된 내용으로 검토를 요청했어요.",
      );
    } catch (e) {
      setError((savedBeforeReview?"저장은 완료됐지만 검토 요청에 실패했어요. ":"검토 요청에 실패했어요. ")+String(e));
    } finally {
      setBusy(false);setReviewPreparing(false);
    }
  }
  useEffect(()=>{
    if(doc?.format!=="markup")return;
    let alive=true;
    const poll=async()=>{try{
      const result=await api("review-status");
      if(alive){
        setReviewJobs(result.requests);setQueued(result.requests.filter((j:any)=>["pending","running"].includes(j.status)).flatMap((j:any)=>j.bundleIds));setReviewStatusError("");
        setDoc(old=>old?{...old,reviews:result.reviews}:old);
        // The file moved without this page: merge through a save, or update in place.
        if(result.revision&&result.revision!==docRef.current?.revision){externalRef.current=true;void autosave.current?.flush();}
      }
    }catch(e){if(alive)setReviewStatusError("검토 상태를 확인하지 못했어요: "+String(e));}};
    void poll();const timer=setInterval(()=>void poll(),1500);
    return()=>{alive=false;clearInterval(timer);};
  },[doc?.format]);
  const requestRef = useRef(request);
  requestRef.current = request;
  function deleteBundle(id: string) {
    if (!doc || busy) return;
    if (doc.format !== "markup") return setError("이 형식에서는 묶음 삭제를 지원하지 않아요.");
    const remaining = doc.bundles.filter((b) => !deleted.includes(b.id));
    const i = remaining.findIndex((b) => b.id === id);
    if (i < 0) return;
    if (remaining.length <= 1) return setError("마지막 묶음은 지울 수 없어요.");
    const next = [...deleted, id];
    holdForUndo();
    setDeleted(next);
    setRemovals((old) => [...old, { kind: "bundle", id }]);
    send({ type: "hide-bundles", ids: next });
    // The neighbours now meet each other, so their transition needs review.
    setChanged((old) => [...new Set([...old, ...[remaining[i - 1], remaining[i + 1]].filter(Boolean).map((b) => b!.id)])].filter((x) => !next.includes(x)));
    setQueued([]);
    const neighbour = remaining[i + 1] ?? remaining[i - 1];
    if (selected === id && neighbour) setSelected(neighbour.id);
    setError("");
    setNotice(`‘${remaining[i].name}’ 묶음을 지웠어요. 몇 초 뒤 저장돼요. 그 전에 삭제 취소로 되돌릴 수 있어요.`);
  }
  function removeParagraph(id: string) {
    if (!doc || busy || doc.format !== "markup") return;
    const p = doc.paragraphs.find((x) => x.id === id);
    const bundle = doc.bundles.find((b) => b.paragraphIds.includes(id));
    if (!p || !bundle || deleted.includes(bundle.id) || removedParas.includes(id)) return;
    const others = bundle.paragraphIds.filter((x) => !removedParas.includes(x));
    // The bundle's last paragraph: remove the whole bundle (photos included), undoable.
    if (others.length <= 1) return deleteBundle(bundle.id);
    const next = [...removedParas, id];
    holdForUndo();
    setRemovedParas(next);
    setRemovals((old) => [...old, { kind: "paragraph", id }]);
    setInvalid((old) => { const n = { ...old }; delete n[id]; return n; });
    send({ type: "hide-paragraphs", ids: next });
    const i = doc.bundles.findIndex((b) => b.id === bundle.id);
    setChanged((old) => [...new Set([...old, ...doc.bundles.slice(Math.max(0, i - 1), i + 2).map((b) => b.id)])].filter((x) => !deleted.includes(x)));
    setQueued([]);
    setError("");
    setNotice("빈 문단을 지웠어요. 몇 초 뒤 저장돼요. 그 전에 삭제 취소로 되돌릴 수 있어요.");
  }
  /** A delete on its way to the server can no longer be taken back from this page. */
  function deleteInFlight(item:{kind:"bundle"|"paragraph";id:string}){
    const sending=inflightRef.current;
    return !!sending&&(item.kind==="bundle"?sending.deleteBundles:sending.deleteParagraphs).includes(item.id);
  }
  function undoDelete() {
    const last = removals.at(-1);
    if (!last) return;
    if (deleteInFlight(last)) return setNotice("삭제를 이미 저장하는 중이라 되돌릴 수 없어요. 지운 내용은 원고 폴더의 .history에 있어요.");
    setRemovals(removals.slice(0, -1));
    if (last.kind === "paragraph") {
      const next = removedParas.filter((x) => x !== last.id);
      setRemovedParas(next);
      send({ type: "hide-paragraphs", ids: next });
      setNotice("문단 삭제를 취소했어요.");
      return;
    }
    const next = deleted.filter((x) => x !== last.id);
    setDeleted(next);
    send({ type: "hide-bundles", ids: next });
    setSelected(last.id);
    setNotice("묶음 삭제를 취소했어요.");
  }
  const removeParaRef = useRef(removeParagraph);
  removeParaRef.current = removeParagraph;
  const removedParasRef = useRef(removedParas);
  removedParasRef.current = removedParas;
  const deleteRef = useRef(deleteBundle);
  deleteRef.current = deleteBundle;
  const deletedRef = useRef(deleted);
  deletedRef.current = deleted;
  function saveShortcut() {
    if (busyRef.current) return;
    if (!live && Object.keys(invalid).length) return setError("입력 오류가 있는 문단을 고친 뒤 저장해주세요.");
    if (!dirty) return setNotice(titleBlank?"제목을 입력하면 저장돼요. 본문은 그대로 저장돼 있어요.":"저장할 변경이 없어요.");
    void save();
  }
  const saveShortcutRef = useRef(saveShortcut);
  saveShortcutRef.current = saveShortcut;
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.code === "KeyS" && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        saveShortcutRef.current();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  function resendDrafts(){
    if(docRef.current?.format==="markup"){sendStickers();sendPhotos();}
    send({ type: "hide-bundles", ids: deletedRef.current });
    send({ type: "hide-paragraphs", ids: removedParasRef.current });
    send({ type: "lock", locked: busyRef.current });
    send({ type: "proposals", items: proposalsRef.current, locked: busyRef.current });
  }
  useEffect(() => {
    const listener = (e: MessageEvent) => {
      if (
        e.origin !== location.origin ||
        e.source !== frame.current?.contentWindow ||
        !e.data?.editor ||
        !doc
      )
        return;
      const m = e.data;
      if (m.type === "blur" && live && autosave.current?.pending) void autosave.current.flush();
      if (m.type === "deferred-applied" && typeof m.id === "string") {
        delete heldBaseRef.current[m.id];
        // A paragraph held only by the caret left: the frame can now match the file.
        if (m.gone) pushDocument();
      }
      if (m.type === "synced") {
        waitingSplitRef.current = false;
        const before = syncsRef.current.get(m.token);
        syncsRef.current.delete(m.token);
        const now = docRef.current ? documentSources(docRef.current) : new Map<string, string>();
        for (const id of Array.isArray(m.held) ? m.held : []) {
          const old = before?.get(id);
          if (old !== undefined && old !== now.get(id)) heldBaseRef.current[id] ??= old;
        }
        resendDrafts();
        return;
      }
      if(m.type==="annotation-open")setReviewOpen(true);
      if(m.type==="annotate"&&doc.format==="markup"&&typeof m.text==="string"&&typeof m.context==="string"&&doc.paragraphs.some(p=>p.id===m.id)){
        setAnnotationTarget({id:m.id,text:m.text,context:m.context,checked:!!m.checked,requestId:crypto.randomUUID()});
        setReviewOpen(true);
      }
      if(m.type==="chat-attach"&&doc.format==="markup"&&typeof m.id==="string"&&typeof m.text==="string"&&m.text.trim()&&m.text.length<=CHAT_LIMITS.quote&&doc.paragraphs.some(p=>p.id===m.id)&&!removedParasRef.current.includes(m.id)){
        const quote=m.text as string,paragraphId=m.id as string;
        setChatAttachments(old=>{
          if(old.some(a=>a.paragraphId===paragraphId&&a.quote===quote))return old;
          // Keep the newest phrases within the request limit.
          return [...old,{key:crypto.randomUUID(),paragraphId,quote}].slice(-CHAT_LIMITS.attachments);
        });
        setChatFocus(crypto.randomUUID());
        setReviewOpen(true);
      }
      if(m.type==="sticker-anchor" && doc.stickerAnchors?.some(a=>a.bundleId===m.bundleId && a.before===m.before))setStickerTarget(stickerKey(m));
      if (m.type === "typography") setTypography(m.styles);
      if (m.type === "selection") setSelectionFormat(m.selection ?? undefined);
      if (m.type === "ready") {
        // A reloaded frame has no spinner or caret for an old request.
        if (suggestRef.current) cancelSuggestRef.current();
        waitingSplitRef.current=false;seenSeqRef.current=0;syncsRef.current.clear();
        resendDrafts();
        // A reloaded frame shows the file; unsaved text lives here and goes back in.
        if(doc.format==="markup"){
          for(const [id,source] of Object.entries(editsRef.current))send({type:"replace",id,html:inlineHtml(source)});
          if(titleRef.current!==(docRef.current??doc).title)send({type:"replace",id:"$title",html:escapeHtml(titleRef.current)});
        }
      }
      if (m.type === "proposal-action" && typeof m.id === "string" && (m.action === "apply" || m.action === "keep")) {
        const item = proposalsRef.current.find((i) => i.id === m.id);
        if (!item || busyRef.current || handledRef.current.has(item.id) || item.state === "decided") return;
        const finding = doc.reviews.find((r) => r.bundleId === item.bundleId)?.findings.find((f) => f.id === item.findingId);
        // The click refers to the proposal the frame displayed. If polling replaced
        // the finding behind the same id meanwhile, refuse instead of applying
        // (or hiding) content the user never saw.
        if (!finding || typeof m.sig !== "string" || m.sig !== proposalSignature(finding) || m.sig !== item.sig) {
          setError("제안 내용이 방금 바뀌었어요. 본문에 다시 표시된 제안을 확인한 뒤 선택해주세요.");
          return;
        }
        if (m.action === "keep") {
          // Keeping never touches the body; it only hides the proposal on this screen.
          handledRef.current.add(item.id);
          setDecisions((old) => ({ ...old, [item.id]: "현재 유지" }));
          return;
        }
        if (!item.canApply) {
          setError(item.reason || "이 제안은 지금 적용할 수 없어요.");
          return;
        }
        if (applyRef.current(finding, item.id)) handledRef.current.add(item.id);
      }
      if (m.type === "height" && Number.isFinite(m.height))
        setHeight(Math.min(100000, Math.max(500, m.height)));
      if (m.type === "save") saveShortcutRef.current();
      if (m.type === "delete-bundle" && typeof m.bundleId === "string") deleteRef.current(m.bundleId);
      if (m.type === "remove-paragraph" && typeof m.id === "string") removeParaRef.current(m.id);
      if (m.type === "select" && doc.bundles.some((b) => b.id === m.bundleId))
        setSelected(m.bundleId);
      if (m.type === "scroll" && Number.isFinite(m.top) && frame.current)
        window.scrollTo({
          top:
            frame.current.getBoundingClientRect().top +
            window.scrollY +
            m.top -
            (parseFloat(
              root.current?.style.getPropertyValue("--ce-chrome-height") ?? "",
            ) || 160) -
            12,
          behavior: "smooth",
        });
      if (m.type === "review")
        void requestRef.current(m.scope === "changed" ? "changed" : "selected");
      if (m.type === "review-bundle" && typeof m.bundleId === "string" && doc.bundles.some((b) => b.id === m.bundleId)) {
        setSelected(m.bundleId);
        void requestRef.current("selected", [m.bundleId]);
      }
      if (m.type === "reveal" && Number.isFinite(m.top) && Number.isFinite(m.bottom) && frame.current) {
        // Scroll only when the target is outside the visible area below the sticky chrome.
        const chrome = parseFloat(root.current?.style.getPropertyValue("--ce-chrome-height") ?? "") || 160;
        const base = frame.current.getBoundingClientRect().top;
        const top = base + m.top, bottom = base + m.bottom;
        if (top < chrome + 8 || bottom > window.innerHeight - 8)
          window.scrollTo({ top: window.scrollY + top - chrome - Math.max(24, (window.innerHeight - chrome) * 0.3), behavior: "smooth" });
      }
      if (m.type === "suggest" && typeof m.token === "string")
        void runSuggestRef.current(m.token, m.id, m.runs, m.offset);
      if (m.type === "suggest-cancel" && typeof m.token === "string" && suggestRef.current?.token === m.token) {
        cancelSuggestRef.current(m.stale ? SUGGEST_STALE : m.notify ? "추천 요청을 취소했어요." : undefined);
      }
      if (m.type === "suggest-error" && typeof m.message === "string") {
        setError("");
        setNotice(m.message);
      }
      if (m.type === "suggest-done") {
        if (m.outcome === "stale") setNotice(SUGGEST_STALE);
        else if (m.outcome === "empty") setNotice("이 위치에 추천할 문장이 없어요.");
        else if (m.outcome === "shown")
          setNotice(`회색 추천${m.count > 1 ? ` ${m.count}개` : ""} · Tab 수락 · ⌘/Ctrl+→ 한 어절${m.count > 1 ? " · ⌥/Alt+] 다른 추천" : ""} · Esc 닫기. 수락 전에는 본문이 바뀌지 않아요.`);
      }
      if (m.type === "change")
        try {
          if (Number.isFinite(m.seq)) seenSeqRef.current = Math.max(seenSeqRef.current, m.seq);
          if (!Array.isArray(m.runs)) return;
          // The newest document decides what counts as an edit, not the one this listener saw.
          const latest = docRef.current ?? doc;
          const runs = latest.format === "markup" ? safeRuns(m.runs as InlineRun[]) : m.runs as InlineRun[];
          const source = inlineSource(runs);
          readInline(source);
          setInvalid((old) => {
            const next = { ...old };
            delete next[m.id];
            return next;
          });
          if (m.id === "$title") {
            const next = (m.runs as InlineRun[]).map((r) => r.text).join("");
            noteCrossedBase("$title", latest.title);
            titleRef.current = latest.format === "markup" ? next.replace(/\s*\n\s*/g, " ") : next;
            setTitle(titleRef.current);
            setChanged(latest.bundles.map((b) => b.id));
            return;
          }
          const gone = goneRef.current[m.id];
          const p = latest.paragraphs.find((p) => p.id === m.id) ?? (gone && { id: m.id as string, source: gone.source });
          if (!p) return;
          // A save on its way will change the file, so matching the old text is an edit, not a return to clean.
          const settled = source === p.source && !(inflightRef.current && p.id in inflightRef.current.edits);
          const had = editsRef.current[p.id];
          if (settled ? had === undefined : had === source) return;
          if (had === undefined) {
            noteCrossedBase(p.id, p.source);
            if (gone) heldBaseRef.current[p.id] ??= gone.source;
          }
          changeEdits((old) => {
            const next = { ...old };
            if (settled) {
              delete next[p.id];
              delete heldBaseRef.current[p.id];
            } else next[p.id] = source;
            return next;
          });
          markChanged(p.id);
        } catch (e) {
          // Only this paragraph waits; it stays on screen and everything else keeps saving.
          setInvalid((old) => ({ ...old, [m.id]: String(e) }));
          setNotice("이 문단의 서식을 읽지 못해 이 문단만 저장을 미뤘어요. 다른 문단은 계속 저장돼요.");
        }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [doc]);
  function apply(f: CanonicalFinding, key = f.id): boolean {
    if (!doc || busy) return false;
    const p = f.proposal;
    const id = findingTarget(f);
    const original = doc.paragraphs.find((t) => t.id === id);
    if (!p || !original) return false;
    // editsRef is updated synchronously below so back-to-back applies in one
    // paragraph re-validate against the newest text, not a stale render.
    let source = editsRef.current[original.id] ?? original.source;
    try {
      if(doc.format==="markup"){const state=findingApplicability(f,source);if(!state.canApply)throw new Error(state.reason);}
      source = applyFinding(f, source);
      // Replacing the text drops whatever older text a focused paragraph was still showing.
      if(!(original.id in editsRef.current))delete heldBaseRef.current[original.id];
      editsRef.current={...editsRef.current,[original.id]:source};
      setEdits(old=>({...old,[original.id]:source}));
      send({ type: "replace", id: original.id, html: inlineHtml(source) });
      markChanged(original.id);
      setDecisions((old) => ({ ...old, [key]: "적용 · 저장 전" }));
      setNotice(doc.format==="markup"?"본문에 반영했어요. 곧 자동으로 저장돼요.":"본문에 반영했어요. 아직 저장 전입니다. 정본 저장 또는 저장 후 검토를 눌러주세요.");
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }
  const applyRef = useRef(apply);
  applyRef.current = apply;
  /** Current (possibly unsaved) source of a paragraph, or undefined when it is gone. */
  function chatSource(id:string){
    if(!doc||removedParas.includes(id))return undefined;
    const p=doc.paragraphs.find(x=>x.id===id);
    if(!p||deleted.includes(doc.bundles.find(b=>b.paragraphIds.includes(id))?.id??""))return undefined;
    return editsRef.current[id]??p.source;
  }
  function chatPlain(id:string){
    const source=chatSource(id);
    return source===undefined?undefined:readInline(source).map(r=>r.text).join("");
  }
  /** `본문에 반영` from the chat: same replace path as review proposals. Returns an error message on failure. */
  function applyChatRewrite(rw:BlogChatRewrite):string|undefined{
    if(!doc||busy)return "지금은 본문을 바꿀 수 없어요. 잠시 후 다시 시도해주세요.";
    const source=chatSource(rw.paragraphId);
    if(source===undefined)return "문단이 지워졌거나 찾을 수 없어요.";
    try{
      const plain=readInline(source).map(r=>r.text).join("");
      const start=plain.indexOf(rw.quote);
      if(start<0)return "구절이 본문에서 바뀌었어요. 다시 선택해 물어보세요.";
      if(plain.indexOf(rw.quote,start+1)>=0)return "같은 구절이 문단에 여러 번 있어요. 본문에서 직접 고쳐주세요.";
      const next=replaceInlineText(source,start,start+rw.quote.length,rw.replacement);
      readInline(next);
      if(!(rw.paragraphId in editsRef.current))delete heldBaseRef.current[rw.paragraphId];
      editsRef.current={...editsRef.current,[rw.paragraphId]:next};
      const original=doc.paragraphs.find(p=>p.id===rw.paragraphId)!;
      setEdits(old=>{const n={...old};if(next===original.source)delete n[rw.paragraphId];else n[rw.paragraphId]=next;return n;});
      send({type:"replace",id:rw.paragraphId,html:inlineHtml(next)});
      markChanged(rw.paragraphId);
      setError("");
      setNotice("채팅 제안을 본문에 반영했어요. 곧 자동으로 저장돼요.");
      return undefined;
    }catch(e){return errorText(e);}
  }
  async function saveChatMemo(input:{paragraphId:string;quote:string;context:string;note:string}){
    const r=await fetch("/api/blog/annotations",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"add",id:crypto.randomUUID(),...input,checked:false})});
    const value=await r.json();
    if(!r.ok)throw new Error(value.error??"메모를 저장하지 못했어요.");
    send({type:"annotations-changed"});
    setNotice("답변을 구절 메모로 남겼어요. 메모는 원고와 따로 비공개로 저장돼요.");
  }
  const review = doc?.reviews.find((r) => r.bundleId === selected);
  const reviewItems = proposals.filter((i) => i.bundleId === selected);
  const reviewCounts = {
    body: reviewItems.filter((i) => hasBodyMark(i, doc!)).length,
    available: reviewItems.filter((i) => i.canApply).length,
    check: reviewItems.filter((i) => !i.canApply && !["applied", "decided"].includes(i.state)).length,
  };
  function revealProposal(item: InlineProposal) {
    if (narrow) setReviewOpen(false);
    setSelected(item.bundleId);
    send({ type: "reveal-proposal", id: item.id });
  }
  const bundle = doc?.bundles.find((b) => b.id === selected);
  const held = heldItems();
  const heldLabel = [held.paragraphs&&`문단 ${held.paragraphs}개`,held.photos&&`사진 ${held.photos}장`,held.stickers&&"스티커 배치"].filter(Boolean).join(" · ");
  const lastRemoval = removals.at(-1);
  const format = (command: string, value?: string) =>
    send({ type: "format", command, value });
  if (!doc)
    return (
      <main className="canonical-loading">
        <h1>릴스 스마트 에디터</h1>
        <p>{error || "정본과 사진을 불러오는 중…"}</p>
        <button onClick={() => void load()}>다시 불러오기</button>
      </main>
    );
  return (
    <main
      ref={root}
      className="canonical-editor"
      onKeyDown={(e) => {
        if (
          (e.metaKey || e.ctrlKey) &&
          e.key === "Enter" &&
          !e.nativeEvent.isComposing
        ) {
          e.preventDefault();
          void request(e.shiftKey ? "changed" : "selected");
        }
      }}
    >
      {doc.fontCss && <style>{doc.fontCss}</style>}
      {doc.warnings?.map((warning,i)=><p key={i} className="ce-warning" role="status">{warning}</p>)}
      <header className="ce-header">
        <div>
          <small>REELS DASHBOARD / BLOG</small>
          <h1>릴스 스마트 에디터</h1>
        </div>
        <span id="ce-save-status" className={"ce-status ce-save-status "+(saveState==="failed"||heldLabel?"is-error":dirty||titleBlank?"is-dirty":"is-saved")} role="status" aria-live="polite">
          <strong>{saveState==="saving"?"저장 중…":saveState==="failed"?(live?"저장 실패 · 자동으로 다시 시도":"저장 실패 · 편집 내용 유지"):heldLabel?"● 일부 저장 안 됨":dirty?"● 저장 전 변경":titleBlank?"● 제목 비어 있음":"✓ 저장 완료"}</strong>
          <small>{saveState==="saving"?"원고와 미리보기를 저장하고 있어요.":saveState==="failed"&&saveRetry?`편집 내용은 그대로예요. ${Math.ceil(saveRetry.retryInMs/1000)}초 뒤 다시 저장해요.`:heldLabel?`${heldLabel}은 아직 파일에 없어요. 자동으로 다시 시도해요.`:titleBlank&&!dirty?"제목을 입력하면 저장돼요. 본문은 계속 저장돼요.":dirty?(live?(deleted.length||removedParas.length||photos.length?"삭제·사진은 몇 초 뒤 저장돼요.":"곧 자동으로 저장돼요."):"아직 파일에 저장되지 않았어요."):doc.savedAt?<><time dateTime={doc.savedAt} title={new Date(doc.savedAt).toLocaleString()}>{new Date(doc.savedAt).toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false})}</time>{savedForReview?" · 검토 전에 자동 저장했어요.":live?" · 변경은 자동으로 저장돼요.":" · 저장할 변경이 없어요."}</>:"저장할 변경이 없어요."}</small>
        </span>
        {!live && <button
          disabled={busy}
          onClick={() => {
            if (
              !dirty ||
              confirm("저장 전 편집을 버리고 최신 정본을 불러올까요?")
            )
              void load();
          }}
        >
          다시 불러오기
        </button>}
        <button
          className={"ce-primary"+(!dirty&&saveState==="idle"?" ce-save-done":"")}
          aria-label="정본 저장"
          aria-describedby="ce-save-status"
          title={saveState==="saving"?"저장 중입니다":dirty?"현재 편집 내용을 파일에 저장합니다":"모든 변경이 저장돼 있어요"}
          disabled={busy || !dirty || saveState==="saving" || (!live && Object.keys(invalid).length > 0)}
          onClick={() => void save()}
        >
          {saveState==="saving"?"저장 중…":!dirty?"✓ 저장됨":"정본 저장"}
        </button>
      </header>
      <div className="ce-toolbar">
        <FormattingToolbar
          selection={selectionFormat}
          disabled={busy}
          onFormat={format}
        />
        <div className="ce-review-actions">
          <button
            className="ce-suggest"
            aria-keyshortcuts="Alt+Backslash"
            aria-busy={suggesting || undefined}
            title={doc.format === "markup" ? "커서 위치에 이어 쓸 문장을 추천받아요 (⌥\\)" : "이 형식에서는 추천을 지원하지 않아요. 마크업 원고에서 사용할 수 있어요."}
            disabled={doc.format !== "markup" || busy || suggesting}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => send({ type: "suggest-start" })}
          >
            {suggesting ? (
              <>
                <span className="ce-spin" aria-hidden="true" />
                추천 중… (Esc 취소)
              </>
            ) : (
              "✦ 추천 받기"
            )}
          </button>
          {doc.format==="markup" && <button aria-expanded={photoOpen} aria-controls="ce-photo-picker" onClick={()=>setPhotoOpen(!photoOpen)}>사진 넣기 ({photos.length})</button>}
          {doc.format==="markup" && <button aria-expanded={stickerOpen} aria-controls="ce-sticker-planner" onClick={()=>setStickerOpen(!stickerOpen)}>스티커 ({stickers.length})</button>}
          <label>
            본문 폭{" "}
            <select
              aria-label="본문 보기 폭"
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
            >
              <option value={430}>모바일</option>
              <option value={900}>PC</option>
            </select>
          </label>
          {doc.format==="markup" && <button
            aria-keyshortcuts="Delete"
            title="선택한 묶음을 지웁니다. 본문에서 묶음의 글 밖(사진·이름표)을 클릭한 뒤 Delete/Backspace로도 지울 수 있어요. 몇 초 안에 삭제 취소로 되돌릴 수 있어요."
            disabled={busy || !bundle || doc.bundles.length - deleted.length <= 1}
            onClick={() => deleteBundle(selected)}
          >
            묶음 삭제
          </button>}
          {removals.length > 0 && <button disabled={busy || (!!lastRemoval && deleteInFlight(lastRemoval))} title={lastRemoval && deleteInFlight(lastRemoval) ? "삭제를 저장하는 중이에요" : undefined} onClick={undoDelete}>삭제 취소 ({removals.length})</button>}
          <button aria-label="이 묶음 검토" title={dirty?"변경 내용을 먼저 저장한 뒤 검토합니다":"저장된 내용으로 검토합니다"} disabled={busy} onClick={() => void request("selected")}>
            {dirty?"저장 후 이 묶음 검토":"이 묶음 검토"}
          </button>
          <button
            disabled={busy || !changed.length}
            onClick={() => void request("changed")}
          >
            {dirty?"저장 후 변경분 검토":"변경분 검토"} ({changed.length})
          </button>
          <button
            className="ce-review-toggle"
            aria-expanded={reviewOpen}
            onClick={() => setReviewOpen(true)}
          >
            검토 보기
          </button>
        </div>
      </div>
      {syncNote && <p className="ce-sync-note" role="status">{syncNote} <button aria-label="알림 닫기" onClick={()=>setSyncNote("")}>닫기</button></p>}
      <div className="ce-feedback" aria-live="polite">
        {saveState==="failed"&&saveRetry ? (
          <span role="alert">저장하지 못했어요. 편집 내용은 화면에 남아 있고 자동으로 다시 시도해요. {saveRetry.error==="BUSY"?"다른 도구가 저장하는 중이에요.":saveRetry.error}</span>
        ) : error ? (
          <span role="alert">{error}</span>
        ) : (
          notice ||
          "본문을 클릭해 바로 수정하세요. 변경은 자동으로 저장돼요(⌘/Ctrl+S는 바로 저장) · 묶음 바깥 클릭 후 Delete 묶음 삭제 · 빈 문단에서 Backspace 문단 삭제 · AI 제안은 해당 구절에 diff로 표시돼요: Tab 적용·다음 · Esc 유지 · Shift+Tab 이전 · ⌥/Alt+↓ 제안 버튼 · ✦ 추천 받기(⌥\\) · 검토는 ⌘/Ctrl + Enter"
        )}
      </div>
      {doc.format==="markup" && photoOpen && <PhotoPicker revision={doc.revision} placements={photos} anchors={doc.stickerAnchors??[]} target={stickerTarget} disabled={busy} onTarget={setStickerTarget} onChange={changePhotos} onReveal={id=>send({type:"reveal-photo",id})} onClose={()=>setPhotoOpen(false)}/>}
      {doc.format==="markup" && stickerOpen && <div id="ce-sticker-planner"><StickerPlanner nativeClipboard={doc.nativeClipboard} placements={stickers} anchors={doc.stickerAnchors??[]} target={stickerTarget} disabled={busy} onTarget={setStickerTarget} onChange={changeStickers} onReveal={id=>send({type:"reveal-sticker",id})}/></div>}
      <button
        className="ce-outline-toggle"
        aria-expanded={outlineOpen}
        onClick={() => setOutlineOpen(!outlineOpen)}
      >
        글의 흐름 · {bundle?.name} {outlineOpen ? "접기" : "펼치기"}
      </button>
      {narrow && reviewOpen && (
        <button
          className="ce-drawer-backdrop"
          aria-label="검토 패널 닫기"
          tabIndex={-1}
          onClick={() => setReviewOpen(false)}
        />
      )}
      <div className="ce-workspace">
        <nav
          className={`ce-outline${outlineOpen ? " is-open" : ""}`}
          aria-label="정본 묶음"
        >
          <h2>글의 흐름</h2>
          {doc.bundles.filter((b) => !deleted.includes(b.id)).map((b, i) => (
            <button
              aria-pressed={b.id === selected}
              key={b.id}
              onKeyDown={(e) => {
                if ((e.key === "Delete" || e.key === "Backspace") && !e.metaKey && !e.ctrlKey && !e.altKey) {
                  e.preventDefault();
                  deleteBundle(b.id);
                }
              }}
              onClick={() => {
                setSelected(b.id);
                setOutlineOpen(false);
                send({ type: "jump", id: b.id });
              }}
            >
              <small>
                {String(i + 1).padStart(2, "0")} ·{" "}
                {queued.includes(b.id)
                  ? "검토 요청됨"
                  : changed.includes(b.id)
                    ? "변경 영향 있음"
                    : "기존 원고"}
              </small>
              <strong>{b.name}</strong>
            </button>
          ))}
          <details>
            <summary>연결된 정본</summary>
            <p>{doc.path}</p>
          </details>
        </nav>
        <div className="ce-paper-area">
          <iframe
            ref={frame}
            title="정본 본문 편집"
            scrolling="no"
            src={`/api/blog/frame?${live?"":`v=${doc.revision}&`}layout=${doc.frameVersion}&reload=${frameEpoch}`}
            style={{ width: `min(100%, ${width}px)`, height }}
          />
        </div>
        <aside
          ref={reviewPanel}
          className={`ce-review${reviewOpen ? " is-open" : ""}`}
          role={narrow ? "dialog" : undefined}
          aria-modal={narrow && reviewOpen ? true : undefined}
          aria-hidden={narrow && !reviewOpen ? true : undefined}
          aria-label="묶음 검토"
        >
          <button
            className="ce-review-close"
            aria-label="검토 닫기"
            onClick={() => setReviewOpen(false)}
          >
            닫기 ×
          </button>
          {doc.format==="markup"&&<BlogChat attachments={chatAttachments} revision={doc.revision} bundleId={selected||undefined} disabled={busy} focusToken={chatFocus}
            sourceOf={chatSource} plainOf={chatPlain}
            onRemove={key=>setChatAttachments(old=>old.filter(a=>a.key!==key))}
            onSent={keys=>setChatAttachments(old=>old.filter(a=>!keys.includes(a.key)))}
            onApply={applyChatRewrite} onMemo={saveChatMemo} onJump={id=>send({type:"focus",id})}/>}
          {doc.format==="markup"&&<UserAnnotations target={annotationTarget} revision={doc.revision} onChanged={()=>send({type:"annotations-changed"})} onClose={()=>setAnnotationTarget(undefined)} onJump={id=>send({type:"focus",id})}/>}
          <small>선택한 묶음</small>
          <h2>{bundle?.name}</h2>
          <p>{bundle?.question}</p>
          <hr />
          <h3>AI 검토 결과</h3>
          {doc.format==="markup"&&<>
            {reviewPreparing&&<p role="status">검토할 화면을 준비하고 있어요…</p>}
            {reviewStatusError&&<p role="alert">{reviewStatusError}</p>}
            {reviewJobs.filter(j=>!j.bundleIds.length||j.bundleIds.includes(selected)).slice(0,1).map(j=><div key={j.id} role="status">
              <p>{({pending:"검토 시작 대기",running:"AI 검토 실행 중",completed:"검토 응답 도착",failed:"검토 실패",cancelled:"검토 중지",interrupted:"실행 중단",stale:"본문 변경 · 다시 검토 필요"} as Record<string,string>)[j.status]??j.status}</p>
              {j.error&&<p>{j.error}</p>}
              {["failed","cancelled","interrupted","stale"].includes(j.status)&&<button disabled={busy} onClick={()=>void request("selected")}>검토 다시 실행</button>}
            </div>)}
            {review?.generatedAt&&<p>{review.provider??"AI"} · {new Date(review.generatedAt).toLocaleString()}</p>}
          </>}
          <p className="ce-review-note">
            문장 제안은 본문의 해당 구절에 바로 표시돼요(빨간 취소선은 삭제, 초록 밑줄은 추가). 구절을 누르거나 Tab으로 이동해 적용·유지를 고르세요. 서식(✦ 서식)은 구절 뒤, 겹친 제안(✦ 겹친 제안)은 먼저 표시된 제안 뒤, 메모(✦ 메모)와 확인 필요(⚠)는 문단 끝이나 사진 옆에 작은 표시로 나오고, 누르면 열려요. 본문이 바뀐 제안은 본문에 표시하지 않아요.
          </p>
          {doc.format!=="markup" && queued.includes(selected) && (
            <p role="status">검토 요청됨 · 엔진 처리 대기</p>
          )}
          {review ? (
            <>
              {doc.format==="markup"&&<section className="ce-visual-review" aria-label="강조·화면 검수">
                <strong>{!review.visual||review.visual.status==="unverified"?"화면 미검증":dirty||!review.visualFresh?"화면 재확인 필요":review.visual.status==="pass"?"화면 확인 통과":"강조·화면 수정 필요"}</strong>
                <p>{!review.visual?"이전 결과에는 실제 화면 검증 근거가 없습니다.":review.visual.status==="unverified"?"실제 화면을 확인하지 않은 서식 제안입니다. 화면 검수를 완료해야 합니다.":dirty||!review.visualFresh?"검토 이후 원고가 바뀌었습니다. 아래 화면은 검토 당시 기록입니다.":review.visual.observation}</p>
                {!!review.screenshots?.length&&<details><summary>검토한 화면 보기</summary>{review.screenshots.map(e=><figure key={e.index}><figcaption>{e.width}px</figcaption><img alt={e.width+"px 검토 당시 묶음 화면"} src={"/api/blog/review-image?request="+encodeURIComponent(review.requestId??"")+"&index="+e.index}/></figure>)}</details>}
                {review.emphasisDecisions?.map((d,i)=><details key={i}>
                  <summary>{d.phrase} · {d.role}</summary>
                  <p>선택: {d.methods.map(m=>({weight:"굵기",color:"색",background:"배경",size:"크기",marker:"표식",none:"강조 없음"})[m]).join(" · ")} · {({keep:"유지",change:"변경 제안",remove:"제거 제안",unconfirmed:"미확인"})[d.action]}</p>
                  <p>{d.reason}</p><p>다른 방식과 비교: {d.alternatives}</p>
                </details>)}
              </section>}
              <details className="ce-review-summary">
                <summary>묶음 평가 요약</summary>
                <p>{review.summary}</p>
              </details>
              {!review.freshText && (
                <p className="ce-warning">
                  {doc.format==="markup"?"검토 뒤 내용이 달라졌어요. 각 제안의 대상 구절을 따로 확인합니다.":"검토 당시와 문장이 달라요. 이전 제안의 적용은 잠겨 있어요."}
                </p>
              )}
              {reviewItems.length > 0 && (
                <p className="ce-proposal-counts" role="status">
                  본문 제안 {reviewCounts.body} · 적용 가능 {reviewCounts.available} · 확인 필요 {reviewCounts.check}
                </p>
              )}
              <ul className="ce-proposal-list" aria-label="AI 제안 목록">
                {reviewItems.map((item) => {
                  const chip = proposalChip(item);
                  const body = hasBodyMark(item, doc);
                  const settled = item.state === "decided" || item.state === "applied";
                  return (
                    <li key={item.id} className="ce-proposal" data-state={item.state} data-proposal={item.id}>
                      <div className="ce-proposal-head">
                        <span className={`ce-chip is-${chip.tone}`}>{chip.label}</span>
                        <small>{[item.severity, item.axis].filter(Boolean).join(" · ")}</small>
                      </div>
                      <p className="ce-proposal-line">{proposalSummary(item)}</p>
                      {item.state !== "decided" && item.kind !== "note" && !item.canApply && (
                        <p className="ce-warning ce-proposal-reason">{item.reason}</p>
                      )}
                      {(body || !settled) && (
                        <div className="ce-proposal-actions">
                          {body ? (
                            <button onClick={() => revealProposal(item)}>본문에서 보기</button>
                          ) : (
                            <button
                              disabled={busy}
                              onClick={() => {
                                handledRef.current.add(item.id);
                                setDecisions((old) => ({ ...old, [item.id]: "현재 유지" }));
                              }}
                            >
                              현재 유지
                            </button>
                          )}
                        </div>
                      )}
                      <details className="ce-proposal-evidence">
                        <summary>제안 이유</summary>
                        <p>{item.observation}</p>
                        {item.kind !== "note" && <p>{item.reason}</p>}
                        {item.kind === "text" && (
                          <dl className="ce-proposal-full">
                            <dt>원문</dt><dd>{item.before}</dd>
                            <dt>제안</dt><dd>{item.after || "(삭제)"}</dd>
                          </dl>
                        )}
                      </details>
                    </li>
                  );
                })}
              </ul>
            </>
          ) : (
            <p>저장된 검토가 없어요. 준비되면 이 묶음 검토를 눌러주세요.</p>
          )}
          {doc.format !== "markup" && <CanonicalSdkReview
            document={doc}
            selected={selected}
            dirty={dirty}
            busy={busy}
            onApply={apply}
          />}
          <p className="ce-review-note">
            제안 선택은 이 화면에 유지됩니다. {live?"적용한 본문은 자동으로 저장돼요.":"적용한 본문은 정본 저장을 눌러 보관하세요."}
          </p>
        </aside>
      </div>
    </main>
  );
}
