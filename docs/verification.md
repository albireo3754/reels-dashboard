# Verification record — 2026-10-27

## Executed locally

| Scope | Result | Evidence |
| --- | --- | --- |
| Upstream baseline | 75 XCTest tests passed | Original project before migration; full [inventory](photosindex-test-inventory.json) |
| Baseline preservation | 26 original files / 75 methods byte-identical | `npm run verify:spec` compares SHA-256 against the pre-migration specification |
| Migrated Swift | 85 XCTest tests passed | Original75 + runtime configuration/bundled resolution/lifecycle tests; [native report](native-migration.md) |
| TypeScript | 8 tests passed | Snapshot allowlist/schema, private storage/path access, command validation, real socket framing, HTTPS request contract |
| Types and builds | passed | `npm run typecheck`, web+desktop builds, native helper build, macOS app packaging |
| Browser UI | 42 passed, no retries | Real Chromium at desktop/mobile widths; [web report](web-qa.md) |
| Packaged Electron | 7 passed, none skipped/flaky | Real packaged Electron IPC and native origin/lifecycle; [Electron report](electron-qa.md) |
| License/source audit | passed | Original MIT notices preserved, app and helper licenses packaged, no private home paths/secrets/media/runtime databases in source |

The final packaged tests ran after the renderer's final evidence-reference invalidation change. Web screenshots were visually inspected; the README screenshot uses synthetic data only.

## Important limits

- The native helper starts from the new app package on its own socket, and permission failures are correctly returned. Photos permission is currently `not-determined`. Live asset indexing is still pending macOS unlock/consent and is not inferred from synthetic tests.
- Existing Swift export/move tests use controlled materializers, upload verification and deletion stubs. Actual user photos were not exported, moved or deleted during QA.
- Only explicit ad-hoc native signing was possible on this host. `codesign --verify` checks that artifact; it does not establish Developer ID signing or notarization. The outer Electron package is unsigned for local QA.
- The common Sites renderer and snapshot transport contract are implemented. No particular Site or hosted receiver has been deployed, and synthetic sync results are not evidence of a live hosted database update.
- GitHub Actions runs source/build/test/package checks on macOS. Its result is available in the repository Actions tab; local verification does not imply a remote run has already passed.

Private test profiles, logs, screenshots with runtime paths, helper records and generated app bundles are excluded from Git. Only explicitly reviewed synthetic screenshots are published.
