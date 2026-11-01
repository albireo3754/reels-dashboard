import {parse} from "../../src/shared/blog-markup";
import {paragraphNodes} from "../../src/shared/blog-markup-source";
import {test,expect} from "@playwright/test";
import {readFile,writeFile} from "node:fs/promises";
import path from "node:path";
import {launchApp,makeProfile,closeApp,cleanProfile} from "./helpers";
import {markupFixture} from "../fixtures/markup-editor";

test("desktop opens markup editor, saves text, reopens and preserves source grammar",async({},testInfo)=>{
  const profile=await makeProfile();let app;
  try{
    const config=await markupFixture(profile);
    await writeFile(path.join(profile,"canonical-blog.json"),JSON.stringify(config));
    app=await launchApp(profile);
    const main=await app.firstWindow();
    await main.getByRole("button",{name:"블로그",exact:true}).click();
    const opened=app.waitForEvent("window");
    await main.getByRole("button",{name:"정본 스마트 에디터 열기",exact:true}).click();
    const editor=await opened,errors:string[]=[];
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
    await editor.getByRole("button",{name:"정본 저장",exact:true}).click();
    await expect.poll(async()=>await readFile(config.canon,"utf8")).toContain("노랑배경");
    const annotations=JSON.parse(await readFile(config.canon+".annotations.json","utf8"));
    expect(annotations[0].note).toBe("Disclosure should stand out");expect(annotations[0].checked).toBe(true);
    expect(await readFile(config.canon,"utf8")).not.toContain("Disclosure should stand out");
    await editor.screenshot({path:testInfo.outputPath("markup-editor.png"),fullPage:true});
    expect(errors).toEqual([]);
    await editor.close();
    const reopened=app.waitForEvent("window");
    await main.getByRole("button",{name:"정본 스마트 에디터 열기",exact:true}).click();
    const again=await reopened;
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
    await writeFile(path.join(profile,"canonical-blog.json"),JSON.stringify(config));
    app=await launchApp(profile);
    const main=await app.firstWindow();
    await main.getByRole("button",{name:"블로그",exact:true}).click();
    const opened=app.waitForEvent("window");
    await main.getByRole("button",{name:"정본 스마트 에디터 열기",exact:true}).click();
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
        await expect(editor.getByText("검토 완료",{exact:true})).toBeVisible();
        await expect(editor.locator(".ce-proposal")).toHaveCount(latest.findings.filter((f:any)=>!["withdrawn","rejected","obsolete"].includes(f.status)).length);
        const data=await (await editor.request.get(new URL("/api/blog/document",editor.url()).href)).json();
        const {findingApplicability}=await import("../../src/shared/review-applicability");
        const current=data.reviews.find((r:any)=>r.bundleId===latest.bundleId).findings.filter((f:any)=>!["withdrawn","rejected","obsolete"].includes(f.status));
        for(let i=0;i<current.length;i++){
          const f=current[i],id=f.proposal?.tid??f.proposal?.entry?.id;
          const expected=findingApplicability(f,data.paragraphs.find((p:any)=>p.id===id)?.source).canApply;
          if(expected)await expect(editor.locator(".ce-proposal").nth(i).getByRole("button",{name:"적용",exact:true})).toBeEnabled();
          else await expect(editor.locator(".ce-proposal").nth(i).getByRole("button",{name:"적용",exact:true})).toBeDisabled();
        }

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
    await writeFile(path.join(profile,"canonical-blog.json"),JSON.stringify(config));
    server=await startWorkflowServer({root:path.join(profile,"workflow"),port:0,sdkEnv:{},sdkFactory:()=>({
      startThread:()=>({async runStreamed(prompt){
        const input=JSON.parse(prompt.split("\nInput: ")[1].split("\nReturn resultJson")[0]);
        return {events:(async function*(){
          yield {type:"item.completed" as const,item:{id:"answer",type:"agent_message" as const,text:JSON.stringify({resultJson:JSON.stringify({requestId:input.id,reviews:[{bundleId:"B1",verdict:"passed",summary:"Fresh review from running engine",findings:[]}]})})}};
          yield {type:"turn.completed" as const,usage:{input_tokens:10,output_tokens:10,cached_input_tokens:0,cache_write_input_tokens:0,reasoning_output_tokens:0}};
        })()};
      }})
    })});
    app=await launchApp(profile,true,{REELS_WORKFLOW_URL:server.url});
    const main=await app.firstWindow();
    await main.getByRole("button",{name:"블로그",exact:true}).click();
    const opened=app.waitForEvent("window");
    await main.getByRole("button",{name:"정본 스마트 에디터 열기",exact:true}).click();
    const editor=await opened;
    await expect(editor.getByText("✓ 저장 완료",{exact:true})).toBeVisible();
    await editor.getByRole("button",{name:"이 묶음 검토",exact:true}).click();
    await expect(editor.getByText("검토 완료",{exact:true})).toBeVisible({timeout:15000});
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
  await writeFile(path.join(profile,"canonical-blog.json"),JSON.stringify(config));
  app=await launchApp(profile);const main=await app.firstWindow();
  await main.getByRole("button",{name:"블로그",exact:true}).click();
  const opened=app.waitForEvent("window");await main.getByRole("button",{name:"정본 스마트 에디터 열기",exact:true}).click();
  const editor=await opened,frame=editor.frameLocator('iframe[title="정본 본문 편집"]');
  const cards=editor.locator(".ce-proposal");
  await expect(cards).toHaveCount(3);
  for(let i=0;i<3;i++)await expect(cards.nth(i).getByRole("button",{name:"적용",exact:true})).toBeEnabled();
  for(let i=0;i<3;i++){
    await cards.nth(i).getByRole("button",{name:"적용",exact:true}).click();
    if(i<2)await expect(cards.nth(i+1).getByRole("button",{name:"적용",exact:true})).toBeEnabled();
  }
  await expect(frame.locator('[data-tid="P2"]')).toHaveText("✅ Second line");
  await editor.getByRole("button",{name:"정본 저장",exact:true}).click();
  await expect.poll(async()=>await readFile(config.canon,"utf8")).toContain("✅");
  await expect(editor.getByText("정본과 미리보기를 저장했어요. 저장 전 사본도 보관했어요.",{exact:true})).toBeVisible();
  await editor.reload();
  await expect(editor.locator(".ce-proposal").nth(0)).toContainText("이미 본문에 반영");
  await expect(editor.locator(".ce-proposal").nth(1)).toContainText("이미 같은 서식");
  const saved=parse(await readFile(config.canon,"utf8"));
  const p=paragraphNodes(saved).find(p=>p.id==="P2")!;
  expect(p.marks.map(m=>m.style.color)).toEqual(["#85613f","#0096dc"]);
  await editor.screenshot({path:testInfo.outputPath("independent-proposals.png"),fullPage:true});
 }finally{await closeApp(app);await cleanProfile(profile);}
});
