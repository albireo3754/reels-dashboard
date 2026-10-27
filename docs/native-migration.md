# Native migration evidence

The migration copies only `Package.swift`, `Package.resolved`, `Sources/`, `Tests/`, `AppBundle/`, `scripts/` and `LICENSE` from the PhotosIndex source. It excludes Git history, build products, local run records, private photo data and credentials. The original source checkout is not modified.

## Changes

- Retain all original 75 XCTest methods and their original test files byte-for-byte.
- Add `NativeRuntimeConfiguration` with an isolated Reels Dashboard socket, configurable allowed export root and recovery support root.
- Forward those values through explicit helper launch arguments so LaunchServices does not lose the CLI environment.
- Resolve the helper from the configured bundle path or beside the packaged CLI, never from an unrelated installed PhotosIndex app.
- Replace the native launch window with an AppKit accessory service. Preserve existing SwiftUI source and view model for traceability, while React becomes the product UI.
- Keep native signing identity behavior, PhotoKit usage description and entitlement, and all export/move integrity and recovery checks.
- Produce stable helper and CLI build paths for Electron packaging.

## Evidence status

Verified on 2026-10-27:

- `swift test --package-path native/photosindex`: **81 tests passed, 0 failures** (75 preserved + 4 runtime configuration + 2 bundled path tests).
- All 26 upstream Swift test files match the source byte-for-byte.
- `zsh native/photosindex/scripts/test-sign-app.zsh`: passed.
- `node --check scripts/build-native.mjs`: passed.
- Development signing was attempted and failed with exit 78 because no Apple Development identity was available. No identity was silently substituted.
- Explicit `PHOTOSINDEX_SIGNING_MODE=adhoc node scripts/build-native.mjs`: succeeded; `plutil` and `codesign --verify --deep --strict` passed for the disposable QA helper.
- The freshly built CLI launched the bundled app using a separate QA socket. Process inspection verified the executable was inside this repository's built helper, not an installed PhotosIndex application.
- Live `status --format json` returned protocol 1, app version 0.1.0 and **permission `not-determined`**. The helper was stopped after this check. Photos authorization, live library indexing and system permission UI remain unverified; no personal asset was exported or deleted.

Ad-hoc signing is suitable for explicit local QA, not evidence of stable TCC identity or notarized distribution. Packaged Electron QA must still verify its own embedded helper location and actual permission state.

## Lifecycle follow-up

Electron QA identified a need to track and stop the app's own native process. The helper now writes an owner-only, atomically replaced `helper-instance.json` with schema version, UUID instance identity, PID, executable path and socket path. SIGTERM/SIGINT trigger graceful termination, and cleanup removes only a matching instance record before releasing the socket.

Additional verification on 2026-10-27:

- **85 Swift tests passed, 0 failures**, including four metadata ownership/permissions/symlink tests.
- Rebuilt the explicit ad-hoc QA helper after the lifecycle change.
- A live test launched the bundled helper on a unique QA socket and temporary support root, verified record mode `0600`, directory mode `0700`, process executable and socket arguments, sent SIGTERM, and observed both metadata and socket removal.
- Relaunched the same helper, verified a fresh instance UUID, terminated it again and observed cleanup. No authorization request or Photos asset operation was run.
