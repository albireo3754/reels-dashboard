import {findingApplicability,replaceInlineText} from "../../../shared/review-applicability";
import {UserAnnotations,type AnnotationTarget} from "./UserAnnotations";
import { FormattingToolbar, type SelectionFormat } from "./FormattingToolbar";
import { FormatComparison } from "./FormatComparison";
import { CanonicalSdkReview } from "./CanonicalSdkReview";
import { useEffect, useRef, useState } from "react";
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
async function api(action: string, input?: unknown) {
  const r = await fetch(
    `/api/blog/${action}`,
    input
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        }
      : undefined,
  );
  const value = await r.json();
  if (!r.ok) throw new Error(value.error ?? "작업에 실패했어요.");
  return value;
}
export function CanonicalBlogEditor() {
  const [annotationTarget,setAnnotationTarget]=useState<AnnotationTarget>();
  const [doc, setDoc] = useState<CanonicalDocument>();
  const [edits, setEdits] = useState<Record<string, string>>({});
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
  const dirty =
    Object.keys(edits).length > 0 ||
    Object.keys(invalid).length > 0 ||
    (!!doc && title !== doc.title);
  const busyRef = useRef(busy);
  busyRef.current = busy;
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
  async function load() {
    setBusy(true);
    setError("");
    try {
      const d = await api("document");
      setDoc(d);
      setFrameEpoch(v=>v+1);
      setSaveState("idle");setSavedForReview(false);setNotice("");
      setTitle(d.title);
      setEdits({});
      setSelectionFormat(undefined);
      setSelected((old) =>
        d.bundles.some((b: any) => b.id === old)
          ? old
          : (d.bundles[0]?.id ?? ""),
      );
      setChanged([]);
      setDecisions({});
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
      });
      setDoc(result.document);
      setFrameEpoch(v=>v+1);setSaveState("idle");setSavedForReview(reason==="review");
      setTitle(result.document.title);
      setEdits({});
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
  async function request(scope: "selected" | "changed") {
    if (!doc || busy) return;
    const ids = scope === "selected" ? [selected] : changed;
    if (!ids.length) return;
    const savedBeforeReview=dirty;
    const current = savedBeforeReview ? await save("review") : doc;
    if (!current) return;
    setBusy(true);setReviewPreparing(true);
    setError("");
    try {
      await api("review", { revision: current.revision, bundleIds: ids });
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
      if (m.type === "typography") setTypography(m.styles);
      if (m.type === "selection") setSelectionFormat(m.selection ?? undefined);
      if (m.type === "ready") send({ type: "lock", locked: busyRef.current });
      if (m.type === "height" && Number.isFinite(m.height))
        setHeight(Math.min(100000, Math.max(500, m.height)));
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
  function apply(f: CanonicalFinding) {
    if (!doc || busy) return;
    const p = f.proposal;
    const id = p?.tid ?? p?.entry?.id;
    const original = doc.paragraphs.find((t) => t.id === id);
    if (!p || !original) return;
    let source = edits[original.id] ?? original.source;
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
      setEdits(old=>({...old,[original.id]:source}));
      send({ type: "replace", id: original.id, html: inlineHtml(source) });
      setDecisions((old) => ({ ...old, [f.id]: "적용 · 저장 전" }));
      setNotice("본문에 반영했어요. 아직 저장 전입니다. 정본 저장 또는 저장 후 검토를 눌러주세요.");
    } catch (e) {
      setError(String(e));
    }
  }
  const review = doc?.reviews.find((r) => r.bundleId === selected);
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
          "사진과 강조가 보이는 본문을 클릭해 바로 수정하세요. 검토는 버튼 또는 ⌘/Ctrl + Enter로 요청해요."
        )}
      </div>
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
          {doc.bundles.map((b, i) => (
            <button
              aria-pressed={b.id === selected}
              key={b.id}
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
            검토 버튼으로 실행한 결과예요. 문장에 적용하려면 제안을 선택하세요.
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
              {review.findings
                .filter(
                  (f) =>
                    !["withdrawn", "rejected", "obsolete"].includes(
                      f.status ?? "",
                    ),
                )
                .map((f) => {
                  const targetId=f.proposal?.tid??f.proposal?.entry?.id;
                  const availability=doc.format==="markup"?findingApplicability(f,edits[targetId??""]??doc.paragraphs.find(p=>p.id===targetId)?.source):undefined;
                  return (
                  <article key={f.id} className="ce-proposal">
                    {availability ? (
                      <p className={availability.canApply?"ce-review-note":"ce-warning"}>{availability.reason}</p>
                    ) : f.fresh === false && <p className="ce-warning">문장 또는 서식·구성이 바뀐 이전 제안이에요.</p>}
                    <small>
                      {f.axis} · {f.severity}
                    </small>

                    {f.proposal?.before && <del>{f.proposal.before}</del>}
                    {f.proposal?.after !== undefined && (
                      <ins>{f.proposal.after}</ins>
                    )}
                    {f.proposal?.entry && (
                      <FormatComparison
                        finding={f}
                        typography={typography[f.proposal.entry.id]}
                        source={
                          edits[f.proposal.entry.id] ??
                          doc.paragraphs.find(
                            (p) => p.id === f.proposal?.entry?.id,
                          )?.source
                        }
                      />
                    )}
                    {!f.proposal?.entry && f.proposal?.before === undefined && (
                      <p>{f.observation}</p>
                    )}
                    <div className="ce-proposal-actions">
                      <button
                        disabled={
                          busy ||
                          (availability ? !availability.canApply : (f.fresh === false || !review.freshText || changed.includes(selected))) ||
                          !!decisions[f.id] ||
                          !["text", "emphasis"].includes(
                            f.proposal?.layer ?? "",
                          )
                        }
                        onClick={() => apply(f)}
                      >
                        적용
                      </button>
                      <button
                        disabled={busy || !!decisions[f.id]}
                        onClick={() =>
                          setDecisions((old) => ({
                            ...old,
                            [f.id]: "현재 유지",
                          }))
                        }
                      >
                        현재 유지
                      </button>
                      <button
                        onClick={() => {
                          setReviewOpen(false);
                          send({
                            type: "focus",
                            id:
                              f.proposal?.tid ??
                              f.proposal?.entry?.id ??
                              bundle?.paragraphIds[0],
                          });
                        }}
                      >
                        본문에서 보기
                      </button>
                    </div>
                    {decisions[f.id] && <p>{decisions[f.id]}</p>}
                    <details className="ce-proposal-evidence">
                      <summary>제안 이유</summary>
                      <p>{f.observation}</p>
                    </details>
                  </article>
                );})}
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
