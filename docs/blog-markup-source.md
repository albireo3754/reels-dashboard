# Blog markup source

src/shared/blog-markup.ts defines source Markdown syntax and the MarkupDoc AST. Files can contain YAML frontmatter (markup: 1, title, media, notes and style), then Bundle components. Existing browser editors still use their current storage; this implementation does not switch editors or migrate a user's canonical file.

Text stays inline. Emphasis accepts both ⟦phrase⟧^1 and superscript numbers; serialization normalizes to superscripts and excludes generated legend/※ notes. YAML uses the existing pinned yaml dependency and preserves key order/comments. Paragraph trailing spaces are preserved.

Run from this repository:

    node --import tsx scripts/blog-markup.ts check /path/to/article.md
    node --import tsx scripts/blog-markup.ts view /path/to/article.md
    node --import tsx scripts/blog-markup.ts hash /path/to/article.md /path/to/reviews.json
    node --import tsx scripts/blog-markup.ts merge /path/to/base.md /path/to/mine.md /path/to/current.md
    node --import tsx scripts/blog-markup.ts render /path/to/article.md /path/to/layout.html [--from /path/to/other-layout.html]
    node --import tsx scripts/blog-markup.ts convert-layers /path/to/conversion.json

check exits 1 for validation errors. view includes only the notes file's “## 규칙” section and computed facts. hash evaluates text-oriented findings against textHash and other axes against fullHash. merge returns JSON with either normalized text or conflict details and does not write. render updates an existing layout shell and creates an exclusive .before-markup backup; with `--from` it instead creates a missing layout from another article's layout (relative `url(...)` rebased to the new location, no backup). Either way it sets `<title>` and the first `<h1>` before the article to the frontmatter title; media paths are resolved from Markdown and rebased to the HTML destination. The shell supplies component layout CSS and fonts; source style overrides use CSS variables. Native cards are placeholders, not real Naver components.

convert-layers is a one-time import command that writes the candidate to stdout. Its JSON manifest supplies source/grouping/bundles/emphasis paths relative to the manifest, plus media/notes, questionTopic, mapPlace/mapHref and style. It rejects missing emphasis, ambiguous anchors, duplicate paragraphs and gaps/overlaps. Manuscripts and manifests stay outside this code repository.

## Saving and review identity

blog-markup-source.ts provides textOf, classify, bundleHashes, reviewFresh, and normalized line-LCS merge3. Paragraph identity protects wording while allowing reorder; heading/title/tag strings are also protected. Bundle text hashes retain reading order, so reordering can stale a review. Merge size is bounded to 16 million LCS cells.

blog-markup-store.ts exports load/save. Save requires actor user or agent and a matching base text/fingerprint pair. It locks tools with an exclusive .lock, rereads disk, normalizes all three versions before merge, validates, and prevents agent wording edits both before and after merging. User edits may change text. Even a clean line merge is refused when duplicate footnotes make it unparsable. No automatic renumbering is performed.

Successful writes use a temporary file plus rename and retain previous contents in .history/<filename>/ (20 by default) and the last tool result. User saves from the editor keep 60 copies and skip a copy of their own save made in the last 60 seconds; a version replaced by a conflict goes to conflict-*.md outside that rotation. recoverBase finds a base text in this folder by fingerprint. A .lock older than 120 seconds counts as left by a crash and is taken over. Readback detects immediate overwrites; load warns when external contents differ from the last tool result. Obsidian does not honor the lock: this is detection and recovery support, not a guarantee against later buffered overwrites. A crash may leave a lock; remove it only after confirming that the writer has stopped.

Unsupported SmartEditor font sizes remain validation errors and cannot be saved through the store. Conversion can preserve them for review without silently changing the user's formatting. Source switch and editor integration are separate follow-up steps.

## Verification

Unit tests cover normalization, YAML preservation, classification, independent/conflicting merges, duplicate footnotes, text guard, concurrent user edits, locks/history/external drift and HTML output/escaping. Existing full unit suite, typecheck, public-source audit and architecture checks passed on 2026-11-01. Real manuscript equivalence evidence stays in its vault research directory.

## Unknown components — 2026-11-12

A tag line that is not in `COMPONENTS` no longer fails the parse (before: `모르는 컴포넌트 <Video>` kept the whole document from opening in a build without that component). It becomes an `unknown` node that keeps the source line as written: the editor and preview show that line in a dashed box, `validate` reports a warning, and saving writes the line back unchanged. An unknown opening line and its closing line are one node each, and the paragraphs between them are read as body paragraphs of the bundle. Inside a known container the tag is still an error, because containers hold paragraphs only.

Not covered: the unknown line cannot be edited in the editor, and the SmartEditor transfer does not know what to do with it.

## Mixed-ratio collage — 2026-11-10

`<Collage>` takes an optional `ratios` attribute, one `width:height` per photo in `files` order, separated by ` · `:

    <Collage layout="2x2" files="a.jpg · b.jpg · c.jpg · d.jpg" alts="…" ratios="3:4 · 4:3 · 4:3 · 16:9"/>
    <Collage layout="2+1" files="a.jpg · b.jpg · c.jpg" alts="…" ratios="4:3 · 4:3 · 16:9"/>

`layout` decides the rows: `2x2` is columns x rows, `2+1` lists the photos in each row. With `ratios`, the renderer emits `figure.photo-collage-rows` with one `.collage-row` per row. Each cell gets its ratio as `--r` and grows by it, so photos in a row share one height and their widths follow their ratios. Images use `object-fit: cover`, so a file whose real ratio differs is centre-cropped by the browser; crop the file to the declared ratio when the subject sits off centre. The CSS lives in `MARKUP_STYLE_CSS`, which both the editor frame and the `render` CLI add, so article layout files need no change.

Without `ratios` the output is the previous even two-column grid (`figure.photo-grid4.even`), byte for byte. `validate` reports an error when `ratios` does not list one valid ratio per photo or when the `layout` cell count differs from the photo count; the renderer falls back to the even grid for a malformed value.

Not covered: the editor has no control for editing `ratios` (edit the markup source), the legacy layer format is unchanged, and transferring a mixed row to the real Naver collage UI has not been tried. Tests: `tests/unit/blog-markup.test.ts` (rows, round trip, validation, fallback) and `tests/web/markup-layout.spec.ts` (equal row height, full width and per-cell ratio at four widths).


## Local video component — 2026-11-12

`<Video>` embeds a real local video in the canonical markup, saved HTML and editor frame:

```text
<Video file="cheers.MOV" alt="동료들과 잔을 맞대는 순간" poster="cheers.jpg" ratio="4:5" fit="cover" position="50% 60%" muted/>
```

`file` is a basename in the document's configured media directory (`.mp4`, `.m4v`, `.mov`, `.webm`). Optional attributes are `alt`, `poster` (local JPEG/PNG/WebP basename), `caption`, `ratio` (width:height), `fit` (`contain`, default; or `cover`), `position` (two percentages), `muted`, and `loop`. Unknown attributes, remote URLs, path traversal, invalid ratios/positions and non-boolean flags are validation errors. Serialization preserves the component. Visible captions participate in text hashes and the wording guard; crop/playback changes invalidate visual/structural review only.

The player uses native controls, playsinline and preload=metadata; it never autoplays. Omit `muted` to retain normal user-initiated sound playback. The source bytes, codecs, HDR metadata and audio are not transcoded. Browser/platform codec support still applies. `ratio`, `fit` and `position` change the inline display only: they are **not** a physical crop, privacy redaction or an exported video edit, and fullscreen may show the source frame.

The editor serves only files declared by Video nodes (and declared poster images), through the existing configured media/explicit assetFiles boundary. Video responses support GET/HEAD, bounded single byte ranges (206/416), content type and streaming without reading the entire file into memory. Symlink targets need the same explicit `assetFiles` allowlist as photos. Text autosave retains video components and does not change the frame's style identity just because a derived HTML theme was inserted.

This adds local markup/preview support. It does not upload videos to Naver, create SmartEditor video IDs, or guarantee a display crop transfers there. Naver publishing still requires a real upload and separate verification. Legacy BlogDraft image-only export is unchanged; use the markup source as canonical.

Validation: parser/serialization, invalid inputs, caption text protection, unchanged media bytes, origin/path allowlists, range/HEAD, save persistence; Chromium actual playback/seeking at desktop/mobile widths; opted-in Electron playback of a real 8-second rotated HEVC 10-bit HLG/Dolby Vision source. Original source bytes were not edited.

The installed active app was updated from its current worktree with existing UI/cover changes preserved; workflow protocol 4 was restored at the same time. The real blog editor displayed the new Video components, and a prepared sound-included clip played to its end with volume enabled. Private source paths, captures and deployment receipts remain in the content workspace.

## Immutable evaluation history — 2026-11-13

The rotating recovery copies above now coexist with an unrotated `content-evals` store under the same history directory. Every changed save prepares exact before/after snapshots and a transaction before replacing the manuscript; a separate receipt records the outcome. Loads/saves reconcile pending attempts and observe external drift relative to the last tool save. Durable snapshots can recover older merge bases, so an intervening edit that previously lost its base can now correctly report a conflict while preserving the overwritten alternative. See [data, feedback, recovery and evaluation contracts](content-evals.md).
