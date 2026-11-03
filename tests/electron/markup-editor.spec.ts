import {parse} from "../../src/shared/blog-markup";
import {paragraphNodes} from "../../src/shared/blog-markup-source";
import {test,expect,type Page} from "@playwright/test";
import {readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import {launchApp,makeProfile,closeApp,cleanProfile} from "./helpers";
import {markupFixture} from "../fixtures/markup-editor";

async function openReview(page: Page) {
  const toggle = page.getByRole("button", {name:"검토 보기",exact:true});
  if (await toggle.isVisible()) {
    if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
    await expect(page.getByRole("dialog", {name:"묶음 검토"})).toBeVisible();
  }
}
async function closeReview(page: Page) {
  const close = page.getByRole("button", {name:"검토 닫기",exact:true});
  if (await close.isVisible()) {
    await close.click();
    await expect(page.getByRole("dialog", {name:"묶음 검토"})).toBeHidden();
  }
}

test("desktop opens markup editor, saves text, reopens and preserves source grammar",async({},testInfo)=>{
  const profile=await makeProfile();let app;
  try{
    const config=await markupFixture(profile);
    await writeFile(path.join(profile,"blog-projects.json"),JSON.stringify({version:1,projects:[{id:"example",title:"Example project",config}]}));
    app=await launchApp(profile);
    const main=await app.firstWindow();
    await main.getByRole("button",{name:"블로그",exact:true}).click();
    const opened=app.waitForEvent("window");
    await main.getByRole("button",{name:"프로젝트 열기",exact:true}).click();
    const editor=await opened,errors:string[]=[];
    // Exercise the responsive drawer independently of the host display size.
    await editor.setViewportSize({width:960,height:720});
    editor.on("pageerror",e=>errors.push(e.message));
    await expect(editor.getByText("✓ 저장 완료",{exact:true})).toBeVisible();
    const frame=editor.frameLocator('iframe[title="정본 본문 편집"]');
    await expect(frame.locator('[data-tid="P1"]')).toContainText("First line");
    await expect(frame.locator('img')).toHaveCount(1);
    await frame.locator('[data-tid="P2"]').fill("Edited in app");
    await editor.getByRole("button",{name:"정본 저장",exact:true}).click();
    await expect(editor.getByText("정본과 미리보기를 저장했어요. 저장 전 사본도 보관했어요.",{exact:true})).toBeVisible();
    const raw=await readFile(config.canon,"utf8");
    expect(raw).toContain("Edited in app");expect(raw).toContain("⟦First⟧¹");expect(raw).toContain("up19 · main");expect(raw).not.toContain("### 본문");

    await frame.locator('[data-tid="P1"]').evaluate(el=>{
      const node=el.querySelector("span")!.firstChild!;
      const range=document.createRange();range.setStart(node,0);range.setEnd(node,5);
      const selection=window.getSelection()!;selection.removeAllRanges();selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await frame.getByRole("button",{name:"노랑 형광펜",exact:true}).click();
    await expect(frame.locator('[data-tid="P1"] span').first()).toHaveCSS("background-color","rgb(255, 248, 178)");
    await frame.getByRole("button",{name:"메모",exact:true}).click();
    await editor.getByRole("textbox",{name:"구절 메모",exact:true}).fill("Disclosure should stand out");
    await editor.getByRole("button",{name:"메모 저장",exact:true}).click();
    await expect(editor.getByText("Disclosure should stand out",{exact:true})).toBeVisible();
    await editor.getByRole("checkbox",{name:"First 확인 완료",exact:true}).check();
    await expect(frame.getByRole("button",{name:"메모 1 · ✓ 1",exact:true})).toBeVisible();
    await closeReview(editor);
    await editor.getByRole("button",{name:"정본 저장",exact:true}).click();
    await expect.poll(async()=>await readFile(config.canon,"utf8")).toContain("노랑배경");
    const annotations=JSON.parse(await readFile(config.canon+".annotations.json","utf8"));
    expect(annotations[0].note).toBe("Disclosure should stand out");expect(annotations[0].checked).toBe(true);
    expect(await readFile(config.canon,"utf8")).not.toContain("Disclosure should stand out");
    await editor.screenshot({path:testInfo.outputPath("markup-editor.png"),fullPage:true});
    expect(errors).toEqual([]);
    await editor.close();
    const reopened=app.waitForEvent("window");
    await main.getByRole("button",{name:"프로젝트 열기",exact:true}).click();
    const again=await reopened;
    await again.setViewportSize({width:960,height:720});
    await expect(again.getByText("✓ 저장 완료",{exact:true})).toBeVisible();
    await openReview(again);
    await expect(again.getByText("Disclosure should stand out",{exact:true})).toBeVisible();
    await expect(again.getByRole("checkbox",{name:"First 확인 완료",exact:true})).toBeChecked();
    await expect(again.frameLocator('iframe[title="정본 본문 편집"]').locator('[data-tid="P2"]')).toContainText("Edited in app");
  }finally{await closeApp(app);await cleanProfile(profile);}
});

test("real configured manuscript renders read-only with photos and no source writes",async({},testInfo)=>{
  test.skip(!process.env.REELS_MARKUP_CONFIG,"Requires explicitly provided local manuscript config");
  const profile=await makeProfile();let app;
  const config=JSON.parse(await readFile(process.env.REELS_MARKUP_CONFIG!,"utf8"));
  const original=await readFile(config.canon,"utf8");
  try{
    await writeFile(path.join(profile,"blog-projects.json"),JSON.stringify({version:1,projects:[{id:"example",title:"Example project",config}]}));
    app=await launchApp(profile);
    const main=await app.firstWindow();
    await main.getByRole("button",{name:"블로그",exact:true}).click();
    const opened=app.waitForEvent("window");
    await main.getByRole("button",{name:"프로젝트 열기",exact:true}).click();
    const editor=await opened;
    await expect(editor.getByText("✓ 저장 완료",{exact:true})).toBeVisible();
    const frame=editor.frameLocator('iframe[title="정본 본문 편집"]');
    await expect(frame.locator('[data-tid]:not([data-tid="$title"])')).toHaveCount(paragraphNodes(parse(original)).length);
    const photoCount=parse(original).bundles.flatMap(b=>b.nodes).reduce((sum,n)=>sum+(n.kind==="component"?(n.tag==="Photo"?1:n.tag==="Collage"?String(n.attrs.files).split(" · ").length:0):0),0);
    await expect(frame.locator('img')).toHaveCount(photoCount);
    await expect.poll(()=>frame.locator("img").evaluateAll(imgs=>imgs.every(i=>(i as HTMLImageElement).complete&&(i as HTMLImageElement).naturalWidth>0))).toBe(true);
    if(config.review){
      const reviews=JSON.parse(await readFile(config.review,"utf8")).reviews;
      const latest=reviews.find((r:any)=>r.generatedAt&&r.requestId);
      if(latest){
        const index=parse(original).bundles.findIndex(b=>b.id===latest.bundleId);
        await editor.getByRole("navigation",{name:"정본 묶음"}).getByRole("button").nth(index).click();
        await expect(editor.getByText("검토 응답 도착",{exact:true})).toBeVisible();
        await expect(editor.locator(".ce-proposal")).toHaveCount(latest.findings.filter((f:any)=>!["withdrawn","rejected","obsolete"].includes(f.status)).length);
        const data=await (await editor.request.get(new URL("/api/blog/document",editor.url()).href)).json();
        const {findingApplicability}=await import("../../src/shared/review-applicability");
        const current=data.reviews.find((r:any)=>r.bundleId===latest.bundleId).findings.filter((f:any)=>!["withdrawn","rejected","obsolete"].includes(f.status));
        // Apply buttons live in the in-text proposal popover (opened from the panel's "본문에서 보기"), not in the panel.
        const hint=frame.locator('[data-review-ui="hint"]');
        for(const f of current){
          const id=f.proposal?.tid??f.proposal?.entry?.id;
          const expected=findingApplicability(f,data.paragraphs.find((p:any)=>p.id===id)?.source).canApply;
          const reveal=editor.locator(`.ce-proposal[data-proposal="${f.id}"]`).getByRole("button",{name:"본문에서 보기",exact:true});
          if(!await reveal.count()){expect(expected).toBe(false);continue;}
          await reveal.click();
          await expect(hint).toHaveAttribute("data-pid",f.id);
          const apply=hint.getByRole("button",{name:"적용",exact:true});
          if(expected)await expect(apply).toBeEnabled();
          else if(await apply.count())await expect(apply).toBeDisabled();
        }
        // In-text review nodes are empty, non-editable decorations: the manuscript text is untouched.
        expect(await frame.locator("[data-tid]").evaluateAll(ps=>ps.every(p=>[...p.querySelectorAll("[data-review-ui]")].every(n=>["ins","marker"].includes(n.getAttribute("data-review-ui")!)&&n.textContent===""&&n.getAttribute("contenteditable")==="false")))).toBe(true);

      }
    }
    await editor.screenshot({path:testInfo.outputPath("real-markup-editor.png"),fullPage:true});
    expect(await readFile(config.canon,"utf8")).toBe(original);
  }finally{await closeApp(app);await cleanProfile(profile);}
});

test("markup review button runs engine and refreshes completed results without reload",async({},testInfo)=>{
  const {startWorkflowServer}=await import("../../src/app/workflow/server");
  const profile=await makeProfile();let app,server;
  try{
    const config={...await markupFixture(profile),review:path.join(profile,"reviews.json")};
    await writeFile(path.join(profile,"blog-projects.json"),JSON.stringify({version:1,projects:[{id:"example",title:"Example project",config}]}));
    server=await startWorkflowServer({root:path.join(profile,"workflow"),port:0,sdkEnv:{},sdkFactory:()=>({
      startThread:()=>({async runStreamed(prompt){
        const input=JSON.parse((typeof prompt==="string"?prompt:(prompt[0] as {text:string}).text).split("\nInput: ")[1].split("\nReturn resultJson")[0]);
        expect(Array.isArray(prompt)).toBe(true);
        expect(input.visualEvidence.map((e:any)=>e.width)).toEqual([360,390,430]);
        if(Array.isArray(prompt)){
          expect(prompt.filter(p=>p.type==="local_image")).toHaveLength(3);
          const img=prompt.find(p=>p.type==="local_image")!;
          if(img.type==="local_image")await testInfo.attach("captured-bundle",{body:await readFile(img.path),contentType:"image/png"});
        }
        return {events:(async function*(){
          yield {type:"item.completed" as const,item:{id:"answer",type:"agent_message" as const,text:JSON.stringify({resultJson:JSON.stringify({requestId:input.id,reviews:[{bundleId:"B1",verdict:"passed",summary:"Fresh review from running engine",findings:[],emphasisDecisions:[{tid:"P1",phrase:"First",role:"label",methods:["color","size"],action:"keep",reason:"Label contrast in screenshots",alternatives:"No background needed",findingIds:[]}],visual:{status:"pass",evidence:input.visualEvidence.map((e:any)=>e.sha256),observation:"Label distinct at all supplied widths"}}]})})}};
          yield {type:"turn.completed" as const,usage:{input_tokens:10,output_tokens:10,cached_input_tokens:0,cache_write_input_tokens:0,reasoning_output_tokens:0}};
        })()};
      }})
    })});
    app=await launchApp(profile,true,{REELS_WORKFLOW_URL:server.url});
    const main=await app.firstWindow();
    await main.getByRole("button",{name:"블로그",exact:true}).click();
    const opened=app.waitForEvent("window");
    await main.getByRole("button",{name:"프로젝트 열기",exact:true}).click();
    const editor=await opened;
    await editor.setViewportSize({width:960,height:720});
    await expect(editor.getByText("✓ 저장 완료",{exact:true})).toBeVisible();
    await editor.getByRole("button",{name:"이 묶음 검토",exact:true}).click();
    await expect(editor.getByRole("dialog",{name:"묶음 검토"})).toBeVisible();
    await expect(editor.getByText("검토 응답 도착",{exact:true})).toBeVisible({timeout:30000});
    await expect(editor.getByText("화면 확인 통과",{exact:true})).toBeVisible();
    await editor.getByText("묶음 평가 요약",{exact:true}).click();
    await expect(editor.getByText("Fresh review from running engine",{exact:true})).toBeVisible();
    await expect(editor.getByText("검토 요청됨 · 엔진 처리 대기",{exact:true})).toHaveCount(0);
    await editor.screenshot({path:testInfo.outputPath("review-completed.png"),fullPage:true});
    expect(JSON.parse(await readFile(config.review,"utf8")).reviews[0].provider).toBe("Codex");
  }finally{await closeApp(app);await server?.close();await cleanProfile(profile);}
});

test("independent proposals stay applicable after label recolor and sequential edits",async({},testInfo)=>{
 const {bundleHashes}=await import("../../src/shared/blog-markup-source");
 const profile=await makeProfile();let app;
 try{
  const config={...await markupFixture(profile),review:path.join(profile,"reviews.json")};
  const original=await readFile(config.canon,"utf8"),basedOn=bundleHashes(parse(original)).B1;
  const findings=[
    {id:"checks",axis:"강조",severity:"권장",observation:"add check",sourceAtReview:"Second line",proposal:{layer:"text",tid:"P2",before:"Second line",after:"✅ Second line"}},
    {id:"color1",axis:"강조",severity:"권장",observation:"color word",sourceAtReview:"Second line",proposal:{layer:"emphasis",op:"add",entry:{id:"P2",phrase:"Second",style:{color:"#85613f"}}}},
    {id:"color2",axis:"강조",severity:"권장",observation:"color another word",sourceAtReview:"Second line",proposal:{layer:"emphasis",op:"add",entry:{id:"P2",phrase:"line",style:{color:"#0096dc"}}}},
  ];
  await writeFile(config.review,JSON.stringify({reviews:[{bundleId:"B1",summary:"Independent suggestions",verdict:"needs-work",basedOn,findings}]}));
  await writeFile(config.canon,original.replace("적갈","초록"));
  await writeFile(path.join(profile,"blog-projects.json"),JSON.stringify({version:1,projects:[{id:"example",title:"Example project",config}]}));
  app=await launchApp(profile);const main=await app.firstWindow();
  await main.getByRole("button",{name:"블로그",exact:true}).click();
  const opened=app.waitForEvent("window");await main.getByRole("button",{name:"프로젝트 열기",exact:true}).click();
  const editor=await opened;
  await editor.setViewportSize({width:960,height:720});
  const frame=editor.frameLocator('iframe[title="정본 본문 편집"]');
  await expect(editor.getByText("✓ 저장 완료",{exact:true})).toBeVisible();
  await openReview(editor);
  await expect(editor.locator(".ce-proposal")).toHaveCount(3);
  await closeReview(editor);
  // Proposals are applied from the in-text diff/marker popover in P2; each apply re-validates the rest.
  const ids=["checks","color1","color2"],inline=(id:string)=>frame.locator(`[data-review-ui="ins"][data-pid="${id}"],[data-review-ui="marker"][data-pid="${id}"]`);
  const hint=frame.locator('[data-review-ui="hint"]'),apply=hint.getByRole("button",{name:"적용",exact:true});
  // A dispatched click opens the popover even when another proposal's popover covers the target.
  const activate=async(id:string)=>{await inline(id).first().dispatchEvent("click");await expect(hint).toHaveAttribute("data-pid",id);};
  for(const id of ids){await activate(id);await expect(apply).toBeEnabled();}
  for(let i=0;i<3;i++){
    await activate(ids[i]);
    await apply.click();
    await expect(inline(ids[i])).toHaveCount(0);
    if(i<2){await activate(ids[i+1]);await expect(apply).toBeEnabled();}
  }
  await expect(frame.locator('[data-tid="P2"]')).toHaveText("✅ Second line");
  await editor.getByRole("button",{name:"정본 저장",exact:true}).click();
  await expect.poll(async()=>await readFile(config.canon,"utf8")).toContain("✅");
  await expect(editor.getByText("정본과 미리보기를 저장했어요. 저장 전 사본도 보관했어요.",{exact:true})).toBeVisible();
  await editor.reload();
  await expect(editor.getByText("✓ 저장 완료",{exact:true})).toBeVisible();
  await expect(frame.locator('[data-tid="P2"]')).toHaveText("✅ Second line");
  await expect(frame.locator('[data-review-ui="ins"],[data-review-ui="marker"],[data-review-ui="hint"]')).toHaveCount(0);
  expect(await frame.locator('[data-tid="P2"]').innerHTML()).not.toMatch(/rv-|data-review-ui/);
  await openReview(editor);
  for(let i=0;i<3;i++){
    await expect(editor.locator(".ce-proposal").nth(i)).toHaveAttribute("data-state","applied");
    await expect(editor.locator(".ce-proposal").nth(i)).toContainText("반영됨");
  }
  const saved=parse(await readFile(config.canon,"utf8"));
  const p=paragraphNodes(saved).find(p=>p.id==="P2")!;
  expect(p.marks.map(m=>m.style.color)).toEqual(["#85613f","#0096dc"]);
  await editor.screenshot({path:testInfo.outputPath("independent-proposals.png"),fullPage:true});
 }finally{await closeApp(app);await cleanProfile(profile);}
});

test("explicit live visual review consumes rendered evidence and never edits manuscript",async({},testInfo)=>{
 test.skip(!process.env.REELS_LIVE_VISUAL_BUNDLE||!process.env.REELS_MARKUP_CONFIG,"Explicit live review opt-in");
 test.setTimeout(360000);
 const profile=await makeProfile();let app;
 const config=JSON.parse(await readFile(process.env.REELS_MARKUP_CONFIG!,"utf8"));
 const original=await readFile(config.canon,"utf8"),doc=parse(original),id=process.env.REELS_LIVE_VISUAL_BUNDLE!;
 try{
  await writeFile(path.join(profile,"blog-projects.json"),JSON.stringify({version:1,projects:[{id:"example",title:"Example project",config}]}));
  app=await launchApp(profile);
  const main=await app.firstWindow();await main.getByRole("button",{name:"블로그",exact:true}).click();
  const opened=app.waitForEvent("window");await main.getByRole("button",{name:"프로젝트 열기",exact:true}).click();
  const editor=await opened;
  await expect(editor.getByText("✓ 저장 완료",{exact:true})).toBeVisible();
  await editor.getByRole("navigation",{name:"정본 묶음"}).getByRole("button").nth(doc.bundles.findIndex(b=>b.id===id)).click();
  const requestedAt=Date.now();
  await editor.getByRole("button",{name:"이 묶음 검토",exact:true}).click();
  await expect.poll(async()=>{
    const data=await (await editor.request.get(new URL("/api/blog/review-status",editor.url()).href)).json();
    const job=data.requests.find((r:any)=>r.bundleIds.includes(id)&&Date.parse(r.updatedAt??"")>=requestedAt);
    if(job?.status==="failed")throw new Error(job.error);
    return job?.status;
  },{timeout:300000,intervals:[1000,2000,4000]}).toBe("completed");
  const data=await (await editor.request.get(new URL("/api/blog/document",editor.url()).href)).json();
  const review=data.reviews.find((r:any)=>r.bundleId===id);
  expect(review.visual.status).not.toBe("unverified");expect(review.visualFresh).toBe(true);expect(review.screenshots).toHaveLength(3);
  await editor.screenshot({path:testInfo.outputPath("live-visual-review.png"),fullPage:true});
  expect(await readFile(config.canon,"utf8")).toBe(original);
  console.log(JSON.stringify({requestId:review.requestId,visual:review.visual,decisions:review.emphasisDecisions.length,findings:review.findings.length}));
 }finally{await closeApp(app);await cleanProfile(profile);}
});
