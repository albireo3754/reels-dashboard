# Blog markup source

src/shared/blog-markup.ts defines source Markdown syntax and the MarkupDoc AST. Files can contain YAML frontmatter (markup: 1, title, media, notes and style), then Bundle components. Existing browser editors still use their current storage; this implementation does not switch editors or migrate a user's canonical file.

Text stays inline. Emphasis accepts both ⟦phrase⟧^1 and superscript numbers; serialization normalizes to superscripts and excludes generated legend/※ notes. YAML uses the existing pinned yaml dependency and preserves key order/comments. Paragraph trailing spaces are preserved.

Run from this repository:

    node --import tsx scripts/blog-markup.ts check /path/to/article.md
    node --import tsx scripts/blog-markup.ts view /path/to/article.md
    node --import tsx scripts/blog-markup.ts hash /path/to/article.md /path/to/reviews.json
    node --import tsx scripts/blog-markup.ts merge /path/to/base.md /path/to/mine.md /path/to/current.md
    node --import tsx scripts/blog-markup.ts render /path/to/article.md /path/to/layout.html
    node --import tsx scripts/blog-markup.ts convert-layers /path/to/conversion.json

check exits 1 for validation errors. view includes only the notes file's “## 규칙” section and computed facts. hash evaluates text-oriented findings against textHash and other axes against fullHash. merge returns JSON with either normalized text or conflict details and does not write. render updates an existing layout shell and creates an exclusive .before-markup backup; media paths are resolved from Markdown and rebased to the HTML destination. The shell supplies component layout CSS and fonts; source style overrides use CSS variables. Native cards are placeholders, not real Naver components.

convert-layers is a one-time import command that writes the candidate to stdout. Its JSON manifest supplies source/grouping/bundles/emphasis paths relative to the manifest, plus media/notes, questionTopic, mapPlace/mapHref and style. It rejects missing emphasis, ambiguous anchors, duplicate paragraphs and gaps/overlaps. Manuscripts and manifests stay outside this code repository.

## Saving and review identity

blog-markup-source.ts provides textOf, classify, bundleHashes, reviewFresh, and normalized line-LCS merge3. Paragraph identity protects wording while allowing reorder; heading/title/tag strings are also protected. Bundle text hashes retain reading order, so reordering can stale a review. Merge size is bounded to 16 million LCS cells.

blog-markup-store.ts exports load/save. Save requires actor user or agent and a matching base text/fingerprint pair. It locks tools with an exclusive .lock, rereads disk, normalizes all three versions before merge, validates, and prevents agent wording edits both before and after merging. User edits may change text. Even a clean line merge is refused when duplicate footnotes make it unparsable. No automatic renumbering is performed.

Successful writes use a temporary file plus rename and retain previous contents in .history/<filename>/ (20 by default) and the last tool result. User saves from the editor keep 60 copies and skip a copy of their own save made in the last 60 seconds; a version replaced by a conflict goes to conflict-*.md outside that rotation. recoverBase finds a base text in this folder by fingerprint. A .lock older than 120 seconds counts as left by a crash and is taken over. Readback detects immediate overwrites; load warns when external contents differ from the last tool result. Obsidian does not honor the lock: this is detection and recovery support, not a guarantee against later buffered overwrites. A crash may leave a lock; remove it only after confirming that the writer has stopped.

Unsupported SmartEditor font sizes remain validation errors and cannot be saved through the store. Conversion can preserve them for review without silently changing the user's formatting. Source switch and editor integration are separate follow-up steps.

## Verification

Unit tests cover normalization, YAML preservation, classification, independent/conflicting merges, duplicate footnotes, text guard, concurrent user edits, locks/history/external drift and HTML output/escaping. Existing full unit suite, typecheck, public-source audit and architecture checks passed on 2026-11-01. Real manuscript equivalence evidence stays in its vault research directory.

## Mixed-ratio collage — 2026-11-10

`<Collage>` takes an optional `ratios` attribute, one `width:height` per photo in `files` order, separated by ` · `:

    <Collage layout="2x2" files="a.jpg · b.jpg · c.jpg · d.jpg" alts="…" ratios="3:4 · 4:3 · 4:3 · 16:9"/>
    <Collage layout="2+1" files="a.jpg · b.jpg · c.jpg" alts="…" ratios="4:3 · 4:3 · 16:9"/>

`layout` decides the rows: `2x2` is columns x rows, `2+1` lists the photos in each row. With `ratios`, the renderer emits `figure.photo-collage-rows` with one `.collage-row` per row. Each cell gets its ratio as `--r` and grows by it, so photos in a row share one height and their widths follow their ratios. Images use `object-fit: cover`, so a file whose real ratio differs is centre-cropped by the browser; crop the file to the declared ratio when the subject sits off centre. The CSS lives in `MARKUP_STYLE_CSS`, which both the editor frame and the `render` CLI add, so article layout files need no change.

Without `ratios` the output is the previous even two-column grid (`figure.photo-grid4.even`), byte for byte. `validate` reports an error when `ratios` does not list one valid ratio per photo or when the `layout` cell count differs from the photo count; the renderer falls back to the even grid for a malformed value.

Not covered: the editor has no control for editing `ratios` (edit the markup source), the legacy layer format is unchanged, and transferring a mixed row to the real Naver collage UI has not been tried. Tests: `tests/unit/blog-markup.test.ts` (rows, round trip, validation, fallback) and `tests/web/markup-layout.spec.ts` (equal row height, full width and per-cell ratio at four widths).
