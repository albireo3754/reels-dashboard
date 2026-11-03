import { StickerPlanner } from "./StickerPlanner";
import { stickerHtml, stickerKey, type StickerPlacement } from "../../../shared/blog-stickers";
import {findingApplicability,replaceInlineText} from "../../../shared/review-applicability";
import {UserAnnotations,type AnnotationTarget} from "./UserAnnotations";
import { FormattingToolbar, type SelectionFormat } from "./FormattingToolbar";
import { CanonicalSdkReview } from "./CanonicalSdkReview";
import { useEffect, useMemo, useRef, useState } from "react";
import {planInlineProposals,proposalSignature,type InlineProposal} from "../../../shared/inline-review";
import {
  inlineHtml,
  inlineSource,
  readInline,
  restyle,
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
  const [doc, setDoc] = useState<CanonicalDocument>();
  const [stickers,setStickers]=useState<StickerPlacement[]>([]);
  const [stickerOpen,setStickerOpen]=useState(false);
  const [stickerTarget,setStickerTarget]=useState("");
  const stickersRef=useRef(stickers);stickersRef.current=stickers;
  const [edits, setEdits] = useState<Record<string, string>>({});
  // Bundles removed on this screen; they leave the source only when saved.
  const [deleted, setDeleted] = useState<string[]>([]);
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
  const dirty =
    stickersDirty ||
    deleted.length > 0 ||
    Object.keys(edits).length > 0 ||
    Object.keys(invalid).length > 0 ||
    (!!doc && title !== doc.title);
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
          }).filter((item) => !deleted.includes(item.bundleId))
        : [],
    [doc, edits, decisions, changed, typography, deleted],
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
      setDoc(d);setStickers(d.stickers??[]);setStickerTarget("");
      setFrameEpoch(v=>v+1);
      setSaveState("idle");setSavedForReview(false);setNotice("");
      setTitle(d.title);
      setEdits({});setDeleted([]);
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
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function save(reason:"manual"|"review"="manual"): Promise<CanonicalDocument | undefined> {
    if (!doc) return;
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
        edits: Object.entries(edits).map(([id, source]) => ({ id, source })),
        ...(title !== doc.title ? { title } : {}),
        ...(stickersDirty ? {stickers} : {}),
        ...(deleted.length ? { deleteBundles: deleted } : {}),
      });
      setDoc(result.document);setStickers(result.document.stickers??[]);
      setFrameEpoch(v=>v+1);setSaveState("idle");setSavedForReview(reason==="review");
      setTitle(result.document.title);
      setEdits({});setDeleted([]);
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
      // A save/reload in the meantime means the caret context is gone; the frame
      // re-checks the paragraph text, caret and focus itself.
      const stale =
        docRef.current?.revision !== revision ||
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
      if(alive){setReviewJobs(result.requests);setQueued(result.requests.filter((j:any)=>["pending","running"].includes(j.status)).flatMap((j:any)=>j.bundleIds));setReviewStatusError("");setDoc(old=>old?{...old,reviews:result.reviews}:old);}
    }catch(e){if(alive)setReviewStatusError("검토 상태를 확인하지 못했어요: "+String(e));}};
    void poll();const timer=setInterval(()=>void poll(),1500);
    return()=>{alive=false;clearInterval(timer);};
  },[doc?.format]);
  const requestRef = useRef(request);
  requestRef.current = request;
  function deleteBundle(id: string) {
    if (!doc || busy) return;
    if (doc.format !== "markup") return setError("이 형식에서는 묶음 삭제를 지원하지 않아요.");
    const live = doc.bundles.filter((b) => !deleted.includes(b.id));
    const i = live.findIndex((b) => b.id === id);
    if (i < 0) return;
    if (live.length <= 1) return setError("마지막 묶음은 지울 수 없어요.");
    const next = [...deleted, id];
    setDeleted(next);
    send({ type: "hide-bundles", ids: next });
    // The neighbours now meet each other, so their transition needs review.
    setChanged((old) => [...new Set([...old, ...[live[i - 1], live[i + 1]].filter(Boolean).map((b) => b!.id)])].filter((x) => !next.includes(x)));
    setQueued([]);
    const neighbour = live[i + 1] ?? live[i - 1];
    if (selected === id && neighbour) setSelected(neighbour.id);
    setError("");
    setNotice(`‘${live[i].name}’ 묶음을 지웠어요. 아직 저장 전입니다. ⌘/Ctrl+S로 저장하거나 삭제 취소를 눌러주세요.`);
  }
  function undoDelete() {
    const next = deleted.slice(0, -1);
    const restored = deleted.at(-1);
    setDeleted(next);
    send({ type: "hide-bundles", ids: next });
    if (restored) setSelected(restored);
    setNotice("묶음 삭제를 취소했어요.");
  }
  const deleteRef = useRef(deleteBundle);
  deleteRef.current = deleteBundle;
  const deletedRef = useRef(deleted);
  deletedRef.current = deleted;
  function saveShortcut() {
    if (busyRef.current) return;
    if (Object.keys(invalid).length) return setError("입력 오류가 있는 문단을 고친 뒤 저장해주세요.");
    if (!dirty) return setNotice("저장할 변경이 없어요.");
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
      if(m.type==="annotation-open")setReviewOpen(true);
      if(m.type==="annotate"&&doc.format==="markup"&&typeof m.text==="string"&&typeof m.context==="string"&&doc.paragraphs.some(p=>p.id===m.id)){
        setAnnotationTarget({id:m.id,text:m.text,context:m.context,checked:!!m.checked,requestId:crypto.randomUUID()});
        setReviewOpen(true);
      }
      if(m.type==="sticker-anchor" && doc.stickerAnchors?.some(a=>a.bundleId===m.bundleId && a.before===m.before))setStickerTarget(stickerKey(m));
      if (m.type === "typography") setTypography(m.styles);
      if (m.type === "selection") setSelectionFormat(m.selection ?? undefined);
      if (m.type === "ready") {
        // A reloaded frame has no spinner or caret for an old request.
        if (suggestRef.current) cancelSuggestRef.current();
        if(doc.format==="markup")sendStickers();
        send({ type: "hide-bundles", ids: deletedRef.current });
        send({ type: "lock", locked: busyRef.current });
        send({ type: "proposals", items: proposalsRef.current, locked: busyRef.current });
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
          if (!Array.isArray(m.runs)) return;
          const source = inlineSource(m.runs as InlineRun[]);
          readInline(source);
          setInvalid((old) => {
            const next = { ...old };
            delete next[m.id];
            return next;
          });
          if (m.id === "$title") {
            setTitle(m.runs.map((r: InlineRun) => r.text).join(""));
            setChanged(doc.bundles.map((b) => b.id));
            return;
          }
          const p = doc.paragraphs.find((p) => p.id === m.id);
          if (!p) return;
          setEdits((old) => {
            const next = { ...old };
            if (source === p.source) delete next[p.id];
            else next[p.id] = source;
            return next;
          });
          const i = doc.bundles.findIndex((b) => b.paragraphIds.includes(p.id));
          setChanged((old) => [
            ...new Set([
              ...old,
              ...doc.bundles.slice(Math.max(0, i - 1), i + 2).map((b) => b.id),
            ]),
          ]);
          setQueued([]);
        } catch (e) {
          setInvalid((old) => ({ ...old, [m.id]: String(e) }));
          setError(String(e));
        }
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [doc]);
  function apply(f: CanonicalFinding, key = f.id): boolean {
    if (!doc || busy) return false;
    const p = f.proposal;
    const id = p?.tid ?? p?.entry?.id;
    const original = doc.paragraphs.find((t) => t.id === id);
    if (!p || !original) return false;
    // editsRef is updated synchronously below so back-to-back applies in one
    // paragraph re-validate against the newest text, not a stale render.
    let source = editsRef.current[original.id] ?? original.source;
    try {
      if(doc.format==="markup"){const state=findingApplicability(f,source);if(!state.canApply)throw new Error(state.reason);}
      const runs = readInline(source),
        plain = runs.map((r) => r.text).join("");
      if (p.layer === "emphasis" && p.entry) {
        const start = plain.indexOf(p.entry.phrase);
        if (start < 0) throw new Error("강조할 구절이 바뀌었어요.");
        const { bg, ...s } = p.entry.style;
        source = restyle(
          source,
          start,
          start + p.entry.phrase.length,
          { ...s, ...(bg ? { background: bg } : {}) },
          p.op === "remove",
        );
      } else if (p.layer === "text" && p.before && p.after !== undefined) {
        const start = plain.indexOf(p.before);
        if (start < 0 || plain.indexOf(p.before, start + 1) >= 0)
          throw new Error(
            "제안 대상이 바뀌었거나 여러 곳에 있어요. 본문에서 직접 수정해주세요.",
          );
        source = replaceInlineText(source,start,start+p.before.length,p.after);
      } else throw new Error("이 제안은 본문에서 직접 수정해주세요.");
      editsRef.current={...editsRef.current,[original.id]:source};
      setEdits(old=>({...old,[original.id]:source}));
      send({ type: "replace", id: original.id, html: inlineHtml(source) });
      setDecisions((old) => ({ ...old, [key]: "적용 · 저장 전" }));
      setNotice("본문에 반영했어요. 아직 저장 전입니다. 정본 저장 또는 저장 후 검토를 눌러주세요.");
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    }
  }
  const applyRef = useRef(apply);
  applyRef.current = apply;
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
        <span id="ce-save-status" className={"ce-status ce-save-status "+(saveState==="failed"?"is-error":dirty?"is-dirty":"is-saved")} role="status" aria-live="polite">
          <strong>{saveState==="saving"?"저장 중…":saveState==="failed"?"저장 실패 · 편집 내용 유지":dirty?"● 저장 전 변경":"✓ 저장 완료"}</strong>
          <small>{saveState==="saving"?"원고와 미리보기를 저장하고 있어요.":dirty?"아직 파일에 저장되지 않았어요.":doc.savedAt?<><time dateTime={doc.savedAt} title={new Date(doc.savedAt).toLocaleString()}>{new Date(doc.savedAt).toLocaleTimeString("ko-KR",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false})}</time>{savedForReview?" · 검토 전에 자동 저장했어요.":" · 저장할 변경이 없어요."}</>:"저장할 변경이 없어요."}</small>
        </span>
        <button
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
        </button>
        <button
          className={"ce-primary"+(!dirty&&saveState==="idle"?" ce-save-done":"")}
          aria-label="정본 저장"
          aria-describedby="ce-save-status"
          title={saveState==="saving"?"저장 중입니다":dirty?"현재 편집 내용을 파일에 저장합니다":"모든 변경이 저장돼 있어요"}
          disabled={busy || !dirty || Object.keys(invalid).length > 0}
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
            title="선택한 묶음을 지웁니다. 본문에서 묶음의 글 밖(사진·이름표)을 클릭한 뒤 Delete/Backspace로도 지울 수 있어요. 저장해야 정본에 반영됩니다."
            disabled={busy || !bundle || doc.bundles.length - deleted.length <= 1}
            onClick={() => deleteBundle(selected)}
          >
            묶음 삭제
          </button>}
          {deleted.length > 0 && <button disabled={busy} onClick={undoDelete}>삭제 취소 ({deleted.length})</button>}
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
      <div className="ce-feedback" aria-live="polite">
        {error ? (
          <span role="alert">{error}</span>
        ) : (
          notice ||
          "본문을 클릭해 바로 수정하세요. ⌘/Ctrl+S 저장 · 묶음 바깥 클릭 후 Delete 묶음 삭제 · AI 제안은 해당 구절에 diff로 표시돼요: Tab 적용·다음 · Esc 유지 · Shift+Tab 이전 · ⌥/Alt+↓ 제안 버튼 · ✦ 추천 받기(⌥\\) · 검토는 ⌘/Ctrl + Enter"
        )}
      </div>
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
            src={`/api/blog/frame?v=${doc.revision}&layout=${doc.frameVersion}&reload=${frameEpoch}`}
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
            제안 선택은 이 화면에 유지됩니다. 적용한 본문은 정본 저장을 눌러
            보관하세요.
          </p>
        </aside>
      </div>
    </main>
  );
}
