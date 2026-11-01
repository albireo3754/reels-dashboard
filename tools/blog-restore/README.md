# Blog reference restore — viewer and reference CLI

The production path is the Dashboard app: Blog → 레퍼런스 추출·탐색 → URL 추출, or MCP
`reels_extract_blog_reference` ([docs](../../docs/blog-workspace.md#url-추출--2026-11-01)).
This folder holds `viewer.jsx` (bundled by `scripts/build-desktop.mjs` into every result folder) and a Playwright CLI
kept as an independent reference check. Both use the app's `src/shared/blog-restore.ts` and
`src/desktop/blog-extract-page.ts`. Output goes to a content workspace, never this repository.

```sh
node --import tsx tools/blog-restore/restore.mjs <naver-post-url> --out <dir> [--id aedun] [--name 애둔] \
  [--fonts <dir with se-*.woff2>] [--viewport 1280x1000] [--no-mobile-check] [--no-verify]
node tools/blog-restore/serve.mjs <dir>          # http://127.0.0.1:8770/ (localhost only)
npm test   # tests/unit/blog-restore.test.ts
```

## Stages

1. **Capture** (`restore.mjs`, Playwright new headless `channel: 'chromium'`; the legacy headless shell renders PostView without its body). Opens the post, resolves `#mainFrame` → PostView, loads it top-level, scrolls until every image under `.se-main-container` is loaded (`_blur` thumbnails count as not loaded), and waits for fonts.
2. **Extract** (`src/desktop/blog-extract-page.ts` `extractPost`, read-only, run via `pageScript`). One pass produces both
   - `reference-templates` entry: TemplateEngine schemaVersion 1 (nested element tree, 53 computed CSS props, `::before/::after` ornaments, `text-slot` with masked sample, `image-slot` with natural/original size), and
   - `reference-structures` entry: the `blog-reference-extract` data contract read by Dashboard **블로그 → 레퍼런스 추출·탐색**.
   Text-slots keep the original text in `text` and a mask in `sample` (`가`, keeping length, whitespace, zero-width characters and punctuation; TemplateEngine template mode reads `sample`). Image-slots keep the original CDN URL in `src` (`https` + `*.pstatic.net` only); photo files are never downloaded. hrefs, comments, profile data and page state are not read.
3. **Cross-check** (`src/shared/blog-restore.ts`). Per block: paragraph character totals (tree vs structure, catches double counting), image counts, anchors, unloaded images. Errors stop before any file is written; empty results never overwrite files. Optional static check (idea from NomaDamas/k-skill `naver-blog-research`): fetch `m.blog.naver.com` and compare component kinds, excluding PC-injected ads (`ssp-adcontent`) and the mobile title component. Only counts are kept.
4. **Write** `reference-templates.json/.md`, `reference-structures.json/.md`, `restore-report.json`, `README.md` (upsert per URL, max 30 posts per folder) and copy fonts if `--fonts` is given.
5. **Render + verify**. Bundles `viewer.jsx` (imports `TemplateBlock` from `../blog-preview/TemplateEngine.jsx`) into the output folder, serves it on 127.0.0.1 and renders all blocks at the original width, passing original text/photo URLs as TemplateEngine `values`. The page sets `<meta name="referrer" content="no-referrer">`: the Naver CDN returns 403 for a localhost Referer and 200 without one. Records per-block restored/original height ratio and photo load count for original text + photos, the same summary for masked text + placeholders, page errors, and `restored-<id>.png` (original text, photo placeholders, so no photo pixels are written). Viewer query: `?text=0`, `?images=0`, `?author=N`.

Fidelity excludes non-author blocks (ads) and kinds TemplateEngine draws as a fixed placeholder (`Map`); they are listed under `summary.excluded`.

## Limits

- Height agreement is a structural check at one PC viewport, not pixel similarity and not a mobile audit.
- Fonts render only if the `se-*` woff2 files are provided; otherwise fallback fonts make the height check unreliable (warned).
- Map, slide navigation and ad slots are not reproduced. Photos depend on the live CDN URL; a deleted/private post or expired URL shows a broken image at the measured size (use `?images=0` for placeholders).
- Depends on the current `tools/blog-preview` TemplateEngine API (`TemplateBlock`, `style.css`).
