# Markup editor integration — 2026-11-01

The canonical Markdown has already switched to blog-markup v1, but the desktop link still targets a stopped legacy server. The desktop will own a loopback editor server and an isolated editor window. A local canonical-blog.json in user-data supplies the canonical file, layout shell, media allowlist and review paths; no personal path is compiled into the app.

The server explicitly selects the markup store when format is markup. Legacy store tests and unrelated saved drafts remain separate. MarkupDoc is the canonical AST. The existing contenteditable UI uses transient inline runs; the store maps only edited paragraphs back to AST marks, retaining role and sizeRole when matching original marks. Unedited paragraphs and all component/bundle structure remain intact.

Saving resolves the load revision to its original text and invokes the existing normalized three-way save with actor user. The new canonical file is the only source. Preview regeneration is derived; failures after canonical save are reported as warnings, not a false rollback. Validation errors are visible. Newly introduced invalid sizes block saving; unchanged pre-existing size errors can remain on user saves (updated in the annotation follow-up below). Conflict errors preserve unsaved UI content.

Reviews use textHash/fullHash per finding axis. Requests contain legend + markup + notes rules; no legacy layer writes. The old SDK draft-only review button is not offered for markup documents. The review button now explicitly runs the markup-specific SDK path described below.

Validation: synthetic store round trips, role/size preservation, independent concurrent edits, conflict protection, asset boundaries, actual HTTP/frame, desktop open/reopen and packaged run. Real content is loaded read-only; edit/save tests use temporary copies. Build and launch the installed app after verification.

## Desktop operation

Place a local canonical-blog.json in the app user-data directory, with format markup, absolute canon/layout/media paths, optional review and requests paths, and any explicitly approved assetFiles symlink targets. Desktop starts an ephemeral 127.0.0.1 server when Blog → 정본 스마트 에디터 열기 is selected, opens a sandboxed app window, reuses it on repeat clicks, and closes its server on app exit. A separate npm blog:editor process and fixed port 4320 are no longer needed for this path.

Existing unsupported SmartEditor font sizes are shown at the top and retained on unrelated user edits; opening the editor does not normalize their values. Markdown is still the source and notes remain separate. Old layer JSON is never written by this store.

Packaging command used for this integration:

    npm run build
    npx electron-builder --mac dir --config.npmRebuild=false --config.directories.output=release/markup-editor

The workflow-only better-sqlite3 dependency targets the separate Node server, not Electron. Rebuilding it against Electron 45 fails on removed V8 APIs; preserve/restore its Node build and skip the package-wide Electron rebuild. Electron dependencies must still pass the packaged runtime tests; this flag does not establish their compatibility by itself.

## Completed verification and installation

2026-11-01: 137 unit tests, typecheck, architecture and public-source audit passed. Three development Electron checks and five packaged Electron checks passed, including real configured manuscript loading without writes (20 paragraphs, 14 loaded images), synthetic editing/saving/reopening and existing reference import/preview. Two existing canonical web editing/formatting checks passed. The separate Node workflow suite passed after restoring better-sqlite3.

The installed production-projects package was backed up to production-projects-before-markup-editor and replaced with release/markup-editor. Restart confirmed the editor runtime ready, no active jobs/unsaved state, and unchanged project inventory. User config and real-content evidence stay outside the source repository.

## User annotations and nearby formatting — 2026-11-01

Selecting a phrase now opens a nearby toolbar with text color, yellow highlighting, memo and check actions. The existing top toolbar still provides the full palette and font sizes. My annotations is separate from existing AI suggestions. Notes/check state persist in a private <canonical>.annotations.json beside the manuscript, never in rendered/published text. Paragraph badges link back to notes. Changed paragraph wording marks an annotation as potentially outdated rather than silently reattaching it. Notes support an optional message with a check; memo-only entries require a message in the UI. Saving a comment does not save unrelated unsaved prose.

Both CLI view and queued review requests include the user annotations as private editorial input. They do not automatically send anything to a model or publish notes.

The editor now allows a user to retain existing unsupported font sizes while saving unrelated color/text changes. Only the same existing invalid phrase/paragraph/size/role combinations are tolerated; newly introduced invalid sizes remain blocked. Agent saves keep strict validation. No automatic size replacement is performed.

Verification: 139 unit tests and type/architecture/public-source checks passed. Electron exercises selecting a phrase, applying nearby highlighting, adding a memo, checking it, source save and reopening with memo/check preserved. Actual manuscript validation remains read-only.

## Executable markup reviews — 2026-11-01

The editor now owns a persistent-request consumer. Opening the markup editor resumes pending/running request receipts, and the review button submits immediately. The consumer calls the existing loopback workflow service's review-markup endpoint; CodexExecutor reuses saved-login/API selection, read-only sandboxing, streamed jobs and observation. No automatic source edits or publishing occur.

Request IDs are idempotency keys in the workflow job store. Restarting a consumer cannot launch the same request twice; reusing an ID with different input is rejected. Duplicate active requests for the same snapshot/annotations return the existing request. A failed request requires an explicit new review action. Dead-process consumer locks are cleaned up; malformed locks/errors are surfaced instead of silently waiting.

Results must contain exactly the requested bundles. Proposed text and emphasis targets are validated against the original paragraph text, and the model receives an enum of valid paragraph IDs. Invalid results fail visibly and are never copied into the review file. Valid results replace only the requested bundles, retain source hashes and add generation time/provider/request provenance. Changed source marks the result stale. Private user annotations are included as context.

The UI polls review-status while open and updates proposals without reloading or discarding unsaved edits. It distinguishes pending, running, completed, failed, cancelled, interrupted and stale; failed/stale jobs expose a retry action. The old draft-only SDK button stays separate. Existing legacy JSON reviews remain until a newly completed review replaces their bundle.

The workflow server must be running; unavailable engines produce a visible failure and retry button. Review jobs can finish while the editor is closed; results are imported when the editor next opens. The editor does not claim rendered-photo inspection: this path reviews supplied wording, markup and notes only.

SDK reference: https://learn.chatgpt.com/docs/codex-sdk (checked 2026-11-01). Tests cover real HTTP-to-SDK job dispatch using a synthetic provider, idempotent submission, stale inputs, unreachable engines, source preservation and Electron status/result refresh without reload.

Live verification: the existing G06 request reached the saved-login SDK. Invalid model outputs that invented emphasis paragraph IDs were rejected, then the prompt/schema was tightened to the actual paragraph-ID enum. The successful rerun returned three validated proposals (price-list check emojis and two menu-name color changes). The consumer persisted them with provenance; it did not apply them to the manuscript. A brief server-startup connection failure is retained as a failed attempt, not hidden or presented as a completed review.

## Proposal-scoped applicability — 2026-11-01

Bundle hashes still indicate whether review context has changed, but no longer lock every actionable proposal in a markup bundle. Text proposals require a unique unchanged before phrase in the same paragraph. Emphasis proposals compare only the style properties they would overwrite over a unique target phrase, using the original source captured with each finding. Existing SDK reviews obtain that source from their immutable saved request receipt; missing historical evidence stays conservative for formatting changes. Reordered or prefixed text outside the target does not block application.

The UI rechecks against unsaved edits immediately before applying. New target wording, ambiguous matches, and user changes to the same style property block only that proposal. Already-applied text/style is detected after save or reload. Other proposals remain available for sequential application. Text replacement preserves existing formatting on unchanged characters, so inserting check emojis does not flatten menu-name colors.

Verification: 144 unit tests, types, architecture and public audit passed. Electron exercises unrelated label recoloring, three sequential proposals, save/reload and duplicate prevention; the real manuscript's proposal buttons are checked read-only against the same applicability calculation. No new model run or manuscript edit is needed to unlock unchanged existing targets.

## Save-state UX — 2026-11-01

The header distinguishes unsaved edits, saving, save failure and saved completion. Clean documents show the actual file modification time and a disabled but clearly labelled “✓ 저장됨” button with an explanation, rather than only “정본 연결됨”. Unsaved review actions say “저장 후 … 검토”; after the save they explicitly confirm that review saved the edits first. A review submission failure after successful save says the source was saved and only review failed. Failed saves retain editable changes and never display saved completion.

Manual reload clears outdated action messages and recreates the editable frame even when the file revision is unchanged, so discarded edits cannot linger in the DOM while the header says saved. File modification time is returned by both legacy and markup stores; review polling does not overwrite the user's edit baseline.

Verification: four browser checks include delayed save, manual save, save failure, successful save followed by failed review, save-before-review messaging and same-revision reload. Type/architecture/public audit and 146 unit tests passed. Existing packaged editor flows are checked separately. Real content is not modified by the UX tests.

## Role-based emphasis and visual quality gate — 2026-11-01

A returned response is no longer a visual-quality pass. Markup reviews include emphasisDecisions for each existing emphasized phrase and each fresh user annotation: semantic role, selected method(s), keep/change/remove/unconfirmed, rationale, considered alternatives, and linked findings. Important unmarked text must also be considered by the reviewer, without numeric emphasis quotas. A change needs a proposal; unresolved decisions cannot pass.

The desktop captures the requested canonical bundles at 360, 390 and 430 CSS px in hidden sandboxed windows. It waits for local photos/fonts, checks load failures, and saves private PNGs beside the request with content hashes and source fingerprint. The canonical source is checked again after capture. Codex SDK receives these exact PNGs as local_image inputs, alongside markup, notes, user annotations and the configured local reviewGuidance Markdown (the live blog setup points to its BLOG.md). Screenshot bytes/hash/type are verified before sending. The model must cite the supplied evidence; width/hash mismatches and missing-width claims are rejected. Labelled SHA256 citations are normalized only after exact width/hash matching.

passed requires a visual pass, no findings and no unresolved emphasis choices. Text-only callers receive awaiting-visual or needs-work; they cannot pass visual quality. Existing historical reviews show visual unverified. The UI separately displays response arrival, visual pass/needs-work/unverified, and source-changed recheck status; it exposes the captured images and per-phrase choices. Applying proposals remains explicit, and changes invalidate the visual receipt without disabling unrelated proposal targets.

Evidence is local-rendered preview, not an assertion of identical Naver publication rendering. The review does not invent original-reference comparisons when those reference images are not supplied. Capture failure is surfaced; it does not silently downgrade to a visual pass.
