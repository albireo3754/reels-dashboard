import {test,expect,type Page} from "@playwright/test";
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
const SOURCE='---\ntitle: "Example article"\nmarkup: 1\nmedia: ./media/\nnotes: article.notes.md\nstyle: {bodyPx: 16, mobileBodyPx: 17}\n---\n\n<Bundle id="B1" name="First" question="why">\n<Photo file="photo.png" alt="Example photo"/>\n\n¶ P1\n⟦First⟧¹ line\n  ¹ 적갈 up19 · main\n\n¶ P2\nSecond line\n\n¶ P3\n벤치에서 잠시 쉬었어요. 바람이 좋았어요.\n\n¶ P4\n아메리카노는 맛있었어요. 케이크도 맛있었어요.\n\n¶ P5\n오늘은 정말 좋았어요.\n\n¶ P6\n커피를 마셨어요.\n</Bundle>\n';
const P3="벤치에서 잠시 쉬었어요. 바람이 좋았어요.",P4="아메리카노는 맛있었어요. 케이크도 맛있었어요.",P5="오늘은 정말 좋았어요.";
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
const REVIEW_UI=/data-review-ui|rv-(card|stack|diff|del|ins|eq|format|note)|현재 유지|AI 제안/;

const iframe=(page:Page)=>page.locator('iframe[title="정본 본문 편집"]');
/** Plain text of every [data-tid] paragraph plus whether any review UI leaked inside one. */
async function paragraphs(page:Page){
  return iframe(page).evaluate((el:HTMLIFrameElement)=>{
    const d=el.contentDocument!;
    return [...d.querySelectorAll<HTMLElement>("[data-tid]")].map(p=>({id:p.dataset.tid!,text:p.innerText,leak:!!p.querySelector("[data-review-ui]")||/rv-|data-review-ui/.test(p.innerHTML)}));
  });
}
async function noOverflow(page:Page){
  const pageFits=await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth);
  const frameFits=await iframe(page).evaluate((el:HTMLIFrameElement)=>{
    const html=el.contentDocument!.documentElement;
    const cards=[...el.contentDocument!.querySelectorAll<HTMLElement>(".rv-card")];
    return html.scrollWidth<=html.clientWidth+1&&cards.every(c=>{const r=c.getBoundingClientRect();return r.left>=-1&&r.right<=html.clientWidth+1;});
  });
  return pageFits&&frameFits;
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
    const card=(id:string)=>frame.locator(`.rv-card[data-proposal="${id}"]`);
    const save=page.getByRole("button",{name:"정본 저장",exact:true});
    await expect(frame.locator('[data-tid="P3"]')).toHaveText(P3);

    // (1) Inline text diff right after the target paragraph: only the changed part.
    const ending=card("ending");
    await expect(ending).toBeVisible();
    await expect(ending).toHaveAttribute("role","group");
    await expect(ending.locator(".rv-del")).toHaveText("어요");
    await expect(ending.locator(".rv-ins")).toHaveText("다");
    await expect(ending).not.toContainText("바람이 좋았어요");
    expect(await frame.locator('[data-tid="P3"]').evaluate(p=>{
      // The review stack is a sibling after the paragraph, before the next paragraph.
      for(let n=p.nextElementSibling;n;n=n.nextElementSibling){
        if(n.matches("[data-tid]"))return false;
        if(n.matches(".rv-stack")&&n.querySelector('[data-proposal="ending"]'))return n.getAttribute("contenteditable")==="false";
      }
      return false;
    })).toBe(true);
    // In-text marking is a CSS highlight over the exact deleted characters; paragraph DOM is untouched.
    await expect.poll(()=>iframe(page).evaluate((el:HTMLIFrameElement)=>{
      const w=el.contentWindow as any,h=w.CSS?.highlights?.get("rv-del");
      return !!h&&[...h].some((r:Range)=>r.toString()==="어요");
    })).toBe(true);
    expect((await paragraphs(page)).find(p=>p.id==="P3")).toEqual({id:"P3",text:P3,leak:false});

    // (3) Format proposal: current vs proposed samples with real styles near the phrase.
    const color=card("color");
    await expect(color.locator(".rv-format")).toBeVisible();
    await expect(color.locator('.rv-sample[data-variant="current"]')).toContainText("line");
    await expect(color.locator('.rv-sample[data-variant="proposed"]')).toContainText("line");
    const styles=await color.evaluate(c=>{
      const pick=(v:string)=>{const s=c.querySelector(`.rv-sample[data-variant="${v}"]`)!;const leaf=[...s.querySelectorAll<HTMLElement>("*")].find(e=>e.textContent==="line")??s as HTMLElement;const cs=getComputedStyle(leaf);return {color:cs.color,size:cs.fontSize};};
      return {current:pick("current"),proposed:pick("proposed"),paragraph:getComputedStyle(document.querySelector('[data-tid="P2"]')!).fontSize};
    });
    expect(styles.proposed.color).toBe("rgb(0, 150, 220)");
    expect(styles.current.color).not.toBe("rgb(0, 150, 220)");
    expect(styles.proposed.size).toBe(styles.paragraph);

    // Photo/layout opinions are notes anchored near the related image, not text replacements.
    const note=card("photo-note");
    await expect(note).toBeVisible();
    await expect(note).toContainText("photo.png");
    await expect(note.getByRole("button",{name:"적용",exact:true})).toHaveCount(0);
    expect(await iframe(page).evaluate((el:HTMLIFrameElement)=>{
      const d=el.contentDocument!,n=d.querySelector('[data-proposal="photo-note"]')!,img=d.querySelector("img")!,p1=d.querySelector('[data-tid="P1"]')!;
      return !!(img.compareDocumentPosition(n)&Node.DOCUMENT_POSITION_FOLLOWING)&&!!(n.compareDocumentPosition(p1)&Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);

    // Multiple proposals in one paragraph are ordered by position and overlap is explained.
    expect(await frame.locator('[data-tid="P4"]').evaluate(p=>{
      for(let n=p.nextElementSibling;n&&!n.matches("[data-tid]");n=n.nextElementSibling)
        if(n.matches(".rv-stack"))return [...n.querySelectorAll<HTMLElement>(".rv-card")].map(c=>c.dataset.proposal);
      return [];
    })).toEqual(["multiA","multiB","multiC"]);
    await expect(card("multiA")).toContainText("다른 제안과 범위가 겹쳐요");
    for(const id of ["ending","multiA","multiB","multiC","edit","color"])
      await expect(card(id).getByRole("button",{name:"적용",exact:true})).toBeEnabled();
    // 적용 buttons stay comfortably tappable.
    expect((await ending.getByRole("button",{name:"적용",exact:true}).boundingBox())!.height).toBeGreaterThanOrEqual(32);

    // (4) Right panel is an auxiliary list with navigation to the body card.
    const list=page.locator(".ce-proposal");
    await expect(list).toHaveCount(FINDINGS.length);
    const multiCItem=list.filter({hasText:"케이크까지"});
    await expect(multiCItem).toHaveAttribute("data-state","available");
    await multiCItem.getByRole("button",{name:"본문에서 보기",exact:true}).click();
    await expect.poll(()=>card("multiC").evaluate(c=>c.contains(c.ownerDocument.activeElement))).toBe(true);
    await expect(list.filter({hasText:"photo.png"}).getByRole("button",{name:"본문에서 보기",exact:true})).toHaveCount(1);
    await page.screenshot({path:info.outputPath("inline-review-desktop.png"),fullPage:true});

    // (2) 현재 유지 hides the diff and never changes the body.
    await card("keep").getByRole("button",{name:"현재 유지",exact:true}).click();
    await expect(card("keep")).toHaveCount(0);
    await expect(frame.locator('[data-tid="P5"]')).toHaveText(P5);
    await expect(save).toBeDisabled();
    await expect(list.filter({hasText:"아주 좋았어요"})).toHaveAttribute("data-state","decided");
    expect(await readFile(config.canon,"utf8")).toBe(SOURCE);

    // 적용 replaces only the target phrase in the editable body; nothing is written until save.
    await ending.getByRole("button",{name:"적용",exact:true}).click();
    await expect(frame.locator('[data-tid="P3"]')).toHaveText("벤치에서 잠시 쉬었다. 바람이 좋았어요.");
    await expect(card("ending")).toHaveCount(0);
    await expect(save).toBeEnabled();
    await expect(list.filter({hasText:"쉬었다"})).toHaveAttribute("data-state","applied");
    expect(await readFile(config.canon,"utf8")).toBe(SOURCE);

    // Applying one of several proposals re-validates the rest against the new paragraph.
    await card("multiA").getByRole("button",{name:"적용",exact:true}).click();
    await expect(frame.locator('[data-tid="P4"]')).toHaveText("아메리카노는 진했어요. 케이크도 맛있었어요.");
    await expect(card("multiA")).toHaveCount(0);
    await expect(card("multiB").locator(".rv-reason-line")).toBeVisible();
    await expect(card("multiB").getByRole("button",{name:"적용",exact:true})).toBeDisabled();
    await expect(card("multiC").getByRole("button",{name:"적용",exact:true})).toBeEnabled();
    await expect(card("multiC")).not.toContainText("다른 제안과 범위가 겹쳐요");

    // A target the user edited directly is blocked with a reason and never highlighted at a guessed place.
    await frame.locator('[data-tid="P6"]').fill("차를 마셨어요.");
    await expect(card("edit").locator(".rv-reason-line")).toBeVisible();
    await expect(card("edit").getByRole("button",{name:"적용",exact:true})).toBeDisabled();
    expect(await iframe(page).evaluate((el:HTMLIFrameElement)=>{
      const w=el.contentWindow as any,p6=el.contentDocument!.querySelector('[data-tid="P6"]')!;
      if(!w.CSS?.highlights)return true;
      return [...w.CSS.highlights.values()].every((h:any)=>[...h].every((r:Range)=>!p6.contains(r.startContainer)));
    })).toBe(true);

    // (5) Mobile: cards stay with their paragraph, within paper width, without horizontal scroll.
    await page.setViewportSize({width:390,height:844});
    await expect.poll(()=>noOverflow(page)).toBe(true);
    expect(await frame.locator('[data-tid="P4"]').evaluate(p=>{
      const pr=p.getBoundingClientRect();
      for(let n=p.nextElementSibling;n&&!n.matches("[data-tid]");n=n.nextElementSibling)
        if(n.matches(".rv-stack"))return [...n.querySelectorAll(".rv-card")].every(c=>{const r=c.getBoundingClientRect();return r.left>=pr.left-1&&r.right<=pr.right+1;});
      return false;
    })).toBe(true);
    await card("multiC").scrollIntoViewIfNeeded();
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
    expect(await readFile(config.layout,"utf8")).not.toMatch(REVIEW_UI);

    // Reopen: manuscript is clean, applied proposals have no body card.
    await page.reload();
    await expect(frame.locator('[data-tid="P3"]')).toHaveText("벤치에서 잠시 쉬었다. 바람이 좋았어요.");
    await expect(card("color")).toBeVisible();
    const after=await paragraphs(page);
    expect(after.filter(p=>p.leak)).toEqual([]);
    expect(after.find(p=>p.id==="P4")?.text).toBe("아메리카노는 진했어요. 케이크도 맛있었어요.");
    await expect(card("ending")).toHaveCount(0);
    await expect(card("multiA")).toHaveCount(0);
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
    const card=(id:string)=>frame.locator(`.rv-card[data-proposal="${id}"]`);
    await expect(card("ending")).toBeVisible();

    // Targets inside a link (URL or part of the label) are blocked and never highlighted on the label.
    await expect(frame.locator('[data-tid="P7"] a')).toHaveText("old cafe");
    for(const id of ["url","label"]){
      await expect(card(id).locator(".rv-reason-line")).toContainText("링크");
      await expect(card(id).getByRole("button",{name:"적용",exact:true})).toBeDisabled();
    }
    expect(await iframe(page).evaluate((el:HTMLIFrameElement)=>{
      const w=el.contentWindow as any,p7=el.contentDocument!.querySelector('[data-tid="P7"]')!;
      if(!w.CSS?.highlights)return true;
      return [...w.CSS.highlights.values()].every((h:any)=>[...h].every((r:Range)=>!p7.contains(r.startContainer)&&!p7.contains(r.endContainer)));
    })).toBe(true);

    // An expanded 이유 survives re-rendering caused by typing in a paragraph with proposals.
    const why=card("ending").getByRole("button",{name:"이유",exact:true});
    await why.click();
    await expect(why).toHaveAttribute("aria-expanded","true");
    await expect(card("ending").locator(".rv-why")).toBeVisible();
    await frame.locator('[data-tid="P6"]').fill("차를 마셨어요.");
    await expect(card("edit").locator(".rv-reason-line")).toBeVisible();
    await page.waitForTimeout(600);
    await expect(card("ending").getByRole("button",{name:"이유",exact:true})).toHaveAttribute("aria-expanded","true");
    await expect(card("ending").locator(".rv-why")).toBeVisible();
    // Blocked cards keep the full before/after reachable in their reason.
    await card("edit").getByRole("button",{name:"이유",exact:true}).click();
    await expect(card("edit").locator(".rv-why")).toContainText("원문: 커피를 마셨어요");
    await expect(card("edit").locator(".rv-why")).toContainText("제안: 커피를 천천히 마셨어요");

    // Keyboard 현재 유지 moves focus to the next proposal instead of dropping it to the document.
    await card("keep").getByRole("button",{name:"현재 유지",exact:true}).focus();
    await page.keyboard.press("Enter");
    await expect(card("keep")).toHaveCount(0);
    await expect.poll(()=>iframe(page).evaluate((el:HTMLIFrameElement)=>{
      const a=el.contentDocument!.activeElement;return !!a?.closest(".rv-card")&&a!.tagName==="BUTTON";
    })).toBe(true);

    // A re-review that reuses the id with different content refuses a click on the stale card.
    const stale=proposalSignature(LINK_FINDINGS[0] as CanonicalFinding);
    await writeFile(config.review,reviews([text("ending","P3","쉬었어요","쉬었습니다"),...LINK_FINDINGS.slice(1)]));
    await expect(card("ending").locator(".rv-ins")).toContainText("습니다");
    await frame.locator("body").evaluate((_,sig)=>parent.postMessage({editor:true,type:"proposal-action",action:"apply",id:"ending",sig},location.origin),stale);
    await expect(page.getByRole("alert")).toContainText("제안 내용이 방금 바뀌었어요");
    await expect(frame.locator('[data-tid="P3"]')).toHaveText(P3);
    await card("ending").getByRole("button",{name:"적용",exact:true}).click();
    await expect(frame.locator('[data-tid="P3"]')).toHaveText("벤치에서 잠시 쉬었습니다. 바람이 좋았어요.");
    expect(await readFile(config.canon,"utf8")).toBe(LINK_SOURCE);
    expect(errors).toEqual([]);
  }finally{await page.close();await server?.close();await rm(root,{recursive:true,force:true});}
});
