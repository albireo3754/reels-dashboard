import {test,expect,type Page,type FrameLocator} from "@playwright/test";
import {createServer} from "node:http";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {markupFixture} from "../fixtures/markup-editor";
import {startCanonicalEditor} from "../../src/app/blog-editor/server";
import {parse} from "../../src/shared/blog-markup";
import {bundleHashes} from "../../src/shared/blog-markup-source";

// Synthetic manuscript only. Real manuscripts are never opened by this spec.
// Cursor-style in-text diffs: deleted characters are the `rv-del` CSS highlight, inserted
// words an empty <span data-review-ui="ins" data-text=…>, everything else a small marker,
// and only the active proposal has a popover. These checks pin that DOM contract.
const HEAD='---\ntitle: "Example article"\nmarkup: 1\nmedia: ./media/\nnotes: article.notes.md\nstyle: {bodyPx: 16, mobileBodyPx: 17}\n---\n\n<Bundle id="B1" name="First" question="why">\n<Photo file="photo.png" alt="Example photo"/>\n\n¶ P1\n⟦First⟧¹ line\n  ¹ 적갈 up19 · main\n\n¶ P2\nSecond line\n';
const P3="벤치에서 잠시 쉬었어요. 바람이 좋았어요.",P4="아메리카노는 맛있었어요. 케이크도 맛있었어요.",P5="오늘은 정말 좋았어요.",P6="커피를 마셨어요.",P7="old cafe 근처에서 쉬었어요.";
const SOURCE=HEAD+`\n¶ P3\n${P3}\n\n¶ P4\n${P4}\n\n¶ P5\n${P5}\n\n¶ P6\n${P6}\n\n¶ P7\n[old cafe](https://example.com) 근처에서 쉬었어요.\n</Bundle>\n`;
const text=(id:string,tid:string,before:string,after:string)=>({id,axis:"문장",severity:"권장",observation:`${id}: 문장을 다듬어요.`,proposal:{layer:"text",tid,before,after}});
const FINDINGS=[
  text("ending","P3","쉬었어요","쉬었다"),
  // "맛있었어요" occurs twice in P4: ambiguous, so it is blocked.
  text("twice","P4","맛있었어요","맛있었다"),
  text("today","P5","정말 좋았어요","아주 좋았어요"),
  text("coffee","P6","커피를 마셨어요","커피를 천천히 마셨어요"),
  // Part of a link label: blocked.
  text("label","P7","old","new"),
  {id:"color",axis:"강조",severity:"권장",observation:"line을 하늘색으로 강조해요.",sourceAtReview:"Second line",proposal:{layer:"emphasis",op:"add",entry:{id:"P2",phrase:"line",style:{color:"#0096dc"}}}},
  {id:"photo-note",axis:"사진",severity:"참고",observation:"photo.png 사진을 첫 문단 뒤로 옮기면 흐름이 자연스러워요."},
];
// Words only review UI shows (inserted text and marker labels). None may reach the manuscript.
const REVIEW_WORDS=["쉬었다","맛있었다","아주 좋았어요","천천히","new cafe","✦","⚠","확인 필요","겹친 제안","현재 유지","AI 제안"];
const REVIEW_MARKUP=/data-review-ui|data-pid|rv-(card|stack|del|ins|hint|marker|warn|defer|format|note|target|focus)/;

const iframe=(page:Page)=>page.locator('iframe[title="정본 본문 편집"]');
const frameOf=(page:Page)=>page.frameLocator('iframe[title="정본 본문 편집"]');
const mark=(frame:FrameLocator,id:string)=>frame.locator(`[data-review-ui="ins"][data-pid="${id}"],[data-review-ui="marker"][data-pid="${id}"]`);
const hintOf=(frame:FrameLocator)=>frame.locator('[data-review-ui="hint"]');

interface Setup{config:Awaited<ReturnType<typeof markupFixture>>&{review:string};close:()=>Promise<void>}
async function setup(page:Page,{width=1440,height=1000,source=SOURCE,findings=FINDINGS as unknown[],reviews}:{width?:number;height?:number;source?:string;findings?:unknown[];reviews?:{bundleId:string;findings:unknown[]}[]}={}):Promise<Setup>{
  const root=await mkdtemp(path.join(os.tmpdir(),"inline-diff-"));
  const config={...await markupFixture(root),review:path.join(root,"reviews.json")};
  await writeFile(config.canon,source);
  const hashes=bundleHashes(parse(source));
  await writeFile(config.review,JSON.stringify({reviews:(reviews??[{bundleId:"B1",findings}]).map(r=>({bundleId:r.bundleId,summary:"합성 제안",verdict:"needs-work",basedOn:hashes[r.bundleId],findings:r.findings}))}));
  const server=await startCanonicalEditor(config);
  // Record every 'change' message the frame posts to the host page.
  await page.addInitScript(()=>{
    if(window!==window.top)return;
    (window as any).__changes=[];(window as any).__selects=[];
    window.addEventListener("message",e=>{if(e.data?.editor&&e.data.type==="select")(window as any).__selects.push(e.data.bundleId);});
    window.addEventListener("message",e=>{if(e.data?.editor&&e.data.type==="change")(window as any).__changes.push({id:e.data.id,text:(e.data.runs??[]).map((r:{text:string})=>r.text).join(""),raw:JSON.stringify(e.data)});});
  });
  await page.setViewportSize({width,height});
  await page.goto(server.url+"/?blogEditor=1");
  await expect(mark(frameOf(page),"ending")).toHaveCount(1);
  return {config,close:async()=>{await server.close();await rm(root,{recursive:true,force:true});}};
}
/** Manuscript body after the front matter (saving may re-format the front matter). */
const body=(source:string)=>source.slice(source.indexOf("\n---\n",4)+5);
const changes=(page:Page)=>page.evaluate(()=>(window as any).__changes as {id:string;text:string;raw:string}[]);

/** Focus a paragraph and put a collapsed caret at a plain-text offset (review UI nodes are skipped). */
async function caretTo(page:Page,tid:string,offset:number|"end"){
  await iframe(page).evaluate((el:HTMLIFrameElement,[tid,offset])=>{
    const d=el.contentDocument!,w=el.contentWindow!,p=d.querySelector<HTMLElement>(`[data-tid="${tid}"]`)!;
    p.focus();
    const walker=d.createTreeWalker(p,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement?.closest("[data-review-ui]")?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});
    const nodes:Text[]=[];for(let n=walker.nextNode();n;n=walker.nextNode())nodes.push(n as Text);
    const total=nodes.reduce((s,n)=>s+n.data.length,0),target=offset==="end"?total:Number(offset);
    let at=0,node:Text|undefined,pos=0;
    for(const n of nodes){if(target<=at+n.data.length){node=n;pos=target-at;break;}at+=n.data.length;}
    const r=d.createRange();
    if(node)r.setStart(node,pos);else r.setStart(p,p.childNodes.length);
    r.collapse(true);
    const s=w.getSelection()!;s.removeAllRanges();s.addRange(r);
  },[tid,offset] as const);
  await page.waitForTimeout(60);
}
/** Caret paragraph and plain-text offset, ignoring review UI. */
async function caret(page:Page){
  return iframe(page).evaluate((el:HTMLIFrameElement)=>{
    const d=el.contentDocument!,s=el.contentWindow!.getSelection();
    if(!s||!s.focusNode)return null;
    const p=(s.focusNode.nodeType===1?s.focusNode as Element:s.focusNode.parentElement)?.closest<HTMLElement>("[data-tid]");
    if(!p)return null;
    const r=d.createRange();r.setStart(p,0);r.setEnd(s.focusNode,s.focusOffset);
    const frag=r.cloneContents();frag.querySelectorAll("[data-review-ui]").forEach(n=>n.remove());
    return {tid:p.dataset.tid!,offset:(frag.textContent??"").length};
  });
}
const innerText=(page:Page,tid:string)=>frameOf(page).locator(`[data-tid="${tid}"]`).evaluate(p=>(p as HTMLElement).innerText);
/** Every Custom Highlight range touching paragraph tid as "name:text". */
async function highlightsIn(page:Page,tid:string){
  return iframe(page).evaluate((el:HTMLIFrameElement,tid)=>{
    const w=el.contentWindow as any,p=el.contentDocument!.querySelector(`[data-tid="${tid}"]`)!;
    const out:string[]=[];
    for(const [name,h] of w.CSS.highlights)for(const r of h as Iterable<Range>)if(p.contains(r.startContainer)||p.contains(r.endContainer))out.push(name+":"+r.toString());
    return out.sort();
  },tid);
}
async function noHorizontalOverflow(page:Page){
  return await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)
    &&await iframe(page).evaluate((el:HTMLIFrameElement)=>{const h=el.contentDocument!.documentElement;return h.scrollWidth<=h.clientWidth+1;});
}

test.describe("Cursor-style inline diffs",()=>{
  test("no review cards anywhere; only in-text spans, markers and a single popover",async({page})=>{
    const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
    const s=await setup(page);
    try{
      const frame=frameOf(page),hint=hintOf(frame);
      const cards=()=>frame.locator(".rv-stack,.rv-card,[data-proposal]");
      await expect(cards()).toHaveCount(0);
      // Every review node is one of the known kinds, empty, and not editable.
      const kinds=await iframe(page).evaluate((el:HTMLIFrameElement)=>[...el.contentDocument!.querySelectorAll<HTMLElement>("[data-review-ui]")]
        .filter(n=>n.dataset.reviewUi!=="style").map(n=>({kind:n.dataset.reviewUi,pid:n.dataset.pid??null,empty:n.dataset.reviewUi==="note-row"||n.textContent==="",ce:n.getAttribute("contenteditable")})));
      expect(kinds.every(k=>k.empty&&k.ce==="false")).toBe(true);
      expect(kinds.map(k=>`${k.kind}:${k.pid}`).sort()).toEqual(["ins:coffee","ins:ending","ins:today","marker:color","marker:label","marker:photo-note","marker:twice","note-row:null"]);
      // Open two proposals in turn: still no cards, exactly one popover for the latest.
      await mark(frame,"ending").click();
      await expect(hint).toHaveAttribute("data-pid","ending");
      await caretTo(page,"P6",2);
      await expect(hint).toHaveAttribute("data-pid","coffee");
      await expect(hint).toHaveCount(1);
      await expect(cards()).toHaveCount(0);
      expect(errors).toEqual([]);
    }finally{await s.close();}
  });

  test("ins span and rv-del highlight sit exactly at the target phrase",async({page})=>{
    const s=await setup(page);
    try{
      const frame=frameOf(page);
      const at=await iframe(page).evaluate((el:HTMLIFrameElement)=>{
        const d=el.contentDocument!,w=el.contentWindow as any,p=d.querySelector('[data-tid="P3"]')!;
        const ins=[...d.querySelectorAll<HTMLElement>('[data-review-ui="ins"][data-pid="ending"]')];
        const off=(node:Node,o:number)=>{const r=d.createRange();r.setStart(p,0);r.setEnd(node,o);const f=r.cloneContents();f.querySelectorAll("[data-review-ui]").forEach(n=>n.remove());return f.textContent!.length;};
        const dels=[...(w.CSS.highlights.get("rv-del")??[])].filter((r:Range)=>p.contains(r.startContainer)) as Range[];
        const del=dels[0];
        const span=ins[0];
        const spanAt=off(span.parentNode!,[...span.parentNode!.childNodes].indexOf(span));
        return {
          insCount:ins.length,inP3:ins.every(n=>p.contains(n)),text:span.dataset.text,
          delCount:dels.length,del:del.toString(),delStart:off(del.startContainer,del.startOffset),delEnd:off(del.endContainer,del.endOffset),
          spanAt,before:p.textContent!.slice(0,spanAt),
          // The span directly follows the deleted characters in the DOM.
          adjacent:del.endContainer.nodeType===3&&del.endOffset===(del.endContainer as Text).length&&del.endContainer.nextSibling===span,
          otherParagraphs:[...d.querySelectorAll('[data-review-ui="ins"][data-pid="ending"]')].filter(n=>!p.contains(n)).length,
        };
      });
      const s0=P3.indexOf("쉬었어요");
      expect(at).toEqual({insCount:1,inP3:true,text:"다",delCount:1,del:"어요",delStart:s0+2,delEnd:s0+4,spanAt:s0+4,before:P3.slice(0,s0)+"쉬었어요",adjacent:true,otherParagraphs:0});
      // Rendered: the struck "어요" is followed by the green "다"; the paragraph text itself is unchanged.
      expect(await innerText(page,"P3")).toBe(P3);
      await expect(frame.locator('[data-tid="P3"]')).toHaveText(P3);
      const box=await iframe(page).evaluate((el:HTMLIFrameElement)=>{
        const d=el.contentDocument!,w=el.contentWindow as any,p=d.querySelector('[data-tid="P3"]')!;
        const del=[...w.CSS.highlights.get("rv-del")].find((r:Range)=>p.contains(r.startContainer)) as Range;
        const a=del.getBoundingClientRect(),b=d.querySelector<HTMLElement>('[data-review-ui="ins"][data-pid="ending"]')!.getBoundingClientRect();
        return {sameLine:Math.abs(a.top-b.top)<4,right:b.left>=a.right-1&&b.left<=a.right+2,width:b.width>0};
      });
      expect(box).toEqual({sameLine:true,right:true,width:true});
      expect(await highlightsIn(page,"P3")).toEqual(["rv-del:어요"]);
      // P5: word replacement "정말"→"아주", inserted right after the struck word.
      expect(await highlightsIn(page,"P5")).toEqual(["rv-del:정말"]);
      await expect(mark(frame,"today")).toHaveAttribute("data-text","아주");
    }finally{await s.close();}
  });

  test("Tab applies the active proposal only then, and moves the caret to the next one",async({page})=>{
    const s=await setup(page);
    try{
      const frame=frameOf(page),hint=hintOf(frame);
      const save=page.getByRole("button",{name:"정본 저장",exact:true});
      // From P2's end (after the format marker is passed) Tab first only jumps.
      await caretTo(page,"P3",0);
      await expect(hint).toHaveCount(0);
      await page.keyboard.press("Tab");
      await expect.poll(()=>caret(page)).toEqual({tid:"P3",offset:P3.indexOf("쉬었어요")});
      await expect(hint).toHaveAttribute("data-pid","ending");
      await expect(hint.locator("[data-act=apply]")).toBeEnabled();
      await expect(mark(frame,"ending")).toHaveClass(/rv-active/);
      expect(await highlightsIn(page,"P3")).toEqual(["rv-del:어요","rv-focus:쉬었어요"]);
      // Before the deciding Tab: neither the paragraph nor the file changed.
      expect(await innerText(page,"P3")).toBe(P3);
      expect(await readFile(s.config.canon,"utf8")).toBe(SOURCE);
      await expect(save).toBeDisabled();
      expect((await changes(page)).filter(c=>c.id==="P3")).toEqual([]);

      await page.keyboard.press("Tab");
      await expect.poll(()=>innerText(page,"P3")).toBe("벤치에서 잠시 쉬었다. 바람이 좋았어요.");
      await expect(mark(frame,"ending")).toHaveCount(0);
      // Next proposal in order: the blocked marker at the end of P4.
      await expect.poll(()=>caret(page)).toEqual({tid:"P4",offset:P4.length});
      await expect(hint).toHaveAttribute("data-pid","twice");
      expect(await innerText(page,"P4")).toBe(P4);
      await expect(page.locator("#ce-save-status")).toContainText("✓ 저장 완료",{timeout:10000});
      expect(body(await readFile(s.config.canon,"utf8"))).toBe(body(SOURCE.replace(P3,"벤치에서 잠시 쉬었다. 바람이 좋았어요.")));
    }finally{await s.close();}
  });

  test("Esc keeps the current text and removes the proposal from the manuscript",async({page})=>{
    const s=await setup(page);
    try{
      const frame=frameOf(page),hint=hintOf(frame);
      await caretTo(page,"P5",P5.indexOf("정말"));
      await expect(hint).toHaveAttribute("data-pid","today");
      await page.keyboard.press("Escape");
      await expect(mark(frame,"today")).toHaveCount(0);
      await expect.poll(()=>highlightsIn(page,"P5")).toEqual([]);
      expect(await innerText(page,"P5")).toBe(P5);
      const item=page.locator(".ce-proposal").filter({hasText:"아주 좋았어요"});
      await expect(item).toHaveAttribute("data-state","decided");
      await expect(item.locator(".ce-chip")).toHaveText("현재 유지");
      await expect(page.getByRole("button",{name:"정본 저장",exact:true})).toBeDisabled();
      // Moves on to the next proposal (P6).
      await expect.poll(()=>caret(page)).toEqual({tid:"P6",offset:0});
      await expect(hint).toHaveAttribute("data-pid","coffee");
      expect(await readFile(s.config.canon,"utf8")).toBe(SOURCE);
      expect((await changes(page)).filter(c=>c.id==="P5")).toEqual([]);
    }finally{await s.close();}
  });

  test("saved body, preview, frame HTML, change messages and clipboard never contain review text",async({page,context})=>{
    await context.grantPermissions(["clipboard-read","clipboard-write"]);
    const s=await setup(page);
    try{
      const frame=frameOf(page),hint=hintOf(frame);
      // Clipboard: a selection over the whole P3 includes the ins span. Inside one paragraph the
      // copy handler takes the review nodes out (selection kept) and lets the browser copy natively.
      const copied=await iframe(page).evaluate((el:HTMLIFrameElement)=>{
        const d=el.contentDocument!,w=el.contentWindow!,p=d.querySelector<HTMLElement>('[data-tid="P3"]')!;
        p.focus();const r=d.createRange();r.selectNodeContents(p);const sel=w.getSelection()!;sel.removeAllRanges();sel.addRange(r);
        const spans=r.cloneContents().querySelectorAll("[data-review-ui]").length;
        const ev=new ClipboardEvent("copy",{clipboardData:new DataTransfer(),bubbles:true,cancelable:true});
        p.dispatchEvent(ev);
        return {spans,after:sel.getRangeAt(0).cloneContents().querySelectorAll("[data-review-ui]").length,text:sel.toString()};
      });
      expect(copied.spans).toBeGreaterThan(0);
      expect(copied.after).toBe(0);
      expect(copied.text).toBe(P3);
      // A trusted Cmd/Ctrl+C after the diff is back: the system clipboard holds only the manuscript text.
      await page.context().grantPermissions(["clipboard-read","clipboard-write"]);
      await page.waitForTimeout(600);
      await expect(mark(frame,"ending")).toHaveCount(1);
      await iframe(page).evaluate((el:HTMLIFrameElement)=>{
        const d=el.contentDocument!,p=d.querySelector<HTMLElement>('[data-tid="P3"]')!;
        p.focus();const r=d.createRange();r.selectNodeContents(p);const sel=el.contentWindow!.getSelection()!;sel.removeAllRanges();sel.addRange(r);
      });
      await page.keyboard.press("ControlOrMeta+c");
      const clip=await page.evaluate(async()=>{
        const items=await navigator.clipboard.read();let html="";
        for(const i of items)if(i.types.includes("text/html"))html=await (await i.getType("text/html")).text();
        return {text:await navigator.clipboard.readText(),html};
      });
      expect(clip.text).toBe(P3);
      expect(clip.html).not.toMatch(REVIEW_MARKUP);
      expect(clip.html).not.toContain("쉬었다");

      // Edits: apply one proposal, type next to another diff, keep a third.
      await mark(frame,"ending").click();
      await hint.locator("[data-act=apply]").click();
      await expect.poll(()=>innerText(page,"P3")).toBe("벤치에서 잠시 쉬었다. 바람이 좋았어요.");
      await caretTo(page,"P6",P6.length);
      await page.keyboard.type("!");
      await expect.poll(()=>innerText(page,"P6")).toBe(P6+"!");
      await page.waitForTimeout(600);
      await expect(mark(frame,"coffee")).toHaveCount(1);
      await caretTo(page,"P5",P5.indexOf("정말"));
      await page.keyboard.press("Escape");
      await expect(mark(frame,"today")).toHaveCount(0);

      const sent=await changes(page);
      expect(sent.map(c=>c.id)).toEqual(expect.arrayContaining(["P3","P6"]));
      for(const c of sent){
        expect(c.raw).not.toMatch(REVIEW_MARKUP);
        for(const w of REVIEW_WORDS.filter(w=>!(c.id==="P3"&&w==="쉬었다")))expect(c.text).not.toContain(w);
      }
      expect(sent.filter(c=>c.id==="P6").at(-1)!.text).toBe(P6+"!");

      await expect(page.locator("#ce-save-status")).toContainText("✓ 저장 완료",{timeout:10000});
      const saved=await readFile(s.config.canon,"utf8");
      expect(body(saved)).toBe(body(SOURCE.replace(P3,"벤치에서 잠시 쉬었다. 바람이 좋았어요.").replace(`¶ P6\n${P6}`,`¶ P6\n${P6}!`)));
      expect(saved).not.toMatch(REVIEW_MARKUP);
      const layout=await readFile(s.config.layout,"utf8");
      expect(layout).not.toMatch(REVIEW_MARKUP);
      for(const w of REVIEW_WORDS.filter(w=>w!=="쉬었다"))expect(layout).not.toContain(w);
      // The server-rendered frame and document API carry no review markup either.
      const base=new URL(page.url()).origin;
      const frameHtml=await (await page.request.get(base+"/api/blog/frame")).text();
      expect(frameHtml).not.toMatch(REVIEW_MARKUP);
      for(const w of REVIEW_WORDS.filter(w=>w!=="쉬었다"))expect(frameHtml).not.toContain(w);
      const doc=await (await page.request.get(base+"/api/blog/document")).json();
      const sources=JSON.stringify(doc.paragraphs);
      expect(sources).not.toMatch(REVIEW_MARKUP);
      for(const w of ["맛있었다","아주 좋았어요","천천히","new cafe","✦","⚠"])expect(sources).not.toContain(w);
    }finally{await s.close();}
  });

  test("IME composition next to a diff never leaks inserted words; spans come back only after idle",async({page})=>{
    const s=await setup(page);
    try{
      const frame=frameOf(page);
      const cdp=await page.context().newCDPSession(page);
      // Caret right after "쉬었어요", where the ins span sits.
      const at=P3.indexOf("쉬었어요")+4;
      await caretTo(page,"P3",at);
      await expect(mark(frame,"ending")).toHaveCount(1);
      await cdp.send("Input.imeSetComposition",{text:"ㄴ",selectionStart:1,selectionEnd:1});
      // compositionstart removes this paragraph's review nodes at once.
      await expect(mark(frame,"ending")).toHaveCount(0);
      await cdp.send("Input.imeSetComposition",{text:"네",selectionStart:1,selectionEnd:1});
      // Still composing after the idle delay: nothing is drawn back mid-composition.
      await page.waitForTimeout(700);
      await expect(mark(frame,"ending")).toHaveCount(0);
      expect(await innerText(page,"P3")).toBe(P3.slice(0,at)+"네"+P3.slice(at));
      await cdp.send("Input.insertText",{text:"네"});
      await expect.poll(()=>innerText(page,"P3")).toBe(P3.slice(0,at)+"네"+P3.slice(at));
      // Right after compositionend: still held until the 400ms idle re-check.
      await expect(mark(frame,"ending")).toHaveCount(0);
      await expect(mark(frame,"ending")).toHaveCount(1,{timeout:3000});
      await expect(mark(frame,"ending")).toHaveAttribute("data-text","다");
      expect(await innerText(page,"P3")).toBe(P3.slice(0,at)+"네"+P3.slice(at));

      // Synthetic composition events (no CDP) on another diff: same guarantees.
      await caretTo(page,"P5",P5.indexOf("정말")+2);
      await expect(mark(frame,"today")).toHaveCount(1);
      await frame.locator('[data-tid="P5"]').evaluate(p=>{
        p.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true,data:""}));
        p.dispatchEvent(new InputEvent("beforeinput",{bubbles:true,cancelable:true,inputType:"insertCompositionText",data:"ㅎ",isComposing:true}));
        p.dispatchEvent(new InputEvent("input",{bubbles:true,inputType:"insertCompositionText",data:"ㅎ",isComposing:true}));
      });
      await expect(mark(frame,"today")).toHaveCount(0);
      await page.waitForTimeout(700);
      await expect(mark(frame,"today")).toHaveCount(0);
      await frame.locator('[data-tid="P5"]').evaluate(p=>p.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:"ㅎ"})));
      await expect(mark(frame,"today")).toHaveCount(0);
      await expect(mark(frame,"today")).toHaveCount(1,{timeout:3000});
      expect(await innerText(page,"P5")).toBe(P5);

      const sent=await changes(page);
      expect(sent.some(c=>c.id==="P3")).toBe(true);
      for(const c of sent){
        expect(c.raw).not.toMatch(REVIEW_MARKUP);
        expect(c.text).not.toContain("다");
        expect(c.text).not.toContain("아주");
      }
      expect(sent.filter(c=>c.id==="P3").at(-1)!.text).toBe(P3.slice(0,at)+"네"+P3.slice(at));
      expect(await readFile(s.config.canon,"utf8")).not.toMatch(REVIEW_MARKUP);
    }finally{await s.close();}
  });

  test("a stale proposal (target edited) draws nothing inline and the panel says 본문 변경됨",async({page})=>{
    const s=await setup(page);
    try{
      const frame=frameOf(page),hint=hintOf(frame);
      const stale="벤치에서 잠시 쉬었네요. 바람이 좋았어요.";
      await frame.locator('[data-tid="P3"]').fill(stale);
      await expect.poll(()=>innerText(page,"P3")).toBe(stale);
      const item=page.locator(".ce-proposal").filter({hasText:"쉬었어요 → 쉬었다"});
      await expect(item).toHaveAttribute("data-state","changed");
      await expect(item.locator(".ce-chip")).toHaveText("본문 변경됨");
      await page.waitForTimeout(700);
      await expect(mark(frame,"ending")).toHaveCount(0);
      expect(await frame.locator('[data-tid="P3"] [data-review-ui]').count()).toBe(0);
      expect(await highlightsIn(page,"P3")).toEqual([]);
      // Keyboard skips it: Tab from the start of P3 goes to the P4 marker.
      await caretTo(page,"P3",0);
      await expect(hint).toHaveCount(0);
      await page.keyboard.press("Tab");
      await expect(hint).toHaveAttribute("data-pid","twice");
      // "본문에서 보기" is not offered for it.
      await expect(item.getByRole("button",{name:"본문에서 보기"})).toHaveCount(0);
    }finally{await s.close();}
  });

  test("format marker opens a popover with current/proposed rows; 적용 changes only the style, only then",async({page})=>{
    const s=await setup(page);
    try{
      const frame=frameOf(page),hint=hintOf(frame);
      const lineColor=()=>frame.locator('[data-tid="P2"]').evaluate(p=>{
        const w=document.createTreeWalker(p,NodeFilter.SHOW_TEXT);let n:Node|null;
        while((n=w.nextNode()))if(n.textContent!.includes("line"))return getComputedStyle(n.parentElement!).color;
        return null;
      });
      const before=await lineColor();
      expect(before).not.toBe("rgb(0, 150, 220)");
      const m=mark(frame,"color");
      await expect(m).toHaveClass(/rv-format/);
      await expect(m).toHaveAttribute("data-label","✦ 서식");
      expect(await highlightsIn(page,"P2")).toEqual(["rv-target:line"]);
      await m.click();
      await expect(hint).toHaveAttribute("data-pid","color");
      await expect(hint.locator(".rv-format .rv-format-row")).toHaveCount(2);
      await expect(hint.locator('.rv-sample[data-variant="current"]')).toHaveText("line");
      await expect(hint.locator('.rv-sample[data-variant="proposed"]')).toHaveText("line");
      expect(await hint.locator('.rv-sample[data-variant="proposed"] span').first().evaluate(e=>getComputedStyle(e).color)).toBe("rgb(0, 150, 220)");
      await expect(hint.locator(".rv-format-desc").nth(1)).toContainText("하늘색");
      // Opening it changes nothing.
      expect(await lineColor()).toBe(before);
      expect(await innerText(page,"P2")).toBe("Second line");
      expect(await readFile(s.config.canon,"utf8")).toBe(SOURCE);
      await hint.locator("[data-act=apply]").click();
      await expect.poll(lineColor).toBe("rgb(0, 150, 220)");
      expect(await innerText(page,"P2")).toBe("Second line");
      await expect(m).toHaveCount(0);
      expect(await highlightsIn(page,"P2")).toEqual([]);
      await expect(page.locator("#ce-save-status")).toContainText("✓ 저장 완료",{timeout:10000});
      const saved=await readFile(s.config.canon,"utf8");
      expect(saved).toMatch(/¶ P2\nSecond ⟦line⟧/);
      expect(saved).not.toMatch(REVIEW_MARKUP);
    }finally{await s.close();}
  });

  test("blocked proposals show ⚠ 확인 필요, apply is disabled, and Tab never applies them",async({page})=>{
    const s=await setup(page);
    try{
      const frame=frameOf(page),hint=hintOf(frame);
      for(const [id,tid,reason] of [["twice","P4","여러 곳"],["label","P7","링크"]] as const){
        const m=mark(frame,id);
        await expect(m).toHaveClass(/rv-warn/);
        await expect(m).toHaveAttribute("data-label","⚠ 확인 필요");
        // At the paragraph end, never as a diff.
        expect(await m.evaluate(n=>{const p=n.closest("[data-tid]")!;const r=document.createRange();r.setStartAfter(n);r.setEnd(p,p.childNodes.length);const f=r.cloneContents();f.querySelectorAll("[data-review-ui]").forEach(x=>x.remove());return f.textContent;})).toBe("");
        expect(await frame.locator(`[data-tid="${tid}"] [data-review-ui="ins"]`).count()).toBe(0);
        expect(await highlightsIn(page,tid)).toEqual([]);
        if(await hint.count())await frame.locator("body").evaluate(()=>{(document.activeElement as HTMLElement|null)?.blur();getSelection()?.removeAllRanges();});
        await m.click();
        await expect(hint).toHaveAttribute("data-pid",id);
        await expect(hint).toHaveClass(/rv-hint-blocked/);
        await expect(hint.locator(".rv-reason-line")).toContainText(reason);
        await expect(hint.locator("[data-act=apply]")).toBeDisabled();
        await hint.locator("[data-act=apply]").click({force:true});
      }
      await page.waitForTimeout(300);
      expect(await innerText(page,"P4")).toBe(P4);
      expect(await innerText(page,"P7")).toBe(P7);
      // Tab with the caret on the blocked marker moves on instead of applying.
      await caretTo(page,"P4","end");
      await expect(hint).toHaveAttribute("data-pid","twice");
      await page.keyboard.press("Tab");
      await expect.poll(()=>caret(page)).toEqual({tid:"P5",offset:P5.indexOf("정말")});
      await expect(hint).toHaveAttribute("data-pid","today");
      expect(await innerText(page,"P4")).toBe(P4);
      // Last blocked marker: nothing ahead, Tab keeps its default and changes nothing.
      await caretTo(page,"P7","end");
      await expect(hint).toHaveAttribute("data-pid","label");
      await page.keyboard.press("Tab");
      await page.waitForTimeout(300);
      expect(await innerText(page,"P7")).toBe(P7);
      expect(await frame.locator('[data-tid="P7"] a').getAttribute("href")).toBe("https://example.com");
      await expect(page.getByRole("button",{name:"정본 저장",exact:true})).toBeDisabled();
      expect((await changes(page)).filter(c=>c.id==="P4"||c.id==="P7")).toEqual([]);
      expect(await readFile(s.config.canon,"utf8")).toBe(SOURCE);
    }finally{await s.close();}
  });
});

test.describe("phone",()=>{
  test.use({hasTouch:true,viewport:{width:390,height:844}});
  test("390px: tapping an inserted word opens the popover inside the paper, below the target line",async({page},info)=>{
    const s=await setup(page,{width:390,height:844});
    try{
      const frame=frameOf(page),hint=hintOf(frame);
      await expect.poll(()=>noHorizontalOverflow(page)).toBe(true);
      const ins=mark(frame,"today");
      await ins.scrollIntoViewIfNeeded();
      await ins.tap();
      await expect(hint).toHaveAttribute("data-pid","today");
      await expect(hint).toBeVisible();
      const geo=await iframe(page).evaluate((el:HTMLIFrameElement)=>{
        const d=el.contentDocument!,w=el.contentWindow as any;
        const h=d.querySelector<HTMLElement>('[data-review-ui="hint"]')!.getBoundingClientRect();
        const paper=(d.querySelector("main")??d.body).getBoundingClientRect();
        const focus=[...(w.CSS.highlights.get("rv-focus")??[])] as Range[];
        const lines=focus.flatMap(r=>[...r.getClientRects()]);
        const insRects=[...d.querySelectorAll<HTMLElement>('[data-review-ui="ins"][data-pid="today"]')].flatMap(n=>[...n.getClientRects()]);
        const hit=(r:DOMRect)=>r.left<h.right&&h.left<r.right&&r.top<h.bottom&&h.top<r.bottom;
        return {focus:focus.map(r=>r.toString()),inside:h.left>=paper.left-1&&h.right<=paper.right+1,covers:[...lines,...insRects].some(hit),clientWidth:d.documentElement.clientWidth,right:h.right};
      });
      expect(geo.focus).toEqual(["정말 좋았어요"]);
      expect(geo.inside).toBe(true);
      expect(geo.covers).toBe(false);
      expect(geo.right).toBeLessThanOrEqual(geo.clientWidth+1);
      expect((await hint.locator("[data-act=apply]").boundingBox())!.height).toBeGreaterThanOrEqual(36);
      await expect.poll(()=>noHorizontalOverflow(page)).toBe(true);
      await page.screenshot({path:info.outputPath("inline-diff-phone.png")});
      // Tapping 적용 applies, and only the applied words reach the file.
      await hint.locator("[data-act=apply]").tap();
      await expect.poll(()=>innerText(page,"P5")).toBe("오늘은 아주 좋았어요.");
      await expect.poll(()=>readFile(s.config.canon,"utf8"),{timeout:10000}).toContain("오늘은 아주 좋았어요.");
      expect(await readFile(s.config.canon,"utf8")).not.toMatch(REVIEW_MARKUP);
    }finally{await s.close();}
  });
});

// Regressions for findings of the 2026-11-03 adversarial review (edit/IME, leakage, UX lenses).
test.describe("inline diff review regressions",()=>{
  test("typing inside a link label of a decorated paragraph stays inside the label",async({page})=>{
    const s=await setup(page);
    try{
      const frame=frameOf(page);
      await expect(mark(frame,"label")).toHaveCount(1);
      // Caret between "old c" and "afe" inside the link (the paragraph has a review marker).
      await iframe(page).evaluate((el:HTMLIFrameElement)=>{
        const d=el.contentDocument!,p=d.querySelector<HTMLElement>('[data-tid="P7"]')!,a=p.querySelector("a")!;
        p.focus();const r=d.createRange();r.setStart(a.firstChild!,5);r.collapse(true);
        const sel=el.contentWindow!.getSelection()!;sel.removeAllRanges();sel.addRange(r);
      });
      await page.keyboard.type("xy");
      await expect(frame.locator('[data-tid="P7"] a')).toHaveText("old cxyafe");
      await page.waitForTimeout(600);
      await page.keyboard.type("z");
      await expect(frame.locator('[data-tid="P7"] a')).toHaveText("old cxyzafe");
    }finally{await s.close();}
  });

  test("a deferred overlap marker can never be applied; its popover clears the phrase it names",async({page})=>{
    const findings=[...FINDINGS,text("over","P5","좋았어요","즐거웠어요")];
    const s=await setup(page,{findings});
    try{
      const frame=frameOf(page),hint=hintOf(frame);
      const over=frame.locator('[data-review-ui="marker"][data-pid="over"]');
      await expect(over).toHaveClass(/rv-defer/);
      await over.click();
      await expect(hint).toHaveAttribute("data-pid","over");
      await expect(hint.locator('button[data-act="apply"]')).toBeDisabled();
      await expect(hint).toContainText("겹쳐요");
      // The popover never covers the phrase line (the marker sits after the inline diff).
      const geo=await iframe(page).evaluate((el:HTMLIFrameElement)=>{
        const d=el.contentDocument!,p=d.querySelector('[data-tid="P5"]')!,h=d.querySelector('[data-review-ui="hint"]')!.getBoundingClientRect();
        const t=[...p.childNodes].find(n=>n.nodeType===3&&n.textContent!.includes("좋았"))!;const r=d.createRange();
        const i=t.textContent!.indexOf("좋았");r.setStart(t,i);r.setEnd(t,i+2);const g=r.getBoundingClientRect();
        return {overlap:!(h.bottom<=g.top||h.top>=g.bottom)};
      });
      expect(geo.overlap).toBe(false);
      // Tab on it moves on instead of applying.
      await page.keyboard.press("Tab");
      await page.waitForTimeout(300);
      await expect(frame.locator('[data-tid="P5"]')).toHaveText(P5);
      expect(body(await readFile(s.config.canon,"utf8"))).toBe(body(SOURCE));
    }finally{await s.close();}
  });

  test("popover lets clicks through to the text under it and is keyboard reachable with Alt+ArrowDown",async({page})=>{
    const s=await setup(page);
    try{
      const frame=frameOf(page),hint=hintOf(frame);
      await caretTo(page,"P5",5);
      await expect(hint).toHaveAttribute("data-pid","today");
      // Alt+ArrowDown moves into the popover; Esc there returns to the text without deciding.
      await page.keyboard.press("Alt+ArrowDown");
      expect(await frame.locator("body").evaluate(b=>(b.ownerDocument.activeElement as HTMLElement)?.dataset.act)).toBe("apply");
      await page.keyboard.press("Tab");
      expect(await frame.locator("body").evaluate(b=>(b.ownerDocument.activeElement as HTMLElement)?.dataset.act)).toBe("keep");
      await page.keyboard.press("Escape");
      expect(await caret(page)).toEqual({tid:"P5",offset:5});
      await expect(mark(frame,"today")).toHaveCount(1);
      // A click on manuscript text under the popover's non-button area reaches the text.
      const target=await iframe(page).evaluate((el:HTMLIFrameElement)=>{
        const d=el.contentDocument!,h=d.querySelector('[data-review-ui="hint"]')!.getBoundingClientRect();
        const x=h.left+h.width-12,y=h.top+10;const e=d.elementFromPoint(x,y);
        return {hit:!!e&&!e.closest('[data-review-ui="hint"]'),pe:getComputedStyle(d.querySelector('[data-review-ui="hint"]')!).pointerEvents};
      });
      expect(target).toEqual({hit:true,pe:"none"});
    }finally{await s.close();}
  });

  test("copy inside a decorated bold paragraph keeps formatting and no review text",async({page,browserName})=>{
    test.skip(browserName!=="chromium");
    const s=await setup(page);
    try{
      const frame=frameOf(page);
      // Bold the whole paragraph, wait for the diff to come back inside the bold run.
      await iframe(page).evaluate((el:HTMLIFrameElement)=>{
        const d=el.contentDocument!,p=d.querySelector<HTMLElement>('[data-tid="P3"]')!;p.focus();
        const r=d.createRange();r.selectNodeContents(p);const sel=el.contentWindow!.getSelection()!;sel.removeAllRanges();sel.addRange(r);
        d.execCommand("styleWithCSS",false,"true");d.execCommand("bold");
      });
      await page.waitForTimeout(700);
      await expect(mark(frame,"ending")).toHaveCount(1);
      const copied=await iframe(page).evaluate((el:HTMLIFrameElement)=>{
        const d=el.contentDocument!,p=d.querySelector<HTMLElement>('[data-tid="P3"]')!;
        const nodes:Text[]=[];const w=d.createTreeWalker(p,NodeFilter.SHOW_TEXT);let n:Node|null;while((n=w.nextNode()))nodes.push(n as Text);
        const r=d.createRange();r.setStart(nodes[0],5);r.setEnd(nodes.at(-1)!,1);
        const sel=el.contentWindow!.getSelection()!;sel.removeAllRanges();sel.addRange(r);
        const out:{text:string;html:string}={text:"",html:""};
        d.addEventListener("copy",e=>{setTimeout(()=>{});out.text=sel.toString();},{once:true});
        const dt=new DataTransfer();const ev=new ClipboardEvent("copy",{clipboardData:dt,bubbles:true,cancelable:true});
        p.dispatchEvent(ev);
        // Native copy runs only for trusted events; a synthetic one must leave the DOM free of review nodes in the selection.
        const frag=sel.getRangeAt(0).cloneContents();
        return {inSel:!!frag.querySelector("[data-review-ui]"),prevented:ev.defaultPrevented,html:dt.getData("text/html"),text:sel.toString()};
      });
      expect(copied.inSel).toBe(false);
      expect(copied.prevented).toBe(false);
      expect(copied.text).not.toMatch(/쉬었다/);
      // The diff is drawn again after idle.
      await page.waitForTimeout(600);
      await expect(mark(frame,"ending")).toHaveCount(1);
    }finally{await s.close();}
  });

  test("markers have a tall enough tap target on a 390px phone",async({browser})=>{
    const ctx=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
    const page=await ctx.newPage();
    const s=await setup(page,{width:390,height:844});
    try{
      const sizes=await iframe(page).evaluate((el:HTMLIFrameElement)=>[...el.contentDocument!.querySelectorAll<HTMLElement>('[data-review-ui="marker"]')].map(m=>{const r=m.getBoundingClientRect();return r.height;}));
      expect(sizes.length).toBeGreaterThan(0);
      for(const h of sizes)expect(h).toBeGreaterThanOrEqual(36);
      await frameOf(page).locator('[data-review-ui="marker"][data-pid="color"]').tap();
      await expect(hintOf(frameOf(page))).toHaveAttribute("data-pid","color");
    }finally{await s.close();await ctx.close();}
  });
});

// Regressions for the 2026-11-03 fix-stage findings (selection fidelity, ghost freshness, note focus/selection).
test.describe("inline diff review regressions (fix stage 2)",()=>{
  /** Selects [a,b) of the link label's text node in P7, focused, and lets the frame record it. */
  async function selectInLink(page:Page,a:number,b:number){
    await iframe(page).evaluate((el:HTMLIFrameElement,[a,b])=>{
      const d=el.contentDocument!,p=d.querySelector<HTMLElement>('[data-tid="P7"]')!,t=p.querySelector("a")!.firstChild!;
      p.focus();const r=d.createRange();r.setStart(t,a);r.setEnd(t,b);
      const sel=el.contentWindow!.getSelection()!;sel.removeAllRanges();sel.addRange(r);
    },[a,b] as const);
    await page.waitForTimeout(80);
  }
  const boldIn=(page:Page,tid:string)=>iframe(page).evaluate((el:HTMLIFrameElement,tid)=>{
    const d=el.contentDocument!,p=d.querySelector(`[data-tid="${tid}"]`)!;let out="";
    const w=d.createTreeWalker(p,NodeFilter.SHOW_TEXT);for(let n=w.nextNode();n;n=w.nextNode()){const e=n.parentElement!;if(e.closest("[data-review-ui]"))continue;if(Number(getComputedStyle(e).fontWeight)>=700)out+=n.textContent;}
    return out;
  },tid);
  const sendFormat=(page:Page)=>iframe(page).evaluate((el:HTMLIFrameElement)=>el.contentWindow!.postMessage({editor:true,type:"format",command:"bold"},location.origin));

  test("formatting a partial link-label selection in a decorated paragraph formats exactly that text",async({page})=>{
    const s=await setup(page);
    try{
      const frame=frameOf(page);
      await expect(mark(frame,"label")).toHaveCount(1);
      // "cafe" ends at the label's end; "ld c" ends inside it. Plain offsets would widen/collapse both.
      await selectInLink(page,4,8);
      await sendFormat(page);
      await expect.poll(()=>boldIn(page,"P7")).toBe("cafe");
      await expect(frame.locator('[data-tid="P7"] a')).toHaveText("old cafe");
      await selectInLink(page,1,3);
      await sendFormat(page);
      await expect.poll(()=>boldIn(page,"P7")).toBe("ldcafe");
      await expect(frame.locator('[data-tid="P7"] a')).toHaveText("old cafe");
    }finally{await s.close();}
  });

  test("a backward selection keeps its direction across the idle redraw",async({page})=>{
    const s=await setup(page);
    try{
      const frame=frameOf(page);
      await caretTo(page,"P3","end");
      await page.keyboard.type("!");
      await page.keyboard.press("Shift+ArrowLeft");
      await page.keyboard.press("Shift+ArrowLeft");
      // The redraw splits the text node holding the selection (the inserted word comes before it).
      await expect(mark(frame,"ending")).toHaveCount(1,{timeout:3000});
      await page.waitForTimeout(200);
      // The anchor stays on the right (where the selection started), not re-set forward.
      const dir=await iframe(page).evaluate((el:HTMLIFrameElement)=>{const s=el.contentWindow!.getSelection()!;return {text:s.toString(),backward:s.anchorNode===s.focusNode&&s.anchorOffset>s.focusOffset,direction:(s as any).direction??"backward"};});
      expect(dir).toEqual({text:".!",backward:true,direction:"backward"});
      await page.keyboard.press("Shift+ArrowLeft");
      const sel=await iframe(page).evaluate((el:HTMLIFrameElement)=>el.contentWindow!.getSelection()!.toString());
      expect(sel).toBe("요.!");
    }finally{await s.close();}
  });

  test("keeping the last standalone note returns focus to the text and the note selects its bundle",async({page})=>{
    const source=SOURCE.replace(/\n<\/Bundle>\n$/,"\n</Bundle>\n\n<Bundle id=\"B2\" name=\"Second\" question=\"why\">\n<Photo file=\"photo.png\" alt=\"Second photo\"/>\n\n¶ Q1\n두 번째 묶음이에요.\n</Bundle>\n");
    const note={id:"b2-note",axis:"사진",severity:"참고",observation:"photo.png 사진을 문단 뒤로 옮겨요."};
    const s=await setup(page,{source,reviews:[{bundleId:"B1",findings:[text("ending","P3","쉬었어요","쉬었다")]},{bundleId:"B2",findings:[note]}]});
    try{
      const frame=frameOf(page),marker=frame.locator('[data-review-ui="marker"][data-pid="b2-note"]');
      await expect(marker).toHaveCount(1);
      await caretTo(page,"P6","end");
      await page.evaluate(()=>{(window as any).__selects=[];});
      // Tab from the last B1 paragraph goes to B2's note: the host must hear that B2 is selected.
      await page.keyboard.press("Tab");
      await expect(hintOf(frame)).toHaveAttribute("data-pid","b2-note");
      expect(await marker.evaluate(m=>m.ownerDocument.activeElement===m)).toBe(true);
      await expect.poll(()=>page.evaluate(()=>(window as any).__selects as string[])).toContain("B2");
      // Esc keeps the note; it was the last proposal ahead, so focus goes back to where the writer was.
      await page.keyboard.press("Escape");
      await expect(marker).toHaveCount(0);
      await expect.poll(()=>caret(page)).toEqual({tid:"P6",offset:P6.length});
      await page.keyboard.type("Z");
      await expect(frame.locator('[data-tid="P6"]')).toHaveText(P6+"Z");
    }finally{await s.close();}
  });
  test("a manual suggestion requested right after an edit survives the idle redraw of the paragraph's diff",async({page})=>{
    // Fake suggest-inline backend: answers after 1.2s, well after the 400ms redraw.
    const engine=createServer(async(req,res)=>{let b="";for await(const c of req)b+=c;
      if(req.url!=="/api/workflows/suggest-inline"){res.writeHead(404);res.end("{}");return;}
      await new Promise(r=>setTimeout(r,1200));if(res.destroyed)return;
      res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({id:JSON.parse(b).id,suggestions:[" 다시 오고 싶어요."]}));});
    await new Promise<void>(r=>engine.listen(0,"127.0.0.1",r));
    const previous=process.env.REELS_WORKFLOW_URL;process.env.REELS_WORKFLOW_URL="http://127.0.0.1:"+(engine.address() as {port:number}).port;
    let s:Setup|undefined;
    try{
      s=await setup(page);
      const frame=frameOf(page),ghost=frame.locator('[data-review-ui="ghost"]');
      await caretTo(page,"P3","end");
      // The edit takes P3's diff out (text nodes re-joined); the request goes out before it is drawn again.
      await page.keyboard.type("!");
      await page.keyboard.press("Alt+Backslash");
      await expect(frame.locator('[data-review-ui="spinner"]')).toBeVisible();
      await expect(mark(frame,"ending")).toHaveCount(1,{timeout:3000});
      await expect(ghost).toHaveText(" 다시 오고 싶어요.",{timeout:10_000});
      await expect(page.getByText("본문이 바뀌어 추천을 버렸어요.",{exact:false})).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(ghost).toHaveCount(0);
      await expect(frame.locator('[data-tid="P3"]')).toHaveText(P3+"!");
    }finally{await s?.close();if(previous===undefined)delete process.env.REELS_WORKFLOW_URL;else process.env.REELS_WORKFLOW_URL=previous;await new Promise<void>(r=>{engine.closeAllConnections();engine.close(()=>r());});}
  });
});
