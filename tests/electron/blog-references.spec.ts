import { test, expect } from "@playwright/test";
import { launchApp, makeProfile, closeApp, cleanProfile } from "./helpers";
test("blog reference import selects child anchors, keeps location for unanchored groups and retains across sub-tabs", async ({}, testInfo) => {
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile);
    const page = await app.firstWindow();
    await page.route("https://blog.naver.com/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<div style="height:1500px">top</div><div id="child-group">selected group</div><div style="height:1000px"></div>',
      }),
    );
    await page.getByRole("button", { name: "블로그", exact: true }).click();
    await page
      .getByRole("tab", { name: "레퍼런스 추출·탐색", exact: true })
      .click();
    await page.getByText("구조 파일 직접 가져오기", { exact: true }).click();
    const rect = { x: 0, y: 1000, width: 600, height: 200 };
    const block = {
      order: 0,
      id: "",
      anchorId: "child-group",
      className: "se-imageGroup",
      rect,
      css: {},
      paragraphs: [],
      images: [],
    };
    const refs = [
      {
        name: "구조 확인용",
        url: "https://blog.naver.com/fixture/1",
        pageUrl: "https://blog.naver.com/PostView.naver?blogId=fixture&logNo=1",
        width: 600,
        blocks: [block, { ...block, order: 1, anchorId: null }],
      },
    ];
    await page
      .getByLabel("레퍼런스 구조 파일")
      .setInputFiles({
        name: "reference.md",
        mimeType: "text/markdown",
        buffer: Buffer.from("```json\n" + JSON.stringify(refs) + "\n```"),
      });
    await page
      .getByRole("button", { name: "원본 페이지 보기", exact: true })
      .click();
    await page
      .getByRole("button", { name: "#1 이미지 그룹", exact: false })
      .click();
    const frame = page.locator('iframe[title="레퍼런스 원본"]');
    await expect(frame).toHaveAttribute("src", /\#child-group$/);
    await expect(
      page
        .frameLocator('iframe[title="레퍼런스 원본"]')
        .locator("#child-group"),
    ).toBeInViewport();
    await page
      .getByRole("button", { name: "#2 이미지 그룹", exact: false })
      .click();
    await expect(frame).toHaveAttribute("src", /\#child-group$/);
    await expect(
      page.getByText("이 블록에는 이동 앵커가 없어 원본 위치를 유지해요."),
    ).toBeVisible();
    await page.getByRole("tab", { name: "원고·배치", exact: true }).click();
    await page
      .getByRole("tab", { name: "레퍼런스 추출·탐색", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "구조 확인용", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "구조 도식 보기", exact: true })
      .click();
    await page
      .locator(".blog-references")
      .screenshot({ path: testInfo.outputPath("references.png") });
  } finally {
    if (app) await closeApp(app);
    await cleanProfile(profile);
  }
});

test("saved analysis folder opens structure and preview and remains after restart", async ({}, testInfo) => {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const profile = await makeProfile();
  const dir = join(profile, "extracted");
  await mkdir(dir);
  const rect = { x: 0, y: 0, width: 600, height: 100 };
  const refs = [
    {
      name: "저장된 분석 결과",
      url: "https://blog.naver.com/fixture/1",
      pageUrl: "https://blog.naver.com/fixture/1",
      width: 600,
      blocks: [
        {
          order: 0,
          id: "b",
          className: "se-text",
          rect,
          css: {},
          paragraphs: [],
          images: [],
        },
      ],
    },
  ];
  await writeFile(join(dir, "reference-structures.json"), JSON.stringify(refs));
  await writeFile(join(dir, "index.html"), "<h1>기존 템플릿 미리보기</h1>");
  let app;
  try {
    app = await launchApp(profile);
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, dir);
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "블로그", exact: true }).click();
    await page
      .getByRole("tab", { name: "레퍼런스 추출·탐색", exact: true })
      .click();
    await page
      .getByRole("button", { name: "분석 결과 폴더 연결", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "저장된 분석 결과 · 1개 블록",
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByLabel("원본 블록 목록")).toBeVisible();
    await page
      .getByRole("button", { name: "템플릿 미리보기 열기", exact: true })
      .click();
    await expect(
      page
        .frameLocator('iframe[title="저장된 블로그 템플릿 미리보기"]')
        .getByRole("heading", { name: "기존 템플릿 미리보기" }),
    ).toBeVisible();
    await closeApp(app);
    app = await launchApp(profile);
    page = await app.firstWindow();
    await page.getByRole("button", { name: "블로그", exact: true }).click();
    await page
      .getByRole("tab", { name: "레퍼런스 추출·탐색", exact: true })
      .click();
    await page
      .getByRole("button", { name: "저장된 분석 결과 · 1개 블록", exact: true })
      .click();
    await expect(page.getByLabel("원본 블록 목록")).toBeVisible();
    await page
      .locator(".blog-references")
      .screenshot({ path: testInfo.outputPath("saved-results.png") });
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});

test("preview opens in view below a long list, switches targets and returns focus on close",async()=>{
 const {mkdir,writeFile,realpath}=await import("node:fs/promises");
 const {join}=await import("node:path");
 const profile=await makeProfile();let app;
 try{
  const entries=[];
  for(let i=0;i<8;i++){
   const dir=join(profile,"preview-"+i);await mkdir(dir);
   await writeFile(join(dir,"reference-structures.json"),JSON.stringify([{name:"Reference "+i,url:"https://blog.naver.com/fixture/"+i,pageUrl:"https://blog.naver.com/fixture/"+i,width:600,blocks:[{order:0,id:"b",anchorId:"b",className:"se-text",rect:{x:0,y:0,width:600,height:200},css:{},paragraphs:[],images:[]}]}]));
   await writeFile(join(dir,"index.html"),"<h1>Preview "+i+"</h1>");
   entries.push({id:"preview-"+i,directory:await realpath(dir)});
  }
  await writeFile(join(profile,"blog-results.json"),JSON.stringify(entries));
  app=await launchApp(profile);const page=await app.firstWindow();
  await page.setViewportSize({width:1100,height:800});
  await page.getByRole("button",{name:"블로그",exact:true}).click();
  await page.getByRole("tab",{name:"레퍼런스 추출·탐색",exact:true}).click();
  const buttons=page.getByRole("button",{name:"템플릿 미리보기 열기",exact:true});
  await expect(buttons).toHaveCount(8);
  const panel=page.getByRole("region",{name:"템플릿 미리보기",exact:true});
  for(const index of [0,7,0,0]){
   // Verify keyboard activation too, including repeated opens of a cached preview URL.
   await buttons.nth(index).focus();
   await buttons.nth(index).press("Enter");
   await expect(panel.getByRole("heading",{name:"Reference "+index+" · 미리보기",exact:true})).toBeInViewport();
   await expect(panel).toBeFocused();
   await expect(page.frameLocator('iframe[title="저장된 블로그 템플릿 미리보기"]').getByRole("heading",{name:"Preview "+index,exact:true})).toBeVisible();
  }
  await page.getByRole("button",{name:"미리보기 닫기",exact:true}).click();
  await expect(panel).toHaveCount(0);
  await expect(buttons.nth(0)).toBeFocused();
  await expect(buttons.nth(0)).toBeInViewport();
 }finally{await closeApp(app);await cleanProfile(profile);}
});

test("provided reference previews restore actual saved templates",async({},testInfo)=>{
 test.skip(!process.env.REELS_REFERENCE_PREVIEW_DIRS,"Explicit local reference folders only");
 const {readFile,writeFile,realpath}=await import("node:fs/promises");
 const {join}=await import("node:path");
 const {createHash}=await import("node:crypto");
 const dirs: string[]=JSON.parse(process.env.REELS_REFERENCE_PREVIEW_DIRS!);
 const profile=await makeProfile();let app;
 try{
  const entries=await Promise.all(dirs.map(async dir=>({id:createHash("sha256").update(dir).digest("hex"),directory:await realpath(dir)})));
  await writeFile(join(profile,"blog-results.json"),JSON.stringify(entries));
  app=await launchApp(profile);const page=await app.firstWindow();
  await page.getByRole("button",{name:"블로그",exact:true}).click();
  await page.getByRole("tab",{name:"레퍼런스 추출·탐색",exact:true}).click();
  const report=[];
  for(let i=0;i<dirs.length;i++){
   const templates=JSON.parse(await readFile(join(dirs[i],"reference-templates.json"),"utf8"));
   await page.getByRole("button",{name:"템플릿 미리보기 열기",exact:true}).nth(i).click();
   await expect(page.getByRole("region",{name:"템플릿 미리보기",exact:true}).getByRole("heading")).toBeInViewport();
   const frame=page.frameLocator('iframe[title="저장된 블로그 템플릿 미리보기"]');
   await expect(frame.locator("[data-restore-surface]")).toBeVisible();
   await expect(frame.locator("[data-restore-block]")).toHaveCount(templates[0].blocks.length);
   await expect(frame.getByRole("alert")).toHaveCount(0);
   report.push({name:templates[0].name,blocks:templates[0].blocks.length,visible:true});
   await page.screenshot({path:testInfo.outputPath("reference-preview-"+i+".png")});
  }
  console.log(JSON.stringify(report));
 }finally{await closeApp(app);await cleanProfile(profile);}
});
