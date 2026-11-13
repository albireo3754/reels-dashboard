# Workdesk UX and reliability adoption — 2026-11-02

The changes around [Workdesk #41](https://github.com/albireo3754/workdesk/pull/41) are adapted to the Dashboard's existing workflow and development workspace. Workdesk's Claude hub, tmux sessions and company integrations are not dependencies of this application. The implementation uses Dashboard data and boundaries; it does not copy Workdesk's backend.

## What changed

- Workflow history and SDK progress use flat message rows with sender, timestamp, date separators and five-minute grouping. Markdown reports support headings, lists, tables, quotes, line breaks and readable inline/fenced code. Raw HTML is not executed, executable/local URL schemes are excluded and report images do not trigger remote downloads.
- Result entry keeps its text above a compact action toolbar. Drafts belong to their workflow/task while that workspace is mounted, so selecting another run does not mix submissions.
- In developer mode, **화면 검사** or `⇧⌘C` selects an element without activating it. Add a comment to the existing development request, then explicitly start Codex. Source locations are repository-relative; adjacent ancestors from the same file collapse to the innermost location. Text inputs and page contents are not copied into feedback.
- Search lists up to eight matches per category, shows the total and supports arrow keys, Enter, Home/End and Escape. Opening a record closes the search dialog first. Finder-launched terminals default to UTF-8 only when no locale is configured.
- Workflow completion/failure notifications are based on observed job transitions, with an initial baseline and duplicate suppression. Focused windows and background QA do not show native alerts. Clicking an alert routes to the workflow without reloading the editor.
- Concurrent markup-review requests with the same ID share one SDK start. Reusing an ID with different content is rejected, including while screenshot validation is pending. JSON/error MCP responses share a helper while image-preview responses retain their existing contract.

## Upstream coverage

| Workdesk source | Dashboard outcome |
| --- | --- |
| #38, #41, #24: Slack-style rows and Markdown | Applied to real workflow history and SDK progress; no artificial user/assistant conversation is fabricated. |
| #35–36: UI inspection and source deduplication | Applied through developer-only inspection and explicit request preparation. |
| #40: MCP response deduplication | Applied to desktop and workflow MCP servers. |
| #37: prefixed hub request matching | No equivalent hook/parser exists here. Workflow requests are bound to structured run/task IDs. |
| #39: hub liveness during a turn | No polling-based Claude hub liveness exists here. SDK process/job status remains authoritative, including quiet turns; a concrete concurrent-start race was fixed. |
| #26: background notifications | Applied to workflow job outcomes, with QA suppression and click routing. |
| #25: per-target threads/request state | Existing run/task IDs, history and persisted SDK job lifecycle supply the corresponding isolation and restart status. |
| #31: asynchronous questions | Existing experience/follow-up flow supplies questions and saved answers. Separately developed shared input forms remain their own local work. |
| #22, #18, #20, #4: search/navigation/settings/terminal tabs | Existing navigation and tabs retained; search accessibility and result limits improved. The #4 central keymap and #18 history shortcuts were adopted on 2026-11-04; see "Workdesk #42–#66 structure and shortcut adoption" below. |
| #9: shortcut discoverability | Existing visible hints retained; inspector adds its shortcut hint. The ⌘-hold `ShortcutHint` was adopted on 2026-11-04; see "Workdesk #42–#66 structure and shortcut adoption" below. |
| #6: Finder locale | UTF-8 fallback applied without overriding configured locales. |
| #33: Claude profiles/usage | Existing Codex usage details retained. Claude environment/profile switching is not compatible with the SDK execution model. |
| #34: GitHub full-review/button prompts | Existing centralized development review/fix prompts retained. Company PR review integration is outside the production app. |
| #7, #19, #23, #32 | Claude hub reconnection, KakaoWork and MATRIX-specific integrations have no Dashboard counterpart. |

## Validation and release

- TypeScript and architecture checks, specification preservation and public-source/history audit passed.
- 173 unit tests, 102 Swift tests, 87 Chromium tests and four workflow browser tests passed.
- Final full background Electron run: 52 passed and ten explicit opt-in scenarios skipped. The final 87-test browser run used CI settings. Packaged integration checks also passed for the desktop bridge, PTY, MCP rendering/cancellation, notifications, inspector, shared input forms and three compact canonical-editor scenarios.
- All 13 bundled editor-engine checks passed against the rebuilt runtime.
- Final background Electron inspector and notification routing checks passed. CI's media tests now run after the bundled runtime build; a fresh runner previously failed before FFmpeg existed.
- Independent review found and fixed deferred inspection feedback loss, iframe interaction during inspection, repeated notification routing and workflow draft loss on menu navigation.

Tests use synthetic workflows and background Electron profiles; they do not submit real model work, publish content or modify personal media. Native toast delivery, actual Finder Korean input and subjective visual preference remain manual verification boundaries. Full source-to-runtime native helper and editor builds passed; packaging follows the main merge.

## Native dependency packaging boundary

The Electron bundle calls the workflow service over its existing HTTP client; LangGraph and `better-sqlite3` execute in the separate Node server. The package's `beforeBuild` hook therefore rebuilds only the desktop runtime dependency, `node-pty`, for the requested Electron version/platform/architecture. It returns `false` only after that rebuild succeeds, preventing electron-builder's blanket rebuild from compiling the server-only SQLite binding against Electron. `better-sqlite3` is excluded from the app bundle; its source-checkout Node binding is left intact for the workflow server and tests.

This fixes the observed Electron 45 packaging failure in SQLite's V8 `HolderV2`/`GetPrototypeV2` calls without disabling the PTY rebuild or changing workflow persistence. The hook follows the installed electron-builder 26.18 `beforeBuild` contract and `@electron/rebuild` 4.2.1 `onlyModules` option.

Returning `false` also makes dependency copying the application's responsibility. An explicit file set includes node-pty's JavaScript, license and rebuilt native module/spawn helper, retaining ASAR unpacking. CI launches the finished app and exercises its real PTY after packaging, so a successful archive build alone cannot hide a missing runtime module.

## Socket shutdown regression found during CI

A timed-out client could finish after the socket host was released. Its callback used a weak host reference to return an acquired semaphore slot, allowing libdispatch to destroy a borrowed semaphore and terminate with signal 5. The callback now retains the semaphore independently and always returns its slot. A new lifetime test reproduced the original crash; the fix passed 20 fresh-process repetitions, all 102 Swift tests and preservation of the original 26 files/75 methods.

CI also exercised the canonical editor below its 1080px drawer breakpoint. Successful review requests now open the result drawer; three Electron scenarios explicitly use 960×720 and follow the modal's open/close controls before saving or applying suggestions. The hidden-response failure was reproduced before this one-line behavior fix; all three scenarios and three related formatting/save-state browser checks passed afterward.

The full browser suite also exposed a delayed native dialog-close event clearing a newly reopened search. Search state now closes only through explicit button, backdrop and Escape actions. A deterministic browser regression reproduces the old ordering and verifies the reopened input remains usable; the canonical mobile scenario likewise closes its active review modal before resuming editing.

## Shared JSON file IO — workdesk #66

Upstream #66 gathered settings file IO into `settings/files.ts` and left writers with different semantics alone. Reels follows the same rule in `src/shared/lib/fs.ts` (node-only), next to `main`'s `writeFileAtomic`/`writeJsonAtomic` (commit `eefc077`):

- `isMissing(error)` is true only for `ENOENT`.
- `readJsonFile(file, parse, fallback)` returns `fallback()` for a missing file. Other read errors, the bare `SyntaxError` from `JSON.parse` (not wrapped, no file name added) and errors thrown by `parse` propagate.
- Writes use `main`'s `writeJsonAtomic(file, value, {mode})`: `<file>.<uuid>.tmp`, `flag: "wx"`, the caller's mode, 2-space JSON plus a trailing newline, `rename`, and the temp file removed on failure. `LocalStore.atomic` delegates to it (done on `main`).

An earlier draft of this branch, based on `baef123`, added a parallel `src/shared/lib/json-file.ts` and `src/shared/error-message.ts`. After rebasing onto `main` (`c8e5f5e`) they were folded into `src/shared/lib/fs.ts` and `main`'s `src/shared/lib/errors.ts`, so each job has one helper.

Migrated read sites, because the semantics matched exactly:

| Site | Use |
| --- | --- |
| `src/shared/lib/storage.ts` `LocalStore.load` | `readJsonFile` (empty dashboard on ENOENT) |
| `src/desktop/blog-results.ts` `entries()` | `readJsonFile` (`[]` on ENOENT); the structure-file ENOENT check uses `isMissing` |
| `src/desktop/blog-projects.ts` `readBlogProjects` | `readJsonFile` (`[]` on ENOENT) |
| `src/desktop/workbench.ts` `initialize` | `readJsonFile` (`undefined` on ENOENT) |
| `src/desktop/card-news.ts` `save` previous-plan read | `readJsonFile` (`undefined` on ENOENT) |
| `src/desktop/media-analysis.ts` `load` | `readJsonFile` (empty document on ENOENT; the `schemaVersion`/`projectId` check runs inside `parse`) |
| `src/desktop/media-evidence.ts` `readJson` | `readJsonFile` (`undefined` on ENOENT) |

`src/desktop/media-evidence.ts` and `src/desktop/media-evidence-loop.ts` also write through `writeJsonAtomic` with mode `0o600`; they previously used a local pid-named temp file that was not removed on failure. The only difference is the transient temp name and the failure-path cleanup.

Read sites left alone, with the reason:

| Site | Why it differs |
| --- | --- |
| `src/desktop/route-library.ts` `load` | reads through an open handle with a size limit and realpath/symlink checks; no ENOENT fallback |
| `src/desktop/mobile-briefing.ts` `readMobileBriefingStatus` | swallows every error into a status, has a size limit, and maps ENOENT to `not-configured` |
| `src/desktop/blog-extractor.ts` `readJson` | swallows every error and returns `null` |
| `src/app/blog-editor/review-store.ts`, `src/app/blog-editor/annotations.ts`, `src/desktop/blog-library.ts` | own lock-file protocols around their reads and writes |

## Busy wrapper (`useBusy`) — workdesk #66

Upstream `useBusy` (`shared/lib/async`) is `[loading, run(op, done, failTitle)]` with toast errors and no lock. Reels has no toast layer, so only the contract that reels wrappers already share was extracted:

- `src/shared/ui/useBusy.ts`: `createBusyRunner({setBusy, setError, setNotice?})` is pure (unit-tested in `tests/unit/busy-runner.test.ts`); `useBusy()` returns `{busy, error, setError, notice, setNotice, run}`. `setError` is also returned because migrated screens set errors outside `run`.
- `run(op)`: a lock makes a concurrent call return immediately; on start busy on, error cleared, notice cleared when a setter is present; on failure `errorMessage(e)` from `src/shared/lib/errors.ts` (`Error.message`, else `String(e)`); always unlock and busy off. `run` never rejects.

| Site | Decision | Reason |
| --- | --- | --- |
| `features/card-news/ui/CardNews.tsx` | Migrated | Identical lock, clear and format contract. UI busy-wrapping only; the fixed template contract (`docs/card-news.md`, template renderer, presets, `model/`) is untouched. |
| `features/project-grouping/ui/ProjectGrouping.tsx` | Migrated | No lock or notice before, but both `run()` callers are buttons inside `<fieldset disabled={disabled \|\| busy}>`, so after a render the lock is not observable. The only difference is that two clicks dispatched in the same task before re-render now start one operation instead of two. The hook's notice is unused here. |
| `renderer/App.tsx` `run(name, fn)` | Left alone | `busy` holds the operation name (string) that the UI displays, and the guard reads that state inside a `useCallback([busy])`, not a ref. |
| `renderer/Editor.tsx` `run(name, op)` | Left alone | Named busy plus a `STALE_PROJECT` check that sets the conflict state before formatting the error. |
| `features/dev-workspace/ui/DevWorkspace.tsx` `run(fn)` | Left alone | Same lock (a `pending` ref) and clears, but formats errors with `String(e)` (an `Error` shows as `Error: …`), so migrating would change visible text. |

## Workdesk #42–#66 structure and shortcut adoption — 2026-11-04

Upstream [Workdesk #66](https://github.com/albireo3754/workdesk/pull/66) (`3a462d4`) reorganised duplicated code, tests and folders, and the shortcut items before it built a central keymap with ⌘-hold hints. Reels adopts the structure and patterns, not Workdesk's KakaoWork, Jira, GHE, Claude hub, tmux or MATRIX integrations. The rules are in [architecture: Shortcuts](architecture.md#shortcuts) and [shared helpers and test boundary](architecture.md#shared-helpers-and-test-boundary); user-facing keys are in [window layout](workspace-shell.md#단축키--2026-11-04) and [development workspace](development-workspace.md#작업공간-탭과-단축키).

### Coverage

| Upstream item | Status | Reels outcome |
| --- | --- | --- |
| #66 settings file IO (`settings/files.ts`) | Partially applied | `readJsonFile`/`isMissing` added to `main`'s `src/shared/lib/fs.ts` (which already had the atomic writers), migrated in `src/shared/lib/storage.ts`, `src/desktop/blog-results.ts`, `src/desktop/blog-projects.ts`, `src/desktop/workbench.ts`, `src/desktop/card-news.ts`, `src/desktop/media-analysis.ts`, `src/desktop/media-evidence.ts` (reads; `media-evidence.ts` and `media-evidence-loop.ts` writes use `writeJsonAtomic`). Left alone: `src/desktop/route-library.ts`, `src/desktop/mobile-briefing.ts`, `src/desktop/blog-extractor.ts` reads and the lock-file stores. Reasons in [Shared JSON file IO](#shared-json-file-io--workdesk-66). |
| #66 backend shell module split | Not applicable | Workdesk's shell/tmux launcher. Reels' PTY launch already lives in `src/desktop/workbench.ts` and `src/desktop/workbench-providers.ts`. |
| #66 shared UI pieces (Badge, ListSection/section header, LoadMore, lnb button variant) | Not applicable | SectionHeader: reels' `SectionHeader` (`ui-section-header`, `src/shared/ui/primitives.tsx`) and the screens' `section-heading` markup have different class contracts, so merging would change styling. LoadMore: the two sites (`src/renderer/App.tsx` "콘텐츠 더 보기", `src/features/content-board/ui/ContentMediaCard.tsx` "자료 더 보기 (n/total)") use different text formats. Badge: reels already has a shared `Badge` (`ui-badge` with `data-tone`) in `src/shared/ui/primitives.tsx`; upstream's Tailwind tone classes add nothing. The lnb button variant has no reels counterpart. |
| #66 KakaoWork `pagedSync` | Not applicable | Company integration. |
| #66 tab data hooks (`useBackendState`, `useBusy`) and Claude send helpers (`sendNote`, `commentPane`) | Partially applied | `useBusy` / `createBusyRunner` in `src/shared/ui/useBusy.ts`, migrated in `src/features/card-news/ui/CardNews.tsx` and `src/features/project-grouping/ui/ProjectGrouping.tsx`. Left alone: `src/renderer/App.tsx`, `src/renderer/Editor.tsx`, `src/features/dev-workspace/ui/DevWorkspace.tsx`; reasons in [Busy wrapper](#busy-wrapper-usebusy--workdesk-66). `useBackendState`, `sendNote` and `commentPane` serve Workdesk's backend subscriptions and Claude hub; not applicable. |
| #66 request desk and MCP fake deps | Not applicable | Claude hub threads/decisions. Reels workflow requests use structured run/task IDs. |
| #66 navigation/settings/tab model hooks and one `engineSwitch` rule for dispatch and display | Applied (pattern) | One rule per shortcut for dispatch and hints: `canBack`/`canForward` in `src/features/workspace-shell/model/navigation.ts`, `workbenchShortcutTarget` in `src/features/dev-workspace/model/shortcut-target.ts`. The engine switch itself is #52. |
| #66 shortcuts provider moved to `shared/lib/shortcuts`, keybindings to `settings/` | Applied | `src/shared/keymap.ts` (only registry) and `src/shared/ui/shortcuts` (`ShortcutsProvider`, `useShortcut`, `ShortcutHint`). The old `src/shared/workbench-shortcuts.ts`, `src/features/dev-workspace/model/shortcuts.ts` and `model/useWorkbenchShortcuts.ts` were deleted. |
| #66 renderer and backend tests rewritten through public interfaces | Partially applied | `scripts/check-architecture.mjs` scans `tests/` and allows only slice indexes and `model/**`. `src/features/blog-workspace/ui/import-spec.ts` and `src/features/workspace-shell/navigation.ts` moved to `model/`. Left alone: the private-member patches `(service as any).prepare` in `tests/unit/media-analysis.test.ts` (follow-up). Workdesk's test-only `shared/ui/testing.tsx` row helper has no reels counterpart. |
| #66 `SendKind` and thread-key contract, doc path sync | Partially applied | Doc paths synced: this section, [architecture](architecture.md), [development workspace](development-workspace.md) (module table), [window layout](workspace-shell.md) and the README. `SendKind`/thread keys are Claude hub contracts; not applicable. |
| #4 YAML keymap, `KEY_ACTIONS`, `useShortcuts`, physical `e.code` keys | Partially applied | `KEY_ACTIONS`, `MODE_ACTIONS`, `HOST_ACTIONS`, exact-modifier `e.code` matching with the IME guard, and `useShortcut`. Left alone: the per-user YAML keybinding file (not ported; the defaults are code) and Workdesk's renderer-only host matching (reels keeps `before-input-event` in `src/desktop/main.ts` because the preview iframe and xterm own focus). |
| #9 ⌘-hold `ShortcutsProvider` and `ShortcutHint` | Applied | Hints on the toolbar (search, inspect, terminal, back/forward), the drawer (tabs, close, new terminal) and the sidebar screens in development mode. Not shown while the preview iframe has focus. |
| #18 back/forward history and mouse buttons | Applied | History already existed (2026-10-31). Added `⌘[`/`⌘]` and mouse buttons 4/5 (`MouseEvent.button` 3/4) through the same `canBack`/`canForward`, not live while the content form or an inspect session is open. Holding the key consumes auto-repeat without stepping again. The titlebar-as-header part was adopted on 2026-10-31. |
| #35 `⌘⇧C` inspector | Applied | Adopted on 2026-11-02; now the `inspectUi` host action. The hint and tooltip read `⇧⌘C` (macOS modifier order from `formatKey`). |
| #51 `⌘0` add-tab menu and drag reorder | Not applicable | Reels' sidebar is a fixed screen list with no user-managed tabs. |
| #52 `⌘⇧E` Claude ↔ Codex engine switch | Not applicable | Claude Code is not an active workbench tool. Its shared-rule pattern is applied through `workbenchShortcutTarget`. |
| #54 notification request and decision answer CLI | Not applicable | Claude hub decisions. |
| #61 Esc ends inspect via `MODE_ACTIONS` | Applied | `exitInspect: "Escape"` in a capture listener; `UiInspector` registers it while mounted and closes once. Exact modifiers, no auto-repeat. |
| #63 tab list filter chips (all / in progress / replied) | Not applicable | Filters Claude hub threads. Reels' content board already has its own stage filters. |
| #65 ⌘-hold scroll jump in ChatPane, inspector comment Enter-to-send | Applied | The ⌘-held state is a separate context, so only hint consumers re-render and chat panes do not jump. The comment box sends on Enter, with Shift+Enter for a new line, the IME guard (`isComposing`, keyCode 229) and an in-flight ref. |
| #42–#50, #57–#60, #62 (Jira workspaces, KakaoWork theme, hub decisions, tmux terminals, hub approval alerts, Codex desktop/hub launch, tab manager and prompt tabs, GitHub badge, learning cleanup, harness-setup skill) | Not applicable | Company or Claude hub integrations with no Dashboard counterpart. |

### Behaviour changes

- `⌘K` / `Ctrl+K` now matches the physical K key, and modifiers must match exactly: `⇧⌘K`, `⌃⌘K` and similar no longer open search.
- The inspector closes only on plain `Esc`; `⇧Esc`, `⌘Esc` and auto-repeat no longer close it. `Esc` from the comment box closes the dialog and the inspector together and does not reach the editor's or a modal's Escape handling.
- The inspector tooltip reads `화면 검사 (⇧⌘C)` instead of `⌘⇧C`.
- `ProjectGrouping`: two clicks in the same task before re-render now start one operation instead of two.
- The search button title is built from the keymap and reads `검색 (⌘K / ⌃K)` instead of `검색 (⌘K / Ctrl+K)`.
- On viewports at or below 560px the toolbar still hides its static `<kbd>` labels, but ⌘-hold hints stay visible.
- `⌘[`/`⌘]` work while the history or search dialog is open, because only the history position, the content form and inspect mode gate them.

### Follow-ups

- media-analysis monkey-patch: replace `(service as any).prepare` in `tests/unit/media-analysis.test.ts` with an injected seam once the main checkout's media-analysis work lands.
- The inspector comment box is not focused when its dialog opens (existing behaviour).
- Renderer shortcuts, mouse side buttons and hints have no host path while the preview iframe has focus or is under the pointer.

### Validation

Rebased onto `main` `c8e5f5e` (fast-forward of the base, then the working changes reapplied with conflicts resolved in `storage.ts`, `CardNews.tsx`, `ProjectGrouping.tsx`, `WorkspaceToolbar.tsx` and `App.tsx`). Run in this worktree with Node 26 (`/opt/homebrew/bin`), 2026-11-04:

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed. |
| `npm run check:architecture` | Passed; 145 test files scanned. |
| `npm test` | 284 tests: 283 passed, 1 failed. The failure is `tests/unit/face-mosaic.test.ts`, which needs the bundled FFmpeg runtime (`native/editor-engine/.build/runtime/bin/ffmpeg`) that this worktree has not built. |
| `npm run test:web` (headless Chromium, full suite) | 133 passed. The new `workspace-shell.spec.ts` cases fail when the content-form guard, the auto-repeat consumption or the compact-toolbar CSS fix is reverted. |
| `npm run build`, then `tests/electron/workbench-tabs.spec.ts` and `tests/electron/ui-inspector.spec.ts` (background QA) | Passed (6). |

Not run: the full Electron suite, Swift tests, editor-engine checks, packaging, `verify:spec`/`audit:public` after the rebase, and manual checks of real mouse side buttons and Korean IME input.
