# Desktop production workflow integration — 2026-10-31

The previously uncommitted production features are integrated with the compact workspace shell, Developer ID helper signing and Photos location/OCR MCP search.

## Included

- Active-first searchable content board, registered media browsing and previews.
- One production card per content, edit ownership, merge backups and export history.
- Fixed-template card-news photo/video composition, music, preview and MP4 export.
- Video/cover template controls, standalone follow cards and reviewed SRT/WebVTT import/export.
- Registered capture-map documents and owner-private briefing synchronization contracts.
- Branded desktop resources and read-only object/Instagram client packages. Instagram credentials/live integration remain explicitly unconfigured; mobile media serving remains disabled.

## Verification

- Typecheck, architecture boundaries, original native specification preservation and public source audit passed.
- TypeScript unit tests: 76 passed. Browser tests: 75 passed.
- Developer Electron suite: 35 passed, 6 explicit opt-in scenarios skipped (headed activation, installed Codex and live Photos access).
- Packaged Electron: 5 passed, covering typed preload, MCP registration, card-news audio/video output, standalone cover output and route-map playback/persistence.
- Editor engine: 13 passed; fixed-card templates: 7 passed. Photos search native suite previously passed 101 tests; stable signing/rebuild/install was separately verified during the Developer ID transition.
- Initial aggregate Electron failures exposed stale UI expectations and an outdated bundled engine. Tests now use the current navigation, active-first filter and typed preload contract. The engine was rebuilt from source. Hidden audio QA is muted to avoid physical output-device dependence and passed three consecutive runs; exported music is checked independently.
- Personal media, operational snapshots, credentials and local search evidence are excluded from the public repository. The icon resource was inspected and contains only branding.

## Local application

Build output: `release/completed-20261031/mac-arm64/Reels Dashboard.app`.
The current app was backed up and replaced at the existing `release/production-projects/mac-arm64/Reels Dashboard.app` path. Developer mode is retained, the existing user-data directory is reused, and all prior project IDs were verified after restart. MCP reports the editor runtime ready and no unsaved or active render work.

Photos permission is an OS decision separate from successful signing. A first transition to the Developer ID identity may require a one-time authorization; the build does not modify TCC or approve dialogs automatically. Subsequent builds keep the same designated signing requirement.

Deliberately deferred mobile source-media serving and mobile packaging remain backlog items. Native menu-bar appearance is not claimed from background automated tests. Previous per-feature build paths are historical artifacts, not the current running application.
