# Application boundary

The desktop app combines an Electron host, a shared React renderer, and a bundled macOS PhotosIndex helper. The existing native application is a migration source, not an installation prerequisite for the finished app.

## Shared interface

The renderer receives a `DashboardBridge` with these operations. It never imports Electron or Node APIs:

- `mode`: `desktop`, `demo`, or `web`.
- `request(method, args)`: the eleven PhotosIndex commands, with string argument maps matching the native protocol.
- `saveDocument(name, data)`: save a decision or plan JSON in private application storage and return its path.
- `openDocument()`: user-selected JSON document, returning `{path, data}` or null for cancellation.
- `chooseDestination()`: choose an export directory.
- `imageURL(path)`: materialize a renderer-safe image URL for evidence returned by this session.
- `loadDashboard()` / `saveDashboard(value)`: persistent project state.
- `exportSnapshot()`: export an explicitly shared, allowlisted dashboard snapshot for the web build.
- `syncSnapshot(endpoint, token)`: send that snapshot to a configured HTTPS endpoint; credentials remain transient.

The Photos/editor Electron host validates methods and arguments, launches its bundled helper and CLI, and isolates the native socket from a separately installed PhotosIndex application. Its media bridge does not expose arbitrary shell execution or unrestricted file reads. The separate desktop-only [development workspace](development-workspace.md) owns explicitly started local terminal sessions for Codex, Claude Code, a shell, preview and checks. Terminal input runs with the user's local privileges; it is not part of the Photos MCP or web snapshot bridge.

## Renderer modes

Desktop mode supports all PhotosIndex workflows. Demo mode uses a clearly marked synthetic fixture and is explicitly selected for browser and Electron UI tests. Web mode loads a versioned snapshot and remains read-only: it cannot authorize Photos, index local media, or apply copy/move operations. Empty or unavailable data must never silently become demo data.

The same React dashboard components are used in desktop and web builds. Sites can host the static web output and snapshot, or supply the documented JSON endpoint. Publishing an actual Site is separate from making this application connectable to Sites.

## Native boundary

Preserve the complete upstream Swift test suite. Keep PhotoKit, Vision, decision validation, export integrity, verified move, and recovery journals in Swift. The native helper stays macOS-specific even though the renderer is portable. A packaged app must locate the included helper, CLI and resources without depending on the migration source checkout.

PhotoKit permission, live library access and packaged process identity require native QA. Fixture UI tests are not evidence of live PhotoKit behavior. Destructive library operations are verified with existing isolated tests; do not delete personal photos as an automated QA step.

## Data ownership

Photo library metadata, evidence, decisions and receipts stay local. New project state is stored under the desktop application data directory. Existing content documents remain authoritative for their prose; this milestone does not rewrite them. Web snapshots contain only selected project titles, stages, next actions, dates and explicit public links; no local paths, source asset identifiers, OCR, exact location or recovery journals.

Native command requests use the current index-run identifiers. Persistent project identifiers are separate, and stale native runs must be re-indexed before new operations. Copy and move plans keep their distinct digests; the UI must show and explicitly confirm the destructive meaning of a move.

## Shortcuts

Workdesk #4, #9, #18, #61 and #65, adapted as described in [Workdesk adoption](workdesk-adoption.md) (section "Workdesk #42–#66 structure and shortcut adoption").

- `src/shared/keymap.ts` is the only key registry. `KEY_ACTIONS` holds the normal bindings in dispatch priority order, `MODE_ACTIONS` the bindings that are live only while their mode is on (the only ones allowed to bind a bare key, currently `exitInspect: "Escape"`), and `HOST_ACTIONS` the subset matched by the Electron host. It is pure TypeScript, so main, preload, renderer and tests share it.
- Keys are matched on the physical `KeyboardEvent.code` (`KeyK`, `Digit1`, `BracketLeft`), so a Korean or other layout does not change a binding. Modifiers must match exactly. IME composition (`isComposing` or Chromium's `keyCode` 229) never matches.
- `HOST_ACTIONS` (`⌘N/T/W/1–9`, `⇧⌘C`) are matched in `src/desktop/main.ts` through `before-input-event`, in development mode only, because the cross-origin preview iframe and xterm own keyboard focus and the top renderer would never see those keys. Main sends only the action name over `workbench:shortcut`; preload passes only string payloads on.
- Every renderer action goes through `ShortcutsProvider` (`src/shared/ui/shortcuts`): one window bubble-phase keydown listener for normal actions, one capture-phase listener for `MODE_ACTIONS` so a live mode pre-empts the focused element, and one capture-phase mouseup listener for the fixed side-button table (button 3 → `goBack`, 4 → `goForward`). Components register with `useShortcut(action, handler, live?)`; the most recently mounted registration wins, and `preventDefault` runs only when the action is live. A live action's auto-repeat is consumed (`preventDefault`) but does not re-run the handler, so holding `⌘[` never falls through to browser history. `⌘K` and `⌘[`/`⌘]`/side buttons are not live while the content form (`dialog[open][data-modal-form]`) or a UI inspect session (`html.reels-inspecting`) is open.
- No component adds its own window or document keydown listener for an app shortcut. The exemptions are in-widget editing keys that are not app actions:
  - search-dialog arrows, Enter, Home/End and Escape (`WorkspaceToolbar`);
  - Enter-to-send in `BlogChat` and the inspector comment box (with the IME guard);
  - `CanonicalBlogEditor` editing keys (⌘S save, Escape cancelling a suggestion request, the `FormattingToolbar` palette's Escape) and the editing keys in `src/app/blog-editor/frame-script.ts`, which run inside the editor frame;
  - focus handling for modal dialogs in `CanonicalBlogEditor` (the content form is a native `<dialog>` in `src/renderer/ProjectDialog.tsx`).
- What a shortcut hint shows equals what the key does. Display and dispatch call the same rule function: `workbenchShortcutTarget` (dev-workspace `model/shortcut-target.ts`) for `⌘1–9`/`⌘W`, `canBack`/`canForward` (workspace-shell `model/navigation.ts`) for `⌘[`/`⌘]`. Holding ⌘ reveals `<ShortcutHint action>`; the held state lives in a separate context, so only hint consumers re-render.
- Key strings are never hardcoded in UI text; they come from `formatKey(keymap[action][0])` in macOS modifier order (`⌃⌥⇧⌘`, so the inspector reads `⇧⌘C`). Labels that name every binding of an action join them, as the search button title does (`검색 (⌘K / ⌃K)`); the inspector's `검사 끝내기 · Esc` reads `exitInspect` the same way.
- When an action is added or changed, update `keymap.ts`, `tests/unit/keymap.test.ts` (including the conflict check) and the shortcut tables in [development workspace](development-workspace.md), [window layout](workspace-shell.md) and the README together.

Known limitation: while the preview iframe (or other cross-origin content) has focus, renderer-scope shortcuts (`⌘K`, `⌘[`/`⌘]`, Escape), the mouse side buttons and the ⌘-hold hints do not work there; only the host actions reach the app.

## Shared helpers and test boundary

- `src/shared/lib/fs.ts` (Node only): `writeFileAtomic`/`writeJsonAtomic(file, value, {mode})` (unique temp file, removed on failure) plus `isMissing` and `readJsonFile(file, parse, fallback)`. `readJsonFile` is used only where the read semantics match exactly. User-facing error text uses `errorMessage(error, fallback?)` from `src/shared/lib/errors.ts`. See [shared JSON file IO](workdesk-adoption.md#shared-json-file-io--workdesk-66).
- `src/shared/ui/useBusy.ts`: `useBusy()` and the pure `createBusyRunner` for screens whose busy wrapper has the same lock, clear and `errorMessage` contract (card news, project grouping). Wrappers with a named busy string or different error formatting keep their own code. See [busy wrapper](workdesk-adoption.md#busy-wrapper-usebusy--workdesk-66).
- `scripts/check-architecture.mjs` also scans `tests/`. A test may import a feature or entity slice only through its index or a `model/**` pure module; `ui/**` and other internals are rejected, and the path is resolved first so `model/../ui` is caught. `model/` is allowed because a slice index may pull in CSS through its UI exports, which `node --import tsx` cannot load. The layer-rank rule still applies only to `src/`.
