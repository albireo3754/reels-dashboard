# Local content and footage links

Production cards now support explicit project grouping, edit ownership and output history. See [the project model, JSON Schema and merge workflow](production-projects.md).

## Board search, sorting and views — 2026-10-28

- On every launch the board starts with unfinished work (all stages except published), an empty search and all date bases. The initial sort is date descending, with oldest-first, Korean/numeric title order and production priority available. Production priority is review → editing → selected → captured → idea → published; ties use date descending and then title/ID. Sorting never rewrites the stored project array.
- Search matches title, next action, private notes and resource labels. Space-separated terms are combined, with Unicode normalization and case-insensitive matching. Stage and explicit date-basis filters combine with search. Publication, capture, record and unspecified dates remain distinct; a published stage does not turn a record date into a publication date.
- The three summary cards prioritize active, review and published content. All content is a secondary toolbar action and the last stage-filter option. Reset returns to active work; the empty-results action explicitly opens all content.
- Card and compact list views retain media access and project editing. Matching results are sorted before rendering the first 12, with 12 more per action. Changing a view control resets this limit.
- Sort and card/list preferences are restored from localStorage per desktop/demo/web mode. Search and filters start fresh on launch, even when an earlier session selected all content. Dashboard records and shared snapshots are unchanged. Mobile controls wrap without horizontal scrolling.

Validation: 3 query unit tests, 8 board/dashboard browser scenarios, type/FSD/build checks, and 2 packaged Electron scenarios for real local records, restart preference persistence, byte-identical dashboard storage and mobile briefing behavior passed. Desktop/mobile synthetic screenshots were inspected. Package: `release/board-ux-final/mac-arm64/Reels Dashboard.app`. The dashboard uses a compact mobile briefing summary so search and the first content row are visible at the standard desktop window size; settings retain the detailed explanation. The new app was launched with the existing local library.

The production dashboard can register existing completed work and capture folders without importing them into the editing engine. Registration stores references, creates no proxy or duplicate media, and never renders or publishes. Editing projects and production records remain distinct.

## Active-first dashboard — 2026-10-31

Validated with 4 query unit tests, 5 board browser scenarios, type/architecture/build checks and 1 packaged Electron test (restart, restored list preference, published exclusion and byte-identical records). Inspected mobile controls and the live desktop screen. Built and launched `release/active-board/mac-arm64/Reels Dashboard.app` with the existing profile. Native helper/editor runtime were reused; only dashboard code changed.

## MCP flow

1. Call `reels_get_app_state`, then `reels_list_projects` for current production entries and `dashboard.updatedAt`.
2. Use `reels_list_local_media` on an explicitly chosen directory. It returns one paginated level of media files and directories; it does not read media contents or recurse through symlinks.
3. For an existing entry, call `reels_get_content` to inspect metadata, resources and current revision.
4. Call `reels_upsert_content` with a stable content ID, current dashboard `expectedUpdatedAt`, and the full content record. Resources are an explicit replacement list. A matching ID updates the same record; a different ID creates a record. Re-read after a stale-revision error; do not blindly retry uncertain writes.
5. Call `reels_get_content` to confirm persisted references and their availability. Missing or inaccessible resources are reported per link without dropping the stored reference.

A record contains a title, date and date basis (`capture`, `publication`, or `record`), production stage, next action, public URL, private notes and local resource references. `captured` means footage exists but has not yet been selected. A completed local export is not evidence of publication. Record dates must not stand in for actual upload dates.

Resource roles are `footage`, `final`, `cover`, `draft`, `document` and `folder`. Every new reference must resolve to an existing file/directory of the allowed type. Canonical paths and roles prevent duplicate links. Media archives are supported for completed carousel bundles. An explicit folder link is not a claim that every file in it is a selected final asset.

## State and UI

Writes are serialized with existing editor/dashboard writes. Revision checks prevent MCP or an old UI form from overwriting newer dashboard changes. Registration emits an event so open dashboard cards update immediately. Cards expose local notes, resource labels and a button revealing only a registered resource in Finder. No arbitrary path-opening IPC is provided.

New entries are private (`shared: false`); existing sharing is preserved. Neither resource paths nor private notes are included in exported/shared snapshots, even when an entry is shared. Imported web snapshots discard local-only fields. Content prose stays in the content workspace; link its canonical document rather than copying it into the app.

## Verification

`tests/unit/content-library.test.ts` covers persistence, stable IDs, stale/concurrent writes, missing sources, snapshot privacy and bounded folder listing. `tests/electron/content-library.spec.ts` uses a real stdio MCP client and non-demo Electron app with a synthetic local file; it verifies registration, UI updates, restart persistence, stale rejection and that no editing project/proxy is created. Tests use an isolated temporary profile.

## Content board previews — 2026-10-28

The board now shows a representative thumbnail (cover, then final media, then another linked visual), three small media previews, current stage and next action directly on each card. The viewer keeps progress visible above a side-by-side player and paginated media grid. Its structure draws on the Naver Clip dashboard's categorized artifact list/player interaction, implemented against this app's local resource and Electron boundaries rather than importing that application's server or database.

- Select a thumbnail or **미디어 보기** to open the viewer. Choose another file to switch between video, image and audio. Escape or Close releases the player and restores focus to the card.
- Open a linked folder to browse its media and subfolders, 24 entries at a time. Breadcrumbs return to earlier folders; role filtering applies to the loaded page. A folder reference is not treated as a selected/final deliverable. Empty folders and missing links remain explicit.
- Thumbnails use macOS thumbnail rendering. Images open at a bounded preview size. Only a selected video is converted by the existing bundled editor engine into a cached H.264/AAC playback copy. First playback can take time, especially for long/iCloud videos. Original files and their HDR content are unchanged; the preview proxy follows the existing SDR playback policy.
- Future editor imports link their source to their board record. Successful exports add the video as a **draft** and the PNG as a cover, then update the board to review. Exporting does not assert final approval or publication. Older editing records are not migrated automatically.

Media reads are restricted to current registered files or descendants of linked folders. Traversal, hidden descendants, symlink escapes, unsupported types and removed registrations are rejected. Opaque session URLs support Range/HEAD for seeking and reject foreign origins. The board does not expose a directory server or arbitrary path-reading IPC. Private references and cached media are still absent from shared snapshots; web mode shows progress without opening local media.

Validation: 30 unit tests, 6 board/dashboard browser tests, and 3 packaged Electron scenarios covering actual MOV/PNG thumbnails, playback/seek, folder navigation, missing media, original preservation, MCP registration and automatic export linking. Synthetic media only; desktop and narrow-screen layouts inspected. A separate local app bundle is prepared at `release/content-board/mac-arm64/Reels Dashboard.app` so the running app is not overwritten.
