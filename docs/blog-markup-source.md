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

Successful writes use a temporary file plus rename and retain previous contents in .history/<filename>/ (20 by default) and the last tool result. Readback detects immediate overwrites; load warns when external contents differ from the last tool result. Obsidian does not honor the lock: this is detection and recovery support, not a guarantee against later buffered overwrites. A crash may leave a lock; remove it only after confirming that the writer has stopped.

Unsupported SmartEditor font sizes remain validation errors and cannot be saved through the store. Conversion can preserve them for review without silently changing the user's formatting. Source switch and editor integration are separate follow-up steps.

## Verification

Unit tests cover normalization, YAML preservation, classification, independent/conflicting merges, duplicate footnotes, text guard, concurrent user edits, locks/history/external drift and HTML output/escaping. Existing full unit suite, typecheck, public-source audit and architecture checks passed on 2026-11-01. Real manuscript equivalence evidence stays in its vault research directory.
