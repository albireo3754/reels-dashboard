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

The Electron host validates methods and arguments, launches only its bundled helper and CLI, and isolates the native socket from a separately installed PhotosIndex application. The bridge does not expose arbitrary shell execution or unrestricted file reads.

## Renderer modes

Desktop mode supports all PhotosIndex workflows. Demo mode uses a clearly marked synthetic fixture and is explicitly selected for browser and Electron UI tests. Web mode loads a versioned snapshot and remains read-only: it cannot authorize Photos, index local media, or apply copy/move operations. Empty or unavailable data must never silently become demo data.

The same React dashboard components are used in desktop and web builds. Sites can host the static web output and snapshot, or supply the documented JSON endpoint. Publishing an actual Site is separate from making this application connectable to Sites.

## Native boundary

Preserve the complete upstream Swift test suite. Keep PhotoKit, Vision, decision validation, export integrity, verified move, and recovery journals in Swift. The native helper stays macOS-specific even though the renderer is portable. A packaged app must locate the included helper, CLI and resources without depending on the migration source checkout.

PhotoKit permission, live library access and packaged process identity require native QA. Fixture UI tests are not evidence of live PhotoKit behavior. Destructive library operations are verified with existing isolated tests; do not delete personal photos as an automated QA step.

## Data ownership

Photo library metadata, evidence, decisions and receipts stay local. New project state is stored under the desktop application data directory. Existing content documents remain authoritative for their prose; this milestone does not rewrite them. Web snapshots contain only selected project titles, stages, next actions, dates and explicit public links; no local paths, source asset identifiers, OCR, exact location or recovery journals.

Native command requests use the current index-run identifiers. Persistent project identifiers are separate, and stale native runs must be re-indexed before new operations. Copy and move plans keep their distinct digests; the UI must show and explicitly confirm the destructive meaning of a move.
