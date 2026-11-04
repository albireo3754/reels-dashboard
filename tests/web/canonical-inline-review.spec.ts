import {test,expect,type Page,type FrameLocator} from "@playwright/test";
import {mkdtemp,writeFile,readFile,rm} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {markupFixture} from "../fixtures/markup-editor";
import {startCanonicalEditor} from "../../src/app/blog-editor/server";
import {parse} from "../../src/shared/blog-markup";
import {bundleHashes} from "../../src/shared/blog-markup-source";
import {proposalSignature} from "../../src/shared/inline-review";
import type {CanonicalFinding} from "../../src/shared/canonical-blog";

// Synthetic manuscript only. Real manuscripts are never opened by this spec.
// Review proposals are drawn Cursor-style inside the text: a CSS highlight over the
// deleted characters, an empty non-editable <span data-review-ui="ins"> whose words
// come from CSS generated content, small markers for non-text kinds, and one popover
// for the active proposal. None of it may reach the manuscript.
const SOURCE='---\ntitle: "Example article"\nmarkup: 1\nmedia: ./media/\nnotes: article.notes.md\nstyle: {bodyPx: 16, mobileBodyPx: 17}\n---\n\n<Bundle id="B1" name="First" question="why">\n<Photo file="photo.png" alt="Example photo"/>\n\n¶ P1\n⟦First⟧¹ line\n  ¹ 적갈 up19 · main\n\n¶ P2\nSecond line\n\n¶ P3\n벤치에서 잠시 쉬었어요. 바람이 좋았어요.\n\n¶ P4\n아메리카노는 맛있었어요. 케이크도 맛있었어요.\n\n¶ P5\n오늘은 정말 좋았어요.\n\n¶ P6\n커피를 마셨어요.\n</Bundle>\n';
const P3="벤치에서 잠시 쉬었어요. 바람이 좋았어요.",P5="오늘은 정말 좋았어요.";
const text=(id:string,tid:string,before:string,after:string,severity="권장")=>({id,axis:"문장",severity,observation:`${id}: 문장을 다듬어요.`,proposal:{layer:"text",tid,before,after}});
const FINDINGS=[
  text("ending","P3","쉬었어요","쉬었다"),
  text("keep","P5","정말 좋았어요","아주 좋았어요"),
  text("multiA","P4","아메리카노는 맛있었어요","아메리카노는 진했어요"),
  text("multiB","P4","맛있었어요. 케이크도","맛있었고 케이크도"),
  text("multiC","P4","케이크도","케이크까지"),
  text("edit","P6","커피를 마셨어요","커피를 천천히 마셨어요"),
  {id:"color",axis:"강조",severity:"권장",observation:"line을 하늘색으로 강조해요.",sourceAtReview:"Second line",proposal:{layer:"emphasis",op:"add",entry:{id:"P2",phrase:"line",style:{color:"#0096dc"}}}},
  {id:"photo-note",axis:"사진",severity:"참고",observation:"photo.png 사진을 첫 문단 뒤로 옮기면 흐름이 자연스러워요."},
];
const REVIEW_UI=/data-review-ui|data-pid|rv-(card|stack|diff|del|ins|eq|format|note|hint|marker|warn|defer|target|focus)|현재 유지|AI 제안|✦|⚠ 확인 필요|겹친 제안/;

const iframe=(page:Page)=>page.locator('iframe[title="정본 본문 편집"]');
/** In-text review node (inserted words or marker) of one proposal. */
const mark=(frame:FrameLocator,id:string)=>frame.locator(`[data-review-ui="ins"][data-pid="${id}"],[data-review-ui="marker"][data-pid="${id}"]`);
/**
 * Click the proposal's in-text node and wait for its popover. An open popover can sit over
 * a neighbouring line (it flips above near the end of the paper), so it is closed first by
 * moving focus out of the text, like a writer clicking elsewhere.
 */
async function openProposal(frame:FrameLocator,id:string){
  const hint=frame.locator('[data-review-ui="hint"]');
  if(await hint.count()){
    await frame.locator("body").evaluate(()=>{(document.activeElement as HTMLElement|null)?.blur();getSelection()?.removeAllRanges();});
    await expect(hint).toHaveCount(0);
  }
  await mark(frame,id).first().click();
  await expect(frame.locator('[data-review-ui="hint"]')).toHaveAttribute("data-pid",id);
}
/** Plain text of every [data-tid] paragraph plus whether review UI leaked text into one. */
async function paragraphs(page:Page){
  return iframe(page).evaluate((el:HTMLIFrameElement)=>{
    const d=el.contentDocument!;
    return [...d.querySelectorAll<HTMLElement>("[data-tid]")].map(p=>{
      const ui=[...p.querySelectorAll<HTMLElement>("[data-review-ui]")];
      // Review nodes may sit in a paragraph, but only as empty, non-editable spans.
      const leak=ui.some(n=>n.textContent!==""||n.getAttribute("contenteditable")!=="false"||!["ins","marker"].includes(n.dataset.reviewUi!))||/rv-card|rv-stack/.test(p.innerHTML);
      return {id:p.dataset.tid!,text:p.innerText,leak};
    });
  });
}
async function noOverflow(page:Page){
  const pageFits=await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
  const frameFits=await iframe(page).evaluate((el:HTMLIFrameElement)=>{
    const html=el.contentDocument!.documentElement;
    // Popover, inserted words and markers all stay inside the frame width.
    const ui=[...el.contentDocument!.querySelectorAll<HTMLElement>('[data-review-ui="hint"],[data-review-ui="ins"],[data-review-ui="marker"],[data-review-ui="note-row"]')].filter(n=>n.getClientRects().length);
    return html.scrollWidth<=html.clientWidth+1&&ui.every(n=>[...n.getClientRects()].every(r=>r.left>=-1&&r.right<=html.clientWidth+1));
  });
  return pageFits&&frameFits;
}
/** Every Custom Highlight range that touches paragraph tid. */
async function highlightsIn(page:Page,tid:string){
  return iframe(page).evaluate((el:HTMLIFrameElement,tid)=>{
    const w=el.contentWindow as any,p=el.contentDocument!.querySelector(`[data-tid="${tid}"]`)!;
    if(!w.CSS?.highlights)return [];
    const out:string[]=[];
    for(const [name,h] of w.CSS.highlights)for(const r of h as Iterable<Range>)if(p.contains(r.startContainer)||p.contains(r.endContainer))out.push(name+":"+r.toString());
    return out;
  },tid);
}

test("AI proposals render as inline diffs next to their target and never leak into the manuscript",async({page},info)=>{
  test.setTimeout(120_000);
  const root=await mkdtemp(path.join(os.tmpdir(),"inline-review-"));let server;
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  try{
    const config={...await markupFixture(root),review:path.join(root,"reviews.json")};
    await writeFile(config.canon,SOURCE);
    await writeFile(config.review,JSON.stringify({reviews:[{bundleId:"B1",summary:"합성 문장 제안",verdict:"needs-work",basedOn:bundleHashes(parse(SOURCE)).B1,findings:FINDINGS}]}));
    server=await startCanonicalEditor(config);
    await page.setViewportSize({width:1440,height:1000});
    await page.goto(server.url+"/?blogEditor=1");
    const frame=page.frameLocator('iframe[title="정본 본문 편집"]');
    const hint=frame.locator('[data-review-ui="hint"]');
    const save=page.getByRole("button",{name:"정본 저장",exact:true});
    await expect(frame.locator('[data-tid="P3"]')).toHaveText(P3);

    // (1) Inline text diff inside the target paragraph: only the changed part.
    const ending=frame.locator('[data-review-ui="ins"][data-pid="ending"]');
    await expect(ending).toHaveCount(1);
    await expect(ending).toBeVisible();
    await expect(ending).toHaveAttribute("data-text","다");
    await expect(ending).toHaveAttribute("contenteditable","false");
    await expect(ending).toHaveAttribute("aria-hidden","true");
    await expect(ending).toHaveText("");
    expect(await ending.evaluate(n=>({tid:(n.closest("[data-tid]") as HTMLElement|null)?.dataset.tid,after:getComputedStyle(n,"::after").content}))).toEqual({tid:"P3",after:'"다"'});
    await expect(frame.locator(".rv-stack,.rv-card")).toHaveCount(0);
    // In-text marking of the deleted characters is a CSS highlight; the paragraph text is untouched.
    await expect.poll(()=>highlightsIn(page,"P3")).toEqual(["rv-del:어요"]);
    expect((await paragraphs(page)).find(p=>p.id==="P3")).toEqual({id:"P3",text:P3,leak:false});
    // No popover until a proposal is active.
    await expect(hint).toHaveCount(0);

    // (3) Format proposal: a marker at the phrase; its popover shows current vs proposed with real styles.
    const colorMark=mark(frame,"color");
    await expect(colorMark).toHaveAttribute("data-label","✦ 서식");
    await expect(colorMark).toHaveClass(/rv-format/);
    await expect.poll(()=>highlightsIn(page,"P2")).toContain("rv-target:line");
    await openProposal(frame,"color");
    await expect(hint.locator(".rv-format")).toBeVisible();
    await expect(hint.locator('.rv-sample[data-variant="current"]')).toContainText("line");
    await expect(hint.locator('.rv-sample[data-variant="proposed"]')).toContainText("line");
    const styles=await hint.evaluate(c=>{
      const pick=(v:string)=>{const s=c.querySelector(`.rv-sample[data-variant="${v}"]`)!;const leaf=[...s.querySelectorAll<HTMLElement>("*")].find(e=>e.textContent==="line")??s as HTMLElement;const cs=getComputedStyle(leaf);return {color:cs.color,size:cs.fontSize};};
      return {current:pick("current"),proposed:pick("proposed"),paragraph:getComputedStyle(document.querySelector('[data-tid="P2"]')!).fontSize};
    });
    expect(styles.proposed.color).toBe("rgb(0, 150, 220)");
    expect(styles.current.color).not.toBe("rgb(0, 150, 220)");
    expect(styles.proposed.size).toBe(styles.paragraph);

    // Photo/layout opinions are notes anchored near the related image, not text replacements.
    const note=mark(frame,"photo-note");
    await expect(note).toBeVisible();
    await expect(note).toHaveAttribute("data-label","✦ 메모");
    expect(await note.evaluate(n=>n.parentElement?.getAttribute("data-review-ui"))).toBe("note-row");
    await openProposal(frame,"photo-note");
    await expect(hint).toContainText("photo.png");
    await expect(hint.locator("[data-act=apply]")).toHaveCount(0);
    expect(await iframe(page).evaluate((el:HTMLIFrameElement)=>{
      const d=el.contentDocument!,n=d.querySelector('[data-review-ui="marker"][data-pid="photo-note"]')!,img=d.querySelector("img")!,p1=d.querySelector('[data-tid="P1"]')!;
      return !!(img.compareDocumentPosition(n)&Node.DOCUMENT_POSITION_FOLLOWING)&&!!(n.compareDocumentPosition(p1)&Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);

    // Several proposals in one paragraph: only non-overlapping ones are inline; the overlap is a marker that explains itself.
    expect(await frame.locator('[data-tid="P4"]').evaluate(p=>[...p.querySelectorAll<HTMLElement>("[data-review-ui]")].map(n=>`${n.dataset.reviewUi}:${n.dataset.pid}`)))
      .toEqual(["ins:multiA","ins:multiC","marker:multiB"]);
    await expect(mark(frame,"multiB")).toHaveClass(/rv-defer/);
    await expect(mark(frame,"multiB")).toHaveAttribute("data-label","✦ 겹친 제안");
    await openProposal(frame,"multiB");
    await expect(hint).toContainText("다른 제안과 범위가 겹쳐요");
    for(const id of ["ending","multiA","multiC","edit","color"]){
      await openProposal(frame,id);
      await expect(hint.locator("[data-act=apply]")).toBeEnabled();
    }
    // A deferred overlap is information only until the host re-validates it.
    await openProposal(frame,"multiB");
    await expect(hint.locator("[data-act=apply]")).toBeDisabled();
    // One popover at a time.
    await expect(hint).toHaveCount(1);
    // 적용 buttons stay clickable on desktop (min-height 30px; 36px on phones, checked below).
    expect((await hint.locator("[data-act=apply]").boundingBox())!.height).toBeGreaterThanOrEqual(30);

    // (4) Right panel is an auxiliary list with navigation to the proposal in the text.
    const list=page.locator(".ce-proposal");
    await expect(list).toHaveCount(FINDINGS.length);
    const multiCItem=list.filter({hasText:"케이크까지"});
    await expect(multiCItem).toHaveAttribute("data-state","available");
    await multiCItem.getByRole("button",{name:"본문에서 보기",exact:true}).click();
    await expect(hint).toHaveAttribute("data-pid","multiC");
    await expect.poll(()=>iframe(page).evaluate((el:HTMLIFrameElement)=>(el.contentDocument!.activeElement as HTMLElement|null)?.dataset.tid)).toBe("P4");
    await expect(list.filter({hasText:"photo.png"}).getByRole("button",{name:"본문에서 보기",exact:true})).toHaveCount(1);
    await page.screenshot({path:info.outputPath("inline-review-desktop.png"),fullPage:true});

    // (2) 현재 유지 hides the diff and never changes the body.
    await openProposal(frame,"keep");
    await hint.locator("[data-act=keep]").click();
    await expect(mark(frame,"keep")).toHaveCount(0);
    await expect(frame.locator('[data-tid="P5"]')).toHaveText(P5);
    await expect(save).toBeDisabled();
    const keepItem=list.filter({hasText:"아주 좋았어요"});
    await expect(keepItem).toHaveAttribute("data-state","decided");
    await expect(keepItem.locator(".ce-chip")).toHaveText("현재 유지");
    expect(await readFile(config.canon,"utf8")).toBe(SOURCE);

    // 적용 replaces only the target phrase in the editable body; nothing is written until save.
    await openProposal(frame,"ending");
    await hint.locator("[data-act=apply]").click();
    await expect(frame.locator('[data-tid="P3"]')).toHaveText("벤치에서 잠시 쉬었다. 바람이 좋았어요.");
    await expect(mark(frame,"ending")).toHaveCount(0);
    await expect.poll(()=>highlightsIn(page,"P3")).toEqual([]);
    await expect(save).toBeEnabled();
    await expect(list.filter({hasText:"쉬었다"})).toHaveAttribute("data-state","applied");
    expect(await readFile(config.canon,"utf8")).toBe(SOURCE);

    // Applying one of several proposals re-validates the rest against the new paragraph.
    await openProposal(frame,"multiA");
    await hint.locator("[data-act=apply]").click();
    await expect(frame.locator('[data-tid="P4"]')).toHaveText("아메리카노는 진했어요. 케이크도 맛있었어요.");
    await expect(mark(frame,"multiA")).toHaveCount(0);
    // multiB's target is gone: stale proposals draw nothing; the panel says why.
    await expect(mark(frame,"multiB")).toHaveCount(0);
    const multiBItem=list.filter({hasText:"맛있었고 케이크도"});
    await expect(multiBItem).toHaveAttribute("data-state","changed");
    await expect(multiBItem.locator(".ce-chip")).toHaveText("본문 변경됨");
    await expect(multiBItem.locator(".ce-proposal-reason")).toBeVisible();
    await openProposal(frame,"multiC");
    await expect(hint.locator("[data-act=apply]")).toBeEnabled();
    await expect(hint).not.toContainText("다른 제안과 범위가 겹쳐요");

    // A target the user edited directly is not drawn at a guessed place; the panel explains it.
    await frame.locator('[data-tid="P6"]').fill("차를 마셨어요.");
    await expect.poll(()=>list.filter({hasText:"커피를 천천히 마셨어요"}).getAttribute("data-state")).toBe("changed");
    await page.waitForTimeout(600);
    await expect(mark(frame,"edit")).toHaveCount(0);
    expect(await highlightsIn(page,"P6")).toEqual([]);
    await expect(list.filter({hasText:"커피를 천천히 마셨어요"}).locator(".ce-chip")).toHaveText("본문 변경됨");

    // (5) Mobile: diffs stay inside their paragraph and the popover inside the paper, without horizontal scroll.
    await page.setViewportSize({width:390,height:844});
    await expect.poll(()=>noOverflow(page)).toBe(true);
    expect(await frame.locator('[data-tid="P4"]').evaluate(p=>{
      const pr=p.getBoundingClientRect(),ui=[...p.querySelectorAll("[data-review-ui]")];
      return ui.length>0&&ui.every(n=>[...n.getClientRects()].every(r=>r.left>=pr.left-1&&r.right<=pr.right+1));
    })).toBe(true);
    await openProposal(frame,"multiC");
    await expect.poll(()=>noOverflow(page)).toBe(true);
    expect((await hint.locator("[data-act=apply]").boundingBox())!.height).toBeGreaterThanOrEqual(36);
    await hint.scrollIntoViewIfNeeded();
    await page.screenshot({path:info.outputPath("inline-review-mobile.png")});
    await page.setViewportSize({width:1440,height:1000});

    // Save: only manuscript text reaches the source and derived preview.
    await save.click();
    await expect(page.getByText("정본과 미리보기를 저장했어요.",{exact:false})).toBeVisible();
    const saved=await readFile(config.canon,"utf8");
    expect(saved).toContain("벤치에서 잠시 쉬었다. 바람이 좋았어요.");
    expect(saved).toContain("아메리카노는 진했어요. 케이크도 맛있었어요.");
    expect(saved).toContain("차를 마셨어요.");
    expect(saved).toContain(P5);
    expect(saved).not.toMatch(REVIEW_UI);
    expect(saved).not.toContain("적용");
    expect(saved).not.toContain("케이크까지");
    expect(await readFile(config.layout,"utf8")).not.toMatch(REVIEW_UI);

    // Reopen: manuscript is clean, applied proposals are not drawn.
    await page.reload();
    await expect(frame.locator('[data-tid="P3"]')).toHaveText("벤치에서 잠시 쉬었다. 바람이 좋았어요.");
    await expect(mark(frame,"color")).toBeVisible();
    const after=await paragraphs(page);
    expect(after.filter(p=>p.leak)).toEqual([]);
    expect(after.find(p=>p.id==="P4")?.text).toBe("아메리카노는 진했어요. 케이크도 맛있었어요.");
    await expect(mark(frame,"ending")).toHaveCount(0);
    await expect(mark(frame,"multiA")).toHaveCount(0);
    await expect(list.filter({hasText:"쉬었다"})).toHaveAttribute("data-state","applied");
    expect(await readFile(config.canon,"utf8")).toBe(saved);
    expect(errors).toEqual([]);
  }finally{await server?.close();await rm(root,{recursive:true,force:true});}
});

const LINK_SOURCE=SOURCE.replace("\n</Bundle>","\n\n¶ P7\n[old cafe](https://example.com) 근처에서 쉬었어요.\n</Bundle>");
const LINK_FINDINGS=[
  text("ending","P3","쉬었어요","쉬었다"),
  text("keep","P5","정말 좋았어요","아주 좋았어요"),
  text("edit","P6","커피를 마셨어요","커피를 천천히 마셨어요"),
  text("url","P7","example","newdomain"),
  text("label","P7","old","new"),
];

test("inline proposals stay correct across links, re-reviews, edits and keyboard decisions",async({page})=>{
  test.setTimeout(120_000);
  const root=await mkdtemp(path.join(os.tmpdir(),"inline-review-edge-"));let server;
  const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  try{
    const config={...await markupFixture(root),review:path.join(root,"reviews.json")};
    await writeFile(config.canon,LINK_SOURCE);
    const reviews=(findings:unknown[])=>JSON.stringify({reviews:[{bundleId:"B1",summary:"합성 제안",verdict:"needs-work",basedOn:bundleHashes(parse(LINK_SOURCE)).B1,findings}]});
    await writeFile(config.review,reviews(LINK_FINDINGS));
    server=await startCanonicalEditor(config);
    await page.setViewportSize({width:1440,height:1000});
    await page.goto(server.url+"/?blogEditor=1");
    const frame=page.frameLocator('iframe[title="정본 본문 편집"]');
    const hint=frame.locator('[data-review-ui="hint"]');
    await expect(mark(frame,"ending")).toBeVisible();

    // Targets inside a link (URL or part of the label) are blocked: a warning marker, never a highlight on the label.
    await expect(frame.locator('[data-tid="P7"] a')).toHaveText("old cafe");
    await expect(frame.locator('[data-tid="P7"] a [data-review-ui]')).toHaveCount(0);
    for(const id of ["url","label"]){
      await expect(mark(frame,id)).toHaveClass(/rv-warn/);
      await expect(mark(frame,id)).toHaveAttribute("data-label","⚠ 확인 필요");
      await openProposal(frame,id);
      await expect(hint.locator(".rv-reason-line")).toContainText("링크");
      await expect(hint.locator("[data-act=apply]")).toBeDisabled();
    }
    expect(await highlightsIn(page,"P7")).toEqual([]);
    // Blocked markers keep the full before/after reachable in their reason.
    await hint.locator("[data-act=why]").click();
    await expect(hint.locator(".rv-why")).toContainText("원문: old");
    await expect(hint.locator(".rv-why")).toContainText("제안: new");

    // An expanded 이유 survives re-rendering caused by typing in another paragraph.
    await openProposal(frame,"ending");
    const why=hint.locator("[data-act=why]");
    await why.click();
    await expect(why).toHaveAttribute("aria-expanded","true");
    await expect(hint.locator(".rv-why")).toBeVisible();
    await frame.locator('[data-tid="P6"]').fill("차를 마셨어요.");
    const editItem=page.locator(".ce-proposal").filter({hasText:"커피를 천천히 마셨어요"});
    await expect(editItem).toHaveAttribute("data-state","changed");
    await page.waitForTimeout(600);
    await expect(mark(frame,"edit")).toHaveCount(0);
    await openProposal(frame,"ending");
    await expect(hint.locator("[data-act=why]")).toHaveAttribute("aria-expanded","true");
    await expect(hint.locator(".rv-why")).toBeVisible();
    // A stale proposal keeps the full before/after reachable in the panel.
    await editItem.locator("summary").click();
    await expect(editItem.locator(".ce-proposal-full")).toContainText("커피를 마셨어요");
    await expect(editItem.locator(".ce-proposal-full")).toContainText("커피를 천천히 마셨어요");

    // Keyboard 현재 유지 (Enter on the focused popover button) moves on to the next proposal instead of dropping focus.
    await openProposal(frame,"keep");
    await hint.locator("[data-act=keep]").focus();
    await page.keyboard.press("Enter");
    await expect(mark(frame,"keep")).toHaveCount(0);
    await expect.poll(()=>hint.getAttribute("data-pid").catch(()=>null)).toMatch(/^(url|label)$/);
    await expect.poll(()=>iframe(page).evaluate((el:HTMLIFrameElement)=>(el.contentDocument!.activeElement as HTMLElement|null)?.dataset.tid)).toBe("P7");
    await expect(frame.locator('[data-tid="P5"]')).toHaveText(P5);

    // A re-review that reuses the id with different content refuses an action with the stale fingerprint.
    const stale=proposalSignature(LINK_FINDINGS[0] as CanonicalFinding);
    await writeFile(config.review,reviews([text("ending","P3","쉬었어요","쉬었습니다"),...LINK_FINDINGS.slice(1)]));
    await expect(mark(frame,"ending")).toHaveAttribute("data-text","습니다");
    await frame.locator("body").evaluate((_,sig)=>parent.postMessage({editor:true,type:"proposal-action",action:"apply",id:"ending",sig},location.origin),stale);
    await expect(page.getByRole("alert")).toContainText("제안 내용이 방금 바뀌었어요");
    await expect(frame.locator('[data-tid="P3"]')).toHaveText(P3);
    await openProposal(frame,"ending");
    await hint.locator("[data-act=apply]").click();
    await expect(frame.locator('[data-tid="P3"]')).toHaveText("벤치에서 잠시 쉬었습니다. 바람이 좋았어요.");
    expect(await readFile(config.canon,"utf8")).toBe(LINK_SOURCE);
    expect(errors).toEqual([]);
  }finally{await page.close();await server?.close();await rm(root,{recursive:true,force:true});}
});
