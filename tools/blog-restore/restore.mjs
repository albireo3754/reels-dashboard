#!/usr/bin/env node
// Naver blog reference → local restoration files → TemplateEngine React render → fidelity check.
// Usage: node --import tsx tools/blog-restore/restore.mjs <naver-post-url> --out <dir> [--id aedun] [--name 애둔]
//        [--fonts <dir-with-se-*.woff2>] [--viewport 1280x1000] [--no-mobile-check] [--no-verify]
import {readFile, writeFile, rename, mkdir, readdir, copyFile, stat} from 'node:fs/promises';
import {resolve, dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import {serve} from './serve.mjs';
// Same model and page scripts as the Dashboard app's in-app extractor (run with `node --import tsx`).
import {parsePostUrl, checkCapture, countKinds, mobileCheck as compareMobile, fidelity, upsertBy as upsertByUrl, toMarkdown} from '../../src/shared/blog-restore.ts';
import {extractPost, loadImages, pageScript} from '../../src/desktop/blog-extract-page.ts';

const here = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.error('[restore]', ...a);

function parseArgs(argv) {
  const o = {mobileCheck: true, verify: true, viewport: '1280x1000'};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i]; else if (a === '--id') o.id = argv[++i]; else if (a === '--name') o.name = argv[++i];
    else if (a === '--fonts') o.fonts = argv[++i]; else if (a === '--viewport') o.viewport = argv[++i];
    else if (a === '--no-mobile-check') o.mobileCheck = false; else if (a === '--no-verify') o.verify = false;
    else if (a.startsWith('--')) throw new Error(`알 수 없는 옵션 ${a}`); else rest.push(a);
  }
  if (rest.length !== 1 || !o.out) throw new Error('Usage: restore.mjs <naver-post-url> --out <dir> [--id x] [--name x] [--fonts dir] [--viewport WxH]');
  const [w, h] = o.viewport.split('x').map(Number);
  if (!(w >= 320 && h >= 320)) throw new Error('--viewport 형식은 1280x1000');
  return {...o, input: rest[0], viewport: {width: w, height: h}};
}

async function writeAtomic(path, data) { const tmp = `${path}.tmp-${process.pid}`; await writeFile(tmp, data); await rename(tmp, path); }
async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }

/** 1. Open post, resolve mainFrame → PostView, scroll until lazy images load, extract. */
async function capture(browser, post, opts) {
  const context = await browser.newContext({viewport: opts.viewport, locale: 'ko-KR', deviceScaleFactor: 1});
  try {
    const page = await context.newPage();
    await page.goto(post.url, {waitUntil: 'domcontentloaded', timeout: 30000});
    const frameEl = await page.waitForSelector('iframe#mainFrame', {timeout: 20000}).catch(() => null);
    const frameUrl = frameEl ? await frameEl.getAttribute('src') : null;
    const pageUrl = frameUrl ? new URL(frameUrl, 'https://blog.naver.com').href : post.url;
    if (new URL(pageUrl).hostname !== 'blog.naver.com') throw new Error(`예상하지 못한 mainFrame 주소 ${pageUrl}`);
    // Load PostView as the top-level document so lazy-loading follows normal window scrolling.
    await page.goto(pageUrl, {waitUntil: 'domcontentloaded', timeout: 30000});
    const container = page.locator('.se-main-container').first();
    if (!(await container.waitFor({timeout: 20000}).then(() => true, () => false))) throw new Error('.se-main-container를 찾지 못했어요 (삭제·비공개·차단 가능). 추정하지 않고 중단합니다.');
    for (let pass = 0; pass < 4; pass++) {
      const pending = await page.evaluate(pageScript(loadImages, pass));
      log(`이미지 로딩 pass ${pass + 1}: 미확인 ${pending}`);
      if (!pending) break;
      await page.waitForTimeout(800);
    }
    await page.evaluate(async () => { scrollTo(0, 0); await document.fonts.ready; await new Promise(r => setTimeout(r, 500)); });
    const result = await page.evaluate(pageScript(extractPost, '.se-main-container', {id: opts.id, name: opts.name, url: post.url}));
    return {...result, outerUrl: post.url, pageUrl};
  } finally { await context.close(); }
}

/** 2. Optional static cross-check against the mobile page (k-skill idea; counts only, nothing stored). */
async function mobileCheck(post, pcClasses) {
  try {
    const res = await fetch(post.mobileUrl, {headers: {'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', 'Accept-Language': 'ko-KR,ko;q=0.9'}});
    if (!res.ok) return {ok: false, reason: `HTTP ${res.status}`};
    return compareMobile(pcClasses, await res.text());
  } catch (e) { return {ok: false, reason: String(e.message || e)}; }
}

/** 3. Bundle the viewer (existing TemplateEngine components) next to the data. */
async function buildViewer(out) {
  await build({entryPoints: [join(here, 'viewer.jsx')], bundle: true, external: ['fonts/*'], outfile: join(out, 'restore-viewer.js'), format: 'esm', platform: 'browser', jsx: 'automatic', define: {'process.env.NODE_ENV': '"production"'}, minify: true, logLevel: 'warning'});
  await writeAtomic(join(out, 'index.html'), '<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>레퍼런스 복원</title><link rel="stylesheet" href="restore-viewer.css"><body><div id="root"></div><script type="module" src="restore-viewer.js"></script></body></html>\n');
}

/** 4. Render the restoration and measure each block against the original geometry. */
async function verify(browser, out, entryIndex, cap) {
  const server = await serve(out);
  const context = await browser.newContext({viewport: {width: Math.ceil(cap.template.referenceWidth) + 520, height: 1000}, deviceScaleFactor: 1});
  const base = `http://127.0.0.1:${server.address().port}/?author=${entryIndex}`;
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    const open = async query => {
      await page.goto(`${base}&${query}`, {waitUntil: 'networkidle'});
      await page.waitForSelector('body[data-restore-ready]', {timeout: 15000});
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; }))); });
      return page.$$eval('[data-restore-block]', els => els.map(e => ({height: e.getBoundingClientRect().height, characters: e.textContent.length})));
    };
    // Primary: original text + original photos loaded from the CDN URL (no-referrer).
    const rendered = await open('text=1&images=1');
    const images = await page.$$eval('[data-restore-surface] img', els => ({total: els.length, loaded: els.filter(i => i.complete && i.naturalWidth > 0).length}));
    const fontsUsed = await page.evaluate(() => [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family));
    const masked = fidelity(cap.structure.blocks, await open('text=0&images=0'), cap.template.blocks).summary;
    // Saved capture keeps text but uses photo placeholders, so no photo pixels are written to disk.
    await open('text=1&images=0');
    await page.addStyleTag({content: '.restore-nav{position:static!important}'}); // sticky nav would overlay the element capture
    await page.locator('[data-restore-surface]').screenshot({path: join(out, `restored-${cap.template.id}.png`)});
    const fid = fidelity(cap.structure.blocks, rendered, cap.template.blocks);
    return {...fid, mode: 'original text + CDN photos', images, maskedSummary: masked, pageErrors: errors, viewerFonts: [...new Set(fontsUsed)]};
  } finally { await context.close(); server.close(); }
}

function outputReadme(e, opts, out) {
  const s = e.fidelity?.summary;
  const mc = e.mobileCrosscheck;
  return `# 레퍼런스 복원 — ${e.name}

[원본](${e.url}) · 관찰 ${e.capturedAt} · 뷰포트 ${e.viewport.width}x${e.viewport.height} · 본문폭 ${Math.round(e.referenceWidth)}px · 생성 \`tools/blog-restore/restore.mjs\` (Reels Dashboard 저장소)

원본 DOM 트리·계산 서식·원문 텍스트를 보관하고 현재 TemplateEngine React 컴포넌트로 다시 그렸다. 사진 파일은 저장하지 않고 원본 CDN URL만 기록해 뷰어에서 볼 때 불러온다(no-referrer). 원본이 삭제·비공개되면 사진은 같은 크기의 깨진 이미지로 보인다(?images=0이면 자리표시). 링크 href·댓글·프로필은 저장하지 않는다.

| 파일 | 용도 |
| --- | --- |
| [reference-templates.json](reference-templates.json) / [.md](reference-templates.md) | TemplateEngine 입력 (schemaVersion 1, 중첩 element/text-slot/image-slot 트리) |
| [reference-structures.json](reference-structures.json) / [.md](reference-structures.md) | Dashboard 블로그 → 레퍼런스 추출·탐색 입력 (blog-reference-extract 계약) |
| [restore-report.json](restore-report.json) | 블록 종류·경고·모바일 교차검증·복원 높이 대조 |
| [restored-${e.templateId}.png](restored-${e.templateId}.png) | 복원 렌더 캡처 (원문 글·사진 자리표시 — 사진 픽셀은 저장하지 않음) |
| index.html + restore-viewer.* | 복원 뷰어 (블록 클릭 → 대조표, 번호 클릭 → 원본 앵커) |

## 결과

- 블록 종류: ${Object.entries(e.kinds).map(([k, v]) => `${k} ${v}`).join(', ')}
${s ? `- 복원 높이 대조(원문 글 + 원본 사진 URL): ±5% ${s.within5pct}/${s.measured}, ±15% ${s.within15pct}/${s.measured}, 본문 총높이 원본 ${s.originalTotalHeight}px → 복원 ${s.restoredTotalHeight}px, 사진 ${e.fidelity.images.loaded}/${e.fidelity.images.total} 로드
- 가림 글·자리표시 모드: ±5% ${e.fidelity.maskedSummary.within5pct}/${e.fidelity.maskedSummary.measured}, 총높이 ${e.fidelity.maskedSummary.restoredTotalHeight}px
- 대조 제외: ${s.excluded.map(x => `#${x.order + 1} ${x.kind}(${x.reason}, 원본 ${x.originalHeight}px)`).join(', ') || '없음'}
- 15% 초과: ${s.outliers.map(x => `#${x.order + 1} ${x.kind} ${x.ratio}`).join(', ') || '없음'} · 텍스트 누락 블록: ${s.missingText.map(x => '#' + (x + 1)).join(', ') || '없음'}` : '- 복원 렌더 검증 생략 (--no-verify)'}
- 모바일 정적 HTML 교차검증: ${mc.ok ? `${mc.allMatch ? '작성자 컴포넌트 종류별 개수 일치' : '불일치 ' + JSON.stringify(mc.kinds.filter(k => !k.match))} (PC ${mc.pcBlocks} / 모바일 ${mc.mobileBlocks}, 광고·제목 제외 비교)` : '생략 ' + mc.reason}
- 경고: ${e.warnings.length ? e.warnings.join('; ') : '없음'}

## 다시 만들기·보기

\`\`\`sh
cd ~/side/reels-dashboard
node --import tsx tools/blog-restore/restore.mjs ${e.url} --out ${out} --id ${opts.id} --name ${opts.name}${opts.fonts ? ` --fonts ${opts.fonts}` : ''}
node tools/blog-restore/serve.mjs ${out}   # http://127.0.0.1:8770/  (?text=0 가림 글, ?images=0 사진 자리표시)
\`\`\`

같은 폴더에 다른 글을 \`--out\`으로 지정하면 작성자별 배열에 추가(같은 URL은 교체)된다.
`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const post = parsePostUrl(opts.input);
  opts.id ||= post.blogId; opts.name ||= post.blogId;
  const out = resolve(opts.out);
  await mkdir(out, {recursive: true});
  // The legacy headless shell renders Naver PostView without its body; the new headless mode does.
  const browser = await chromium.launch({headless: true, channel: 'chromium'});
  try {
    log(`수집 ${post.url}`);
    const cap = await capture(browser, post, opts);
    const {errors, warnings} = checkCapture(cap);
    if (errors.length) { log('검증 실패 — 파일을 쓰지 않습니다'); errors.forEach(e => log('  ✗', e)); process.exitCode = 1; return; }
    const kinds = countKinds(cap.template.blocks.map(b => b.sourceClass));
    log(`블록 ${cap.template.blocks.length}개`, JSON.stringify(kinds));
    const mobile = opts.mobileCheck ? await mobileCheck(post, cap.template.blocks.map(b => b.sourceClass)) : {ok: false, reason: 'skipped'};
    const meta = {'관찰일': cap.capturedAt, '원본주소': post.url, 'PostView': cap.pageUrl, '뷰포트': `${cap.viewport.width}x${cap.viewport.height}`, '관찰범위': '.se-main-container 전체 블록 (제목은 길이·서식만, 댓글·프로필·공감 제외)'};

    const templates = upsertByUrl(await readJson(join(out, 'reference-templates.json')), cap.template, 'sourceUrl');
    const structures = upsertByUrl(await readJson(join(out, 'reference-structures.json')), cap.structure, 'url');
    if (!templates.every(t => t.blocks?.length) || !structures.every(s => s.blocks?.length)) throw new Error('빈 결과로 덮어쓰지 않습니다');
    await writeAtomic(join(out, 'reference-templates.json'), JSON.stringify(templates));
    await writeAtomic(join(out, 'reference-templates.md'), toMarkdown('레퍼런스 템플릿 (TemplateEngine 입력)', meta, templates));
    await writeAtomic(join(out, 'reference-structures.json'), JSON.stringify(structures, null, 1));
    await writeAtomic(join(out, 'reference-structures.md'), toMarkdown('레퍼런스 구조 (Dashboard 블로그 → 레퍼런스 추출·탐색 입력)', meta, structures));

    if (opts.fonts) {
      await mkdir(join(out, 'fonts'), {recursive: true});
      for (const f of (await readdir(opts.fonts)).filter(f => f.endsWith('.woff2'))) await copyFile(join(opts.fonts, f), join(out, 'fonts', f));
    } else if (!(await stat(join(out, 'fonts')).catch(() => null))) warnings.push('fonts/ 없음 — 대체 글꼴로 렌더되어 높이 비교가 부정확');

    const reportPath = join(out, 'restore-report.json');
    const prev = (await readJson(reportPath))?.entries || [];
    const entry = {templateId: cap.template.id, name: cap.template.name, url: post.url, pageUrl: cap.pageUrl, capturedAt: cap.capturedAt, viewport: cap.viewport, referenceWidth: cap.template.referenceWidth, title: cap.title && {characters: cap.title.characters, fontFamily: cap.title.css['font-family'], fontSize: cap.title.css['font-size']}, originalFontsLoaded: cap.fontsLoaded, kinds, warnings, mobileCrosscheck: mobile};
    const writeReport = e => writeAtomic(reportPath, JSON.stringify({schemaVersion: 1, generatedBy: 'tools/blog-restore/restore.mjs', entries: upsertByUrl(prev, e, 'url')}, null, 2));
    await writeReport(entry);

    await buildViewer(out);
    if (opts.verify) {
      const idx = templates.findIndex(t => t.sourceUrl === cap.template.sourceUrl);
      entry.fidelity = await verify(browser, out, idx, cap);
      await writeReport(entry);
      const s = entry.fidelity.summary;
      const m = entry.fidelity.maskedSummary, im = entry.fidelity.images;
      log(`복원 렌더(원문+원본사진): ±5% ${s.within5pct}/${s.measured}, ±15% ${s.within15pct}/${s.measured}, 총높이 ${s.originalTotalHeight} → ${s.restoredTotalHeight}, 텍스트 ${s.textRendered ? 'OK' : '누락'}, 사진 ${im.loaded}/${im.total} 로드`);
      log(`복원 렌더(가림 글·자리표시): ±5% ${m.within5pct}/${m.measured}, 총높이 → ${m.restoredTotalHeight}`);
      if (entry.fidelity.pageErrors.length) log('viewer 오류', entry.fidelity.pageErrors);
    }
    await writeAtomic(join(out, 'README.md'), outputReadme(entry, opts, out));
    warnings.forEach(w => log('  !', w));
    if (mobile.ok) log(`모바일 교차검증: PC ${mobile.pcBlocks} / 모바일 ${mobile.mobileBlocks} ${mobile.allMatch ? '일치' : '불일치 ' + JSON.stringify(mobile.kinds.filter(k => !k.match))}`); else log('모바일 교차검증 생략:', mobile.reason);
    log(`완료 → ${out}  (보기: node ${relative(process.cwd(), join(here, 'serve.mjs'))} ${out})`);
  } finally { await browser.close(); }
}

main().catch(e => { console.error('[restore] 실패:', e.message); process.exitCode = 1; });
