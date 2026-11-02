# Workdesk UX and reliability adoption — 2026-11-02

The changes around [Workdesk #41](https://github.com/albireo3754/workdesk/pull/41) are adapted to the Dashboard's existing workflow and development workspace. Workdesk's Claude hub, tmux sessions and company integrations are not dependencies of this application. The implementation uses Dashboard data and boundaries; it does not copy Workdesk's backend.

## What changed

- Workflow history and SDK progress use flat message rows with sender, timestamp, date separators and five-minute grouping. Markdown reports support headings, lists, tables, quotes, line breaks and readable inline/fenced code. Raw HTML is not executed, executable/local URL schemes are excluded and report images do not trigger remote downloads.
- Result entry keeps its text above a compact action toolbar. Drafts belong to their workflow/task while that workspace is mounted, so selecting another run does not mix submissions.
- In developer mode, **화면 검사** or `⌘⇧C` selects an element without activating it. Add a comment to the existing development request, then explicitly start Codex. Source locations are repository-relative; adjacent ancestors from the same file collapse to the innermost location. Text inputs and page contents are not copied into feedback.
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
| #22, #18, #20, #4: search/navigation/settings/terminal tabs | Existing navigation and tabs retained; search accessibility and result limits improved. |
| #9: shortcut discoverability | Existing visible hints retained; inspector adds its shortcut hint. |
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
