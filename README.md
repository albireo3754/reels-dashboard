# Reels Dashboard

## Workspace routing

The development checkout belongs at `~/side/reels-dashboard`, in a dedicated **Reels Dashboard** local project. `work` denotes KakaoWork-related work; this side project belongs under `side`.

- App features, bugs, Electron/React/Swift code, the bundled editor, tests, packaging and shared-web development: this repository. Start with [AGENTS.md](AGENTS.md) and [TASKS.md](TASKS.md).
- Reel concepts, scripts, captions, account strategy and production history: [the Obsidian reels workspace](~/Obsidian/side/reels/README.md), following its [AGENTS.md](~/Obsidian/side/reels/AGENTS.md).
- Original media and completed exports: their existing Photos/iCloud locations. Keep personal media and production data out of this public source repository.

The existing Obsidian editing CLI and the bundled app engine have separate source ownership. Consult [the engine documentation](docs/editor-engine.md) for app changes; do not silently update both implementations. Cross-workspace links are local navigation aids, not runtime dependencies.

Transition status (2026-10-27): the entire checkout was moved to the new path, preserving Git history, uncommitted changes and source files. The previous path contains redirect documentation only. This move does not establish build or runtime validation at the new path.

A local-first **Electron + React** workspace for Apple Photos discovery, evidence review, verified export/move, and production tracking. The same React dashboard runs as a read-only web build for ChatGPT Sites.

![Synthetic demo of the shared dashboard](docs/images/dashboard-demo.png)

## Features

- Bundled Swift helper: PhotoKit authorization, date indexing, coarse/fine capture groups, paged previews, Vision OCR and privacy flags.
- Complete include/exclude decisions with native validation; reviewed, digest-bound copy and move plans.
- Verified iCloud move and interrupted-move recovery, retaining PhotosIndex's integrity checks and recovery journals.
- Local production dashboard with persistent stages, next actions and public links.
- Explicitly selected shared snapshots, a common web renderer and an HTTPS update-endpoint adapter.
- Isolated Electron renderer, narrow preload API, granted-file access and helper lifecycle management.

All **26 upstream test files / 75 tests** are preserved byte-for-byte. The native component does not depend on a separately installed PhotosIndex app. Apple Photos functionality remains macOS-specific.

## Agent integration

The desktop **개발 작업공간** connects this source checkout to Codex/Claude Code PTY sessions, a local web preview, verification commands and the existing briefing site. Design → implement → review → fix prompts support a user-directed improvement loop. See [architecture, usage and validation](docs/development-workspace.md).

The desktop editor exposes a local stdio MCP server for project lookup, partial editing, previews, rendering and Photos discovery. It uses a private Unix socket and shares the UI editor service. See [MCP setup and tools](docs/mcp-usage.md) and [interface design](docs/agent-interface.md).

## Run locally

Requires macOS 14+, Swift 6 and Node 22.12+.

```sh
npm ci
npm run build:native
npm run build
npm start
```

The normal native build requires an Apple Development signing identity for stable Photos permissions. For a local QA build without that certificate, explicitly opt into ad-hoc signing:

```sh
PHOTOSINDEX_SIGNING_MODE=adhoc npm run build:native
npm run build
npm start
```

Ad-hoc signing is a development option; it is not a notarized distribution. Grant Photos access through the app before indexing. Rebuilds can require renewed macOS permission.

Browser development: `npm run dev`; open `http://127.0.0.1:4173/?demo=1` for explicitly synthetic data. The normal web mode reads `public/snapshot.json` and has no local Photos capabilities. See [Sites integration](docs/sites-integration.md).

Create a local macOS app bundle:

```sh
PHOTOSINDEX_SIGNING_MODE=adhoc npm run package:mac
```

Output: `release/mac-arm64/Reels Dashboard.app` on Apple Silicon. The current package configuration leaves the outer Electron app unsigned and includes the ad-hoc signed native helper for QA. Public signed/notarized distribution needs separately configured certificates.

## Verification

```sh
npm run verify:spec
npm run typecheck
npm test
npm run test:native
PHOTOSINDEX_SIGNING_MODE=adhoc npm run test:native-rebuild
npm run test:native-install
npm run build
npx playwright install chromium
npm run test:web
npm run test:electron
REELS_NATIVE_QA=1 npm run test:electron -- tests/electron/native.spec.ts
npm run audit:public
```

Current local results: **85 Swift tests, 9 TypeScript tests, 42 Chromium UI tests, and 8 packaged Electron tests passed**. See [verification](docs/verification.md), [web QA](docs/web-qa.md), and [Electron QA](docs/electron-qa.md) for coverage and limits. After explicit user consent, live Photos metadata, a bounded one-asset PhotoKit/Vision preview and JPEG decoding passed through the packaged Electron bridge. No personal photos were moved or deleted by automated QA.

## Specification and migration

- [Complete original test specification](docs/photosindex-test-spec.md) and [machine-readable inventory](docs/photosindex-test-inventory.json)
- [UI and command specification](docs/photosindex-ui-spec.md)
- [Architecture and data boundaries](docs/architecture.md)
- [Reusable delegated migration workflow](docs/migration-workflow.md)
- [Native migration](docs/native-migration.md)
- [Acceptance matrix](docs/acceptance-matrix.md) and [release audit](docs/release-audit.md)
- [Progress and remaining work](TASKS.md)

This milestone replaces the PhotosIndex workflow and adds the reusable dashboard. Video timeline editing and a deployed live Sites receiver are not included in this milestone. Public source contains no personal media, production snapshots, credentials, or runtime databases.

## License

MIT. The migrated PhotosIndex native code retains its original license and copyright notice, also included in the app package.
