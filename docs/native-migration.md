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

## Safe native rebuild publication

A subsequent live authorization run exposed a macOS code-signing failure after a rebuild: copying over the already published CLI executable and signing the helper bundle in place could invalidate cached/mapped signed Mach-O pages. Signature verification on disk alone did not detect the runtime failure.

The native build now prepares a new helper bundle in a unique sibling staging directory, signs it, and verifies its signature before publication. On macOS, `renamex_np(RENAME_SWAP)` exchanges the complete new and previous bundles atomically. The previous bundle is then unlinked without modifying its executable inode. If signing, verification or the swap fails, the current published helper remains untouched. The CLI likewise uses an exclusive new temporary file, verifies it, and atomically renames it into place; it never writes over the old inode.

Run the regression from the repository root:

```sh
node scripts/test-native-rebuild.mjs
```

This script explicitly uses disposable ad-hoc signing unless a signing mode is supplied. It creates a unique socket and temporary support directory and makes only `status` requests; it never requests Photos consent or operates on assets.

Verified on 2026-10-27:

- Intentionally failed signing left both published executable inodes and the live helper identity unchanged.
- A successful rebuild completed while the old helper served **35 direct status responses**. Its PID/instance metadata remained unchanged, and its socket still responded after publication.
- Published CLI and helper executable inodes both changed.
- The new CLI successfully executed `--help` and `status`, avoiding the prior exit-137 signature-cache failure.
- After graceful shutdown, the newly published helper launched with a new instance identity and returned status successfully; cleanup passed again.
- Signing-script regression tests, Node syntax checks, shell syntax check and `git diff --check` passed.

The staged installer fixes runtime-safe local publication; it does not establish trusted distribution signing, notarization, Photos authorization or live asset-operation coverage.

## Standalone installer parity

The migrated standalone installer had two related defects: it still copied signed executables in place, and its separate CLI/app destinations no longer matched the bundled-only helper discovery contract. It now installs a staged, signature-verified CLI/helper pair under `<prefix>/lib/reels-dashboard` and a small atomically published launcher under `<prefix>/bin`. The default prefix is `~/.local`; `PHOTOSINDEX_INSTALL_ROOT` supports a separate absolute destination. The launcher defaults `PHOTOSINDEX_APP_PATH` to the paired helper and honors an explicit override.

Verified with `node scripts/test-native-install.mjs` on 2026-10-27:

- Installation used only a temporary prefix containing spaces and Korean text; `HOME` was not changed and the user's installation was untouched.
- Installed `--help` and `status` worked with `PHOTOSINDEX_APP_PATH` absent.
- Reinstallation atomically replaced CLI, helper and launcher inodes while the same helper PID/instance served **5 status responses** and remained alive.
- The new launcher/CLI returned status without silently restarting the helper.
- A later helper restart resolved the newly installed paired app; an explicit app-path override also selected the requested helper.
- Helper processes and the temporary installation were cleaned up; no Photos permission request or asset operation ran.

macOS can report filesystem paths using `/var` aliases and decomposed Unicode, so the test compares canonical filesystem paths normalized to NFC and requests UTF-8 process output when checking process ownership.
