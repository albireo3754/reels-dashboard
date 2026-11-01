// In-app Naver reference extraction: URL → isolated hidden window → structure/template/report files
// → registered blog result → restore-viewer render check. Shared by the Blog tab and the MCP tool.
import { BrowserWindow, session as electronSession, type Session } from "electron";
import { copyFile, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type { LocalStore } from "../shared/lib/storage";
import type { BlogResult } from "../shared/blog";
import {
  blogExtractInput,
  checkCapture,
  countKinds,
  fidelity,
  fontFaces,
  mobileCheck,
  parsePostUrl,
  toMarkdown,
  upsertBy,
  type BlogExtractProgress,
  type BlogExtractResult,
  type MobileCheck,
  type PageCapture,
} from "../shared/blog-restore";
import { extractPost, loadImages, measureRestore, pageScript } from "./blog-extract-page";

const VIEWPORT = { width: 1280, height: 1000 };
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const settings = z.strictObject({ parent: z.string().startsWith("/").max(4096).optional() });

export interface BlogExtractorDeps {
  store: LocalStore;
  /** Folder holding restore-viewer.js/.css built by scripts/build-desktop.mjs. */
  viewerAssets: string;
  register(directory: string): Promise<BlogResult>;
  preview(id: string): Promise<string>;
  progress(event: BlogExtractProgress): void;
}

export class BlogExtractor {
  busy = false;
  private configured = new WeakSet<Session>();
  constructor(private deps: BlogExtractorDeps) {}

  private get settingsFile() {
    return path.join(this.deps.store.root, "blog-extract.json");
  }
  async defaultParent(): Promise<string | null> {
    try {
      return settings.parse(JSON.parse(await readFile(this.settingsFile, "utf8"))).parent ?? null;
    } catch {
      return null;
    }
  }
  async setDefaultParent(directory: string) {
    const resolved = await realpath(z.string().startsWith("/").max(4096).parse(directory));
    if (!(await stat(resolved)).isDirectory()) throw new Error("폴더를 선택해주세요.");
    await this.deps.store.atomic(this.settingsFile, settings.parse({ parent: resolved }));
    return resolved;
  }

  /** In-memory partition: no cookies or storage shared with the app or between runs of the app. */
  private session(partition: string) {
    const s = electronSession.fromPartition(partition);
    if (!this.configured.has(s)) {
      s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
      s.setPermissionCheckHandler(() => false);
      s.on("will-download", (event) => event.preventDefault());
      this.configured.add(s);
    }
    return s;
  }
  private window(s: Session, size: { width: number; height: number }, allowed: (url: URL) => boolean) {
    const win = new BrowserWindow({
      show: false,
      useContentSize: true,
      ...size,
      paintWhenInitiallyHidden: true,
      webPreferences: { session: s, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, webSecurity: true },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      try {
        if (!allowed(new URL(url))) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
    win.webContents.setAudioMuted(true);
    return win;
  }
  private async waitFor(win: BrowserWindow, expression: string, timeout: number) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (win.isDestroyed()) throw new Error("추출 창이 닫혔어요.");
      if (await win.webContents.executeJavaScript(expression).catch(() => false)) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }
  private load(win: BrowserWindow, url: string) {
    // Do not await full load: ad/analytics requests can keep the load event pending.
    void win.loadURL(url).catch(() => {});
  }

  async extract(rawInput: unknown): Promise<BlogExtractResult> {
    const input = blogExtractInput.parse(rawInput);
    const post = parsePostUrl(input.url);
    if (this.busy) throw new Error("다른 블로그 추출이 진행 중이에요. 끝난 뒤 다시 시도해주세요.");
    const parent = input.outputDirectory ?? (await this.defaultParent());
    if (!parent) throw new Error("저장 위치가 없어요. outputDirectory를 지정하거나 앱 블로그 탭에서 저장 위치를 한 번 선택해주세요.");
    const resolvedParent = await realpath(parent);
    if (!(await stat(resolvedParent)).isDirectory()) throw new Error("저장 위치가 폴더가 아니에요.");
    const directory = path.join(resolvedParent, post.slug);
    const name = input.name ?? post.blogId;
    const progress = (stage: BlogExtractProgress["stage"], message: string) => this.deps.progress({ url: post.url, stage, message });
    this.busy = true;
    const s = this.session("blog-extract");
    const win = this.window(s, VIEWPORT, (u) => u.protocol === "https:" && /(^|\.)naver\.com$/.test(u.hostname));
    try {
      progress("open", "원본 글을 여는 중");
      this.load(win, post.url);
      if (!(await this.waitFor(win, `!!document.querySelector('iframe#mainFrame')?.getAttribute('src')`, 30_000)))
        throw new Error("mainFrame을 찾지 못했어요. 삭제·비공개·차단된 글일 수 있어 추정하지 않고 중단합니다.");
      const frameSrc: string = await win.webContents.executeJavaScript(`document.querySelector('iframe#mainFrame').getAttribute('src')`);
      const pageUrl = new URL(frameSrc, "https://blog.naver.com").href;
      if (new URL(pageUrl).hostname !== "blog.naver.com") throw new Error(`예상하지 못한 mainFrame 주소예요: ${pageUrl}`);
      this.load(win, pageUrl);
      if (!(await this.waitFor(win, `!!document.querySelector('.se-main-container')`, 30_000)))
        throw new Error(".se-main-container를 찾지 못했어요. 스마트에디터 ONE 글이 아니거나 차단된 글이라 추정하지 않고 중단합니다.");

      let pending = 0;
      for (let pass = 0; pass < 4; pass++) {
        pending = await win.webContents.executeJavaScript(pageScript(loadImages, pass));
        progress("images", `사진 로딩 확인 ${pass + 1}회차: 남은 사진 ${pending}장`);
        if (!pending) break;
        await new Promise((r) => setTimeout(r, 800));
      }
      await win.webContents.executeJavaScript(`(async () => { scrollTo(0, 0); await document.fonts.ready; await new Promise(r => setTimeout(r, 500)); return true })()`);

      progress("extract", "구조·서식·원문 추출 중");
      const capture: PageCapture = await win.webContents.executeJavaScript(pageScript(extractPost, ".se-main-container", { id: post.blogId, name, url: post.url }));
      const pageUrlSeen = capture.structure.pageUrl;
      if (new URL(pageUrlSeen).hostname !== "blog.naver.com") throw new Error("추출 중 다른 페이지로 이동했어요.");

      progress("check", "블록·글자수·사진·앵커 교차검증 중");
      const { errors, warnings } = checkCapture(capture);
      if (errors.length) throw new Error(`검증 실패로 파일을 쓰지 않았어요: ${errors.slice(0, 5).join("; ")}`);
      const classes = capture.template.blocks.map((b) => b.sourceClass);
      const kinds = countKinds(classes);
      const mobile = await this.mobile(s, post.mobileUrl, classes);

      progress("write", "결과 폴더에 저장 중");
      await mkdir(directory, { recursive: true });
      const fonts = await this.fonts(s, capture, directory, warnings);
      const meta = {
        관찰일: capture.capturedAt,
        원본주소: post.url,
        PostView: pageUrlSeen,
        뷰포트: `${capture.viewport.width}x${capture.viewport.height}`,
        관찰범위: ".se-main-container 전체 블록 (제목은 메타, 댓글·프로필·공감 제외)",
        생성: "Reels Dashboard 블로그 추출",
      };
      const templates = upsertBy(await this.readJson(path.join(directory, "reference-templates.json")), capture.template as never, "sourceUrl");
      const structures = upsertBy(await this.readJson(path.join(directory, "reference-structures.json")), capture.structure as never, "url");
      await this.write(path.join(directory, "reference-templates.json"), JSON.stringify(templates));
      await this.write(path.join(directory, "reference-templates.md"), toMarkdown("레퍼런스 템플릿 (TemplateEngine 입력)", meta, templates));
      await this.write(path.join(directory, "reference-structures.json"), JSON.stringify(structures, null, 1));
      await this.write(path.join(directory, "reference-structures.md"), toMarkdown("레퍼런스 구조 (블로그 → 레퍼런스 추출·탐색 입력)", meta, structures));
      await this.installViewer(directory);
      const entry: Record<string, unknown> & { url: string } = {
        templateId: capture.template.id,
        name,
        url: post.url,
        pageUrl: pageUrlSeen,
        capturedAt: capture.capturedAt,
        viewport: capture.viewport,
        referenceWidth: capture.template.referenceWidth,
        title: capture.title && { characters: capture.title.characters, text: capture.title.text, fontFamily: capture.title.css["font-family"], fontSize: capture.title.css["font-size"] },
        originalFontsLoaded: capture.fontsLoaded,
        fonts,
        kinds,
        warnings,
        mobileCrosscheck: mobile,
      };
      const reportFile = path.join(directory, "restore-report.json");
      const previous = ((await this.readJson(reportFile)) as { entries?: unknown } | null)?.entries;
      const writeReport = () => this.write(reportFile, JSON.stringify({ schemaVersion: 1, generatedBy: "reels-dashboard blog extractor", entries: upsertBy(previous, entry, "url") }, null, 2));
      await writeReport();
      const result = await this.deps.register(directory);

      progress("verify", "복원 화면을 그려 원본 높이와 대조 중");
      let summary;
      try {
        const index = templates.findIndex((t) => (t as { sourceUrl: string }).sourceUrl === capture.template.sourceUrl);
        const measured = await this.verify(result.id, index, capture.template.referenceWidth);
        const f = fidelity(capture.structure.blocks, measured.blocks, capture.template.blocks);
        entry.fidelity = { ...f, mode: "original text + CDN photos", images: measured.images, viewerFonts: measured.fonts };
        summary = f.summary;
        await writeReport();
      } catch (e) {
        warnings.push(`복원 렌더 대조 실패: ${String((e as Error).message ?? e)}`);
        await writeReport();
      }
      await this.write(path.join(directory, "README.md"), readme(entry, directory));
      progress("done", `완료: ${capture.template.blocks.length}개 블록`);
      return { directory, resultId: result.id, name, url: post.url, blocks: capture.template.blocks.length, kinds, warnings, fidelity: summary, mobileCrosscheck: mobile };
    } catch (e) {
      progress("error", String((e as Error).message ?? e));
      throw e;
    } finally {
      if (!win.isDestroyed()) win.destroy();
      this.busy = false;
    }
  }

  private async mobile(s: Session, url: string, classes: string[]): Promise<MobileCheck> {
    try {
      const res = await s.fetch(url, { headers: { "User-Agent": MOBILE_UA, "Accept-Language": "ko-KR,ko;q=0.9" } });
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      return mobileCheck(classes, await res.text());
    } catch (e) {
      return { ok: false, reason: String((e as Error).message ?? e) };
    }
  }

  /** Downloads only the se-* web fonts the original actually loaded, from Naver's own stylesheets. */
  private async fonts(s: Session, capture: PageCapture, directory: string, warnings: string[]) {
    const families = new Set(capture.fontsLoaded.map((f) => f.family).filter((f) => /^se-[\w-]+$/.test(f)));
    const saved: string[] = [];
    if (!families.size) return saved;
    await mkdir(path.join(directory, "fonts"), { recursive: true });
    for (const href of capture.stylesheets.slice(0, 20)) {
      try {
        const res = await s.fetch(href);
        if (!res.ok) continue;
        for (const face of fontFaces(await res.text(), href, families)) {
          if (saved.includes(face.file) || saved.length >= 12) continue;
          const font = await s.fetch(face.url);
          const data = Buffer.from(await font.arrayBuffer());
          if (!font.ok || data.length > 5 * 1024 * 1024 || data.subarray(0, 4).toString("latin1") !== "wOF2") continue;
          await this.write(path.join(directory, "fonts", face.file), data);
          saved.push(face.file);
        }
      } catch {
        /* stylesheet or font unavailable; reported below */
      }
    }
    const missing = [...families].filter((f) => !saved.some((file) => file.startsWith(f + "-")));
    if (missing.length) warnings.push(`원본 웹폰트를 받지 못함: ${missing.join(", ")} (대체 글꼴로 렌더되어 높이 대조가 부정확할 수 있음)`);
    return saved;
  }

  private async installViewer(directory: string) {
    for (const file of ["restore-viewer.js", "restore-viewer.css"]) await copyFile(path.join(this.deps.viewerAssets, file), path.join(directory, file));
    await this.write(
      path.join(directory, "index.html"),
      '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>레퍼런스 복원</title><link rel="stylesheet" href="restore-viewer.css"><body><div id="root"></div><script type="module" src="restore-viewer.js"></script></body></html>\n',
    );
  }

  private async verify(resultId: string, author: number, width: number) {
    const url = new URL(await this.deps.preview(resultId));
    url.searchParams.set("author", String(Math.max(author, 0)));
    const s = this.session("blog-restore-verify");
    const win = this.window(s, { width: Math.ceil(width) + 520, height: 1000 }, (u) => u.origin === url.origin);
    try {
      this.load(win, url.href);
      if (!(await this.waitFor(win, `!!document.body?.dataset.restoreReady`, 20_000))) throw new Error("복원 화면이 열리지 않았어요.");
      return (await win.webContents.executeJavaScript(pageScript(measureRestore))) as {
        blocks: { height: number; characters: number }[];
        images: { total: number; loaded: number };
        fonts: string[];
      };
    } finally {
      if (!win.isDestroyed()) win.destroy();
    }
  }

  private async readJson(file: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      return null;
    }
  }
  private async write(file: string, data: string | Buffer) {
    const temp = `${file}.${randomUUID()}.tmp`;
    await writeFile(temp, data, { flag: "wx" });
    await rename(temp, file);
  }
}

function readme(e: Record<string, any>, directory: string) {
  const s = e.fidelity?.summary;
  const mc = e.mobileCrosscheck as MobileCheck;
  return `# 레퍼런스 복원 — ${e.name}

[원본](${e.url}) · 관찰 ${e.capturedAt} · 뷰포트 ${e.viewport.width}x${e.viewport.height} · 본문폭 ${Math.round(e.referenceWidth)}px · 생성: Reels Dashboard 블로그 추출 (MCP \`reels_extract_blog_reference\`)

원본 DOM 트리·계산 서식·원문 텍스트를 보관하고 TemplateEngine 컴포넌트로 다시 그린다. 사진 파일은 저장하지 않고 원본 CDN URL만 기록해 볼 때 불러온다(no-referrer). 원본이 삭제·비공개되면 사진은 같은 크기의 깨진 이미지로 보인다(뷰어 \`?images=0\`이면 자리표시). 링크 href·댓글·프로필은 저장하지 않는다.

- 블록 종류: ${Object.entries(e.kinds).map(([k, v]) => `${k} ${v}`).join(", ")}
${s ? `- 복원 높이 대조(원문 + 원본 사진): ±5% ${s.within5pct}/${s.measured}, ±15% ${s.within15pct}/${s.measured}, 총높이 원본 ${s.originalTotalHeight}px → 복원 ${s.restoredTotalHeight}px, 사진 ${e.fidelity.images.loaded}/${e.fidelity.images.total} 로드
- 대조 제외: ${s.excluded.map((x: any) => `#${x.order + 1} ${x.kind}(${x.reason})`).join(", ") || "없음"} · 15% 초과: ${s.outliers.map((x: any) => `#${x.order + 1} ${x.kind} ${x.ratio}`).join(", ") || "없음"}` : "- 복원 렌더 대조 없음"}
- 모바일 정적 HTML 교차검증: ${mc.ok ? (mc.allMatch ? "작성자 컴포넌트 종류별 개수 일치" : "불일치 " + JSON.stringify(mc.kinds?.filter((k) => !k.match))) + ` (PC ${mc.pcBlocks} / 모바일 ${mc.mobileBlocks})` : "생략 " + mc.reason}
- 웹폰트: ${(e.fonts as string[]).join(", ") || "없음"}
- 경고: ${(e.warnings as string[]).join("; ") || "없음"}

다시 추출: Dashboard 블로그 → 레퍼런스 추출·탐색에서 같은 URL 추출, 또는 MCP \`reels_extract_blog_reference {"url":"${e.url}","outputDirectory":"${path.dirname(directory)}"}\`. 같은 URL은 교체된다.
`;
}
