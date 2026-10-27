# Reels Dashboard

A local-first Electron + React workspace for Apple Photos discovery, evidence review, verified export/move, and production tracking. The React dashboard is shared with a read-only web build that can be hosted on ChatGPT Sites.

Migration is in progress. Current requirements are grounded in all 75 upstream PhotosIndex tests and its actual SwiftUI/CLI behavior; see [test specification](docs/photosindex-test-spec.md), [UI specification](docs/photosindex-ui-spec.md), and [architecture](docs/architecture.md). The native helper is bundled rather than requiring a separately installed PhotosIndex app.

## Development

Requires macOS 14+, Swift 6, Node 22.12+, and an Apple Development signing identity for stable native Photos permissions.

```sh
npm ci
npm run build:native
npm run build
npm start
```

Browser development: `npm run dev`. The web build is read-only unless explicit synthetic demo mode is selected. No personal library data is included in the repository.

## Verification

```sh
npm run typecheck
npm test
npm run test:native
npm run test:web
npm run test:electron
npm run package:mac
```

See [TASKS](TASKS.md) for actual completion state. Tests using fixtures do not prove live PhotoKit permissions or actual iCloud deletion. Automated QA never deletes personal photos.

## License

MIT. The migrated PhotosIndex native code retains its original license and copyright notice.
