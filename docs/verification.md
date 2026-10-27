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
- [GitHub Actions run 40508791211](https://github.com/albireo3754/reels-dashboard/actions/runs/40508791211) passed all checks for implementation commit `00c92d69dc5222293448ff5a2740e88356d671da` in 3m1s, including fresh install, Swift tests, web tests, Electron fixture tests and app packaging. The real permission-dependent local QA remains separately pending.

Private test profiles, logs, screenshots with runtime paths, helper records and generated app bundles are excluded from Git. Only explicitly reviewed synthetic screenshots are published.

## Rebuild and standalone installation follow-up

A later live check exposed a native build defect that the original fresh-start tests did not cover: overwriting a signed Mach-O in place caused macOS to terminate the CLI with `CODESIGNING / Taskgated Invalid Signature` and an already-running helper with `CODESIGNING / Invalid Page`, despite successful on-disk signature verification. The build now signs and verifies a separate app before atomically swapping its directory, and publishes the CLI by renaming a fresh verified file.

- Independent `test:native-rebuild` passed signing-failure preservation, 36 status responses during rebuild, unchanged running helper identity, fresh CLI execution, and helper restart/cleanup.
- `test:native-install` passed a temporary Korean/spaced install root, paired-helper discovery, repeat installation while the old helper stayed alive, CLI override, and fresh restart. Real user installation paths were not changed.
- The installation test also reproduced a production `NativeClient.dispose` failure under the C locale before the fix. Canonical Unicode paths, a UTF-8 `ps` environment and an exact executable identity check fixed it; the same real-process test passed afterward.
- The final repackaged app passed all 7 Electron tests again in 7.2 seconds. Type checking, the 8 TypeScript tests, original-test preservation and public source audit passed. The Swift test sources and application service implementation were unchanged by these build/lifecycle fixes.
- The old authorization request ended when its helper crashed. A new request from the corrected packaged helper is waiting for macOS consent; its independent status still reports `not-determined`.
