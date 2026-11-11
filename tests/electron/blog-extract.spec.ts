import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { resolve } from "node:path";
import { launchApp, makeProfile, closeApp, cleanProfile } from "./helpers";

// Synthetic SmartEditor ONE post. All https traffic of the extractor/verify sessions is answered
// in-process; nothing reaches Naver. Set REELS_BLOG_LIVE_URL to additionally run a real post.
const POST = "https://blog.naver.com/fixture/1234567";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const post = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;font:16px/1.8 sans-serif}.se-main-container{width:600px;margin:0 auto}
.se-text-paragraph{margin:0;text-align:center}.se-quotation-container{border-left:4px solid #555;padding:8px 16px}
.se-imageGroup-container{display:flex;gap:4px}.se-imageGroup-item img{display:block;width:298px;height:200px;object-fit:cover}
.se-image img{display:block;width:600px;height:400px}.map{height:300px;background:#eee}
</style><div class="se-main-container">
<div class="se-component se-text se-l-default" id="SE-text"><div class="se-module se-module-text">
<p class="se-text-paragraph"><span class="se-fs-fs19"><b>판교 야장 후기!</b></span></p>
<p class="se-text-paragraph"><span>​</span></p>
<p class="se-text-paragraph"><span>예약하고 갔는데 </span><span style="color:#a64132">2시간 정도</span><span> 기다렸어요.</span></p>
</div></div>
<div class="ssp-adcontent align_center"><div style="height:120px">ad</div></div>
<div class="se-component se-quotation se-l-quotation_line" id="SE-quote"><blockquote class="se-quotation-container"><div class="se-module se-module-text"><p class="se-text-paragraph"><b>알고 가면 좋은 정보</b></p></div></blockquote></div>
<div class="se-component se-imageGroup se-l-collage"><div class="se-imageGroup-container">
<div class="se-imageGroup-item" id="SE-group-child"><a data-linkdata='{"originalWidth":1200,"originalHeight":800}'><img src="https://postfiles.pstatic.net/fixture/a.png?type=w966"></a></div>
<div class="se-imageGroup-item"><a data-linkdata='{"originalWidth":800,"originalHeight":1200}'><img src="https://postfiles.pstatic.net/fixture/b.png?type=w966"></a></div>
</div></div>
<div class="se-component se-image se-l-default" id="SE-image"><img src="https://postfiles.pstatic.net/fixture/c.png?type=w966"></div>
<div class="se-component se-placesMap se-l-default" id="SE-map"><div class="map"><p class="se-text-paragraph">달맞이광장</p></div></div>
</div>`;
const outer = `<!doctype html><meta charset="utf-8"><title>fixture</title><iframe id="mainFrame" src="/PostView.naver?blogId=fixture&logNo=1234567&redirect=Dlog"></iframe>`;
const mobile = ["se-documentTitle", "se-text se-l-default", "se-quotation se-l-quotation_line", "se-imageGroup se-l-collage", "se-image se-l-default", "se-placesMap se-l-default"].map((c) => `<div class="se-component ${c}"></div>`).join("");

test("URL extraction in the Blog tab writes, registers, renders and verifies a restoration", async ({}, testInfo) => {
  test.setTimeout(120_000);
  const profile = await makeProfile();
  const parent = await mkdtemp(join(tmpdir(), "reels-blog-extract-"));
  let app;
  try {
    await writeFile(join(profile, "blog-extract.json"), JSON.stringify({ parent }));
    app = await launchApp(profile);
    await app.evaluate(({ session }, fixture) => {
      for (const partition of ["blog-extract", "blog-restore-verify"]) {
        session.fromPartition(partition).protocol.handle("https", async (request) => {
          const u = new URL(request.url);
          const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
          if (u.hostname === "blog.naver.com" && u.pathname === "/fixture/1234567") return html(fixture.outer);
          if (u.hostname === "blog.naver.com" && u.pathname === "/PostView.naver") return html(fixture.post);
          if (u.hostname === "m.blog.naver.com") return html(fixture.mobile);
          if (u.hostname === "postfiles.pstatic.net") return new Response(Buffer.from(fixture.png, "base64"), { headers: { "content-type": "image/png" } });
          return new Response("", { status: 404 });
        });
      }
    }, { outer, post, mobile, png: PNG });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "블로그", exact: true }).click();
    await page.getByRole("tab", { name: "레퍼런스 추출·탐색", exact: true }).click();
    await expect(page.getByText(`저장 위치: ${parent}`)).toBeVisible();
    await page.getByLabel("글 주소").fill(POST);
    await page.getByLabel("표시 이름").fill("합성 글");
    await page.getByRole("button", { name: "추출", exact: true }).click();
    const result = page.locator(".blog-extract-result");
    await expect(result).toContainText("6개 블록 저장", { timeout: 60_000 });
    await expect(result).toContainText("모바일 교차검증 일치");
    await expect(result).toContainText("복원 높이 ±5% 4/4");

    const dir = join(parent, "fixture-1234567");
    const files = await readdir(dir);
    for (const f of ["reference-structures.json", "reference-structures.md", "reference-templates.json", "reference-templates.md", "restore-report.json", "restore-viewer.js", "restore-viewer.css", "index.html", "README.md"]) expect(files).toContain(f);
    expect(files.some((f) => /\.(png|jpe?g|webp)$/i.test(f))).toBe(false);
    const [template] = JSON.parse(await readFile(join(dir, "reference-templates.json"), "utf8"));
    const texts: string[] = [], srcs: string[] = [];
    const walk = (n: any) => { if (n.type === "text-slot" && n.text) texts.push(n.text); if (n.type === "image-slot") srcs.push(n.src); (n.children ?? []).forEach(walk); };
    template.blocks.forEach((b: any) => walk(b.tree));
    expect(texts).toContain("2시간 정도");
    expect(texts.join("")).not.toContain("​");
    expect(srcs).toEqual(["https://postfiles.pstatic.net/fixture/a.png?type=w966", "https://postfiles.pstatic.net/fixture/b.png?type=w966", "https://postfiles.pstatic.net/fixture/c.png?type=w966"]);
    expect(template.blocks[3].sourceAnchor).toBe("SE-group-child");
    const report = JSON.parse(await readFile(join(dir, "restore-report.json"), "utf8")).entries[0];
    expect(report.fidelity.images).toEqual({ total: 3, loaded: 3 });
    expect(report.fidelity.summary.excluded.map((x: any) => x.kind)).toEqual(["Ad", "Map"]);

    // Registered in the saved results list and opened in the structure explorer.
    await expect(page.getByRole("button", { name: /합성 글 · 6개 블록/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /#4 이미지 그룹/ })).toBeVisible();
    // Structure explorer shows the extracted original text with its measured run color.
    await expect(page.locator(".blog-reference-run-text", { hasText: "판교 야장 후기!" })).toBeVisible();
    await page.getByRole("button", { name: /#1 텍스트/ }).click();
    await expect(page.locator(".blog-reference-run-text", { hasText: "2시간 정도" })).toHaveCSS("color", "rgb(166, 65, 50)");
    await page.getByRole("button", { name: "템플릿 미리보기 열기" }).click();
    const viewer = page.frameLocator("iframe.blog-result-preview");
    await expect(viewer.getByText("판교 야장 후기!")).toBeVisible();
    await expect(viewer.getByTestId("fidelity-summary")).toContainText("4/4");
    await expect(viewer.locator('.restore-index')).not.toHaveAttribute('open', '');
    await viewer.locator('.restore-index summary').click();
    await expect(viewer.locator('.restore-table')).toBeVisible();
    await viewer.locator('.restore-table tbody tr').nth(2).click();
    await expect(viewer.locator('[data-restore-block="2"]')).toHaveClass('restore-selected');
    await viewer.locator('.restore-index summary').click();
    for (const width of [1280, 900, 600]) {
      await page.locator('iframe.blog-result-preview').evaluate((el, width) => { el.style.width = `${width}px`; }, width);
      const layout = await viewer.locator('.restore-canvas').evaluate(el => ({
        width: el.getBoundingClientRect().width,
        viewport: document.documentElement.clientWidth,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
      }));
      expect(layout.overflow).toBe(false);
      expect(layout.width).toBeGreaterThan(layout.viewport - 40);
    }
    await page.locator('iframe.blog-result-preview').evaluate(el => { el.style.width = '100%'; });
    await page.locator(".blog-references").screenshot({ path: testInfo.outputPath("blog-extract.png") });

    // Same URL again replaces the entry instead of appending.
    await page.getByRole("button", { name: "추출", exact: true }).click();
    await expect(result).toContainText("6개 블록 저장", { timeout: 60_000 });
    expect(JSON.parse(await readFile(join(dir, "reference-templates.json"), "utf8"))).toHaveLength(1);
  } finally {
    if (app) await closeApp(app);
    await cleanProfile(profile);
    await rm(parent, { recursive: true, force: true });
  }
});

test("extraction failure on a non-SmartEditor page writes nothing", async () => {
  test.setTimeout(90_000);
  const profile = await makeProfile();
  const parent = await mkdtemp(join(tmpdir(), "reels-blog-extract-"));
  let app;
  try {
    await writeFile(join(profile, "blog-extract.json"), JSON.stringify({ parent }));
    app = await launchApp(profile);
    await app.evaluate(({ session }) => {
      session.fromPartition("blog-extract").protocol.handle("https", async (request) =>
        new URL(request.url).pathname === "/fixture/7654321"
          ? new Response('<iframe id="mainFrame" src="/PostView.naver?blogId=fixture&logNo=7654321"></iframe>', { headers: { "content-type": "text/html" } })
          : new Response("<p>삭제된 글입니다</p>", { headers: { "content-type": "text/html" } }),
      );
    });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "블로그", exact: true }).click();
    await page.getByRole("tab", { name: "레퍼런스 추출·탐색", exact: true }).click();
    await page.getByLabel("글 주소").fill("https://blog.naver.com/fixture/7654321");
    await page.getByRole("button", { name: "추출", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("se-main-container를 찾지 못했어요", { timeout: 60_000 });
    expect(await readdir(parent)).toEqual([]);
  } finally {
    if (app) await closeApp(app);
    await cleanProfile(profile);
    await rm(parent, { recursive: true, force: true });
  }
});

test("agents run the same extraction through the Dashboard MCP", async () => {
  test.setTimeout(120_000);
  const profile = await makeProfile();
  const parent = await mkdtemp(join(tmpdir(), "reels-blog-mcp-"));
  let app, client: Client | undefined;
  try {
    app = await launchApp(profile, false);
    const page = await app.firstWindow();
    // Keep the Blog tab open: MCP changes must appear without pressing refresh.
    await page.getByRole("button", { name: "블로그", exact: true }).click();
    await page.getByRole("tab", { name: "레퍼런스 추출·탐색", exact: true }).click();
    await app.evaluate(({ session }, fixture) => {
      for (const partition of ["blog-extract", "blog-restore-verify"]) {
        session.fromPartition(partition).protocol.handle("https", async (request) => {
          const u = new URL(request.url);
          const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
          if (u.hostname === "blog.naver.com" && u.pathname === "/fixture/1234567") return html(fixture.outer);
          if (u.hostname === "blog.naver.com" && u.pathname === "/PostView.naver") return html(fixture.post);
          if (u.hostname === "m.blog.naver.com") return html(fixture.mobile);
          if (u.hostname === "postfiles.pstatic.net") return new Response(Buffer.from(fixture.png, "base64"), { headers: { "content-type": "image/png" } });
          return new Response("", { status: 404 });
        });
      }
    }, { outer, post, mobile, png: PNG });
    client = new Client({ name: "reels-blog-extract-qa", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve("dist-mcp/server.mjs")], env: { ...(process.env as Record<string, string>), REELS_USER_DATA: profile } }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(["reels_extract_blog_reference", "reels_list_blog_references", "reels_link_blog_reference", "reels_unlink_blog_reference"]));
    const missing = await client.callTool({ name: "reels_extract_blog_reference", arguments: { url: POST } }, { timeout: 60_000 });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("outputDirectory");
    const done = await client.callTool({ name: "reels_extract_blog_reference", arguments: { url: POST, outputDirectory: parent, name: "MCP 합성 글" } }, { timeout: 90_000 });
    expect(done.isError, JSON.stringify(done.content)).not.toBe(true);
    const result = done.structuredContent as any;
    expect(result).toMatchObject({ directory: join(await realpath(parent), "fixture-1234567"), blocks: 6, name: "MCP 합성 글" });
    expect(result.fidelity.within5pct).toBe(4);
    const listed = await client.callTool({ name: "reels_list_blog_references", arguments: {} });
    expect(JSON.stringify(listed.structuredContent)).toContain("MCP 합성 글");
    const entry = page.getByRole("button", { name: /MCP 합성 글 · 6개 블록/ });
    await expect(entry).toBeVisible();
    const unlinked = await client.callTool({ name: "reels_unlink_blog_reference", arguments: { id: result.resultId } });
    expect(unlinked.isError, JSON.stringify(unlinked.content)).not.toBe(true);
    await expect(entry).toHaveCount(0);
    const linked = await client.callTool({ name: "reels_link_blog_reference", arguments: { directory: result.directory } });
    expect(linked.isError, JSON.stringify(linked.content)).not.toBe(true);
    await expect(entry).toBeVisible();
    // A moved folder shows an actionable error and can be unlinked from the UI.
    await rm(result.directory, { recursive: true, force: true });
    await page.getByRole("button", { name: "결과 목록 새로고침" }).click();
    await expect(page.getByText("폴더를 옮겼다면 연결을 해제하고")).toBeVisible();
    await page.getByRole("button", { name: "연결 해제" }).click();
    await expect(page.getByText("폴더를 옮겼다면 연결을 해제하고")).toHaveCount(0);
  } finally {
    await client?.close();
    if (app) await closeApp(app);
    await cleanProfile(profile);
    await rm(parent, { recursive: true, force: true });
  }
});

const live = process.env.REELS_BLOG_LIVE_URL;
test("live Naver post extraction (opt-in)", async ({}, testInfo) => {
  test.skip(!live, "set REELS_BLOG_LIVE_URL to run against a real post");
  test.setTimeout(180_000);
  const profile = await makeProfile();
  const parent = process.env.REELS_BLOG_LIVE_OUT ?? (await mkdtemp(join(tmpdir(), "reels-blog-live-")));
  let app;
  try {
    await writeFile(join(profile, "blog-extract.json"), JSON.stringify({ parent }));
    app = await launchApp(profile);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "블로그", exact: true }).click();
    await page.getByRole("tab", { name: "레퍼런스 추출·탐색", exact: true }).click();
    await page.getByLabel("글 주소").fill(live!);
    if (process.env.REELS_BLOG_LIVE_NAME) await page.getByLabel("표시 이름").fill(process.env.REELS_BLOG_LIVE_NAME);
    await page.getByRole("button", { name: "추출", exact: true }).click();
    await expect(page.locator(".blog-extract-result")).toContainText("개 블록 저장", { timeout: 150_000 });
    await testInfo.attach("result", { body: await page.locator(".blog-extract-result").innerText(), contentType: "text/plain" });
  } finally {
    if (app) await closeApp(app);
    await cleanProfile(profile);
  }
});
