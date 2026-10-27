# Release audit — 2026-10-27

## Publication

- Repository: https://github.com/albireo3754/reels-dashboard
- Visibility: PUBLIC, confirmed with GitHub CLI after push.
- Published implementation commit: `00c92d69dc5222293448ff5a2740e88356d671da`; local and remote `main` matched immediately after publication.
- CI: https://github.com/albireo3754/reels-dashboard/actions/runs/40508791211 — SUCCESS, all install/type/spec/unit/native/build/web/Electron/package/public-audit steps passed in 3m1s.
- Only reviewed code, specifications, tests, license notices and one synthetic UI screenshot were published. Source audit passed before publication and again after adding the acceptance/release records. Original PhotosIndex source checkout remained unchanged.

## Verified implementation and artifacts

The [acceptance matrix](acceptance-matrix.md) covers all eleven PhotosIndex commands and the shared dashboard boundary. Local results are 85 Swift tests, 9 TypeScript tests, 42 browser UI tests and 8 packaged Electron tests passed. The complete original test suite remains byte-identical.

A local Apple Silicon app exists at `release/mac-arm64/Reels Dashboard.app`. Its resources include the native helper, CLI and native MIT notice; the app archive includes the main MIT license. Packaged QA confirmed it uses its own helper process/socket and cleans the owned process up after a native permission failure. The package is a local QA artifact, not a notarized public release binary.

## Final live acceptance and deliberate limits

The user granted Photos access. The packaged helper returned `authorized`; an empty-date query and a bounded nonempty-date query passed, including list/detail consistency. One real PhotoKit preview was generated and decoded through the production file-grant bridge, with no Vision analysis failure or partial-evidence warnings. Temporary evidence was cleaned up; no personal capture dates, identifiers, filenames, OCR or images were published.

Actual personal media deletion is intentionally not an automated QA step. Verified-move contracts use the preserved Swift tests and synthetic UI/IPC tests. No live Site receiver was deployed; the requested common renderer and connection adapter are available with a documented hosting contract.

The consent-dependent acceptance gate is now satisfied by actual packaged-app execution, not inferred from synthetic tests. Developer ID signing/notarization and deployment of a particular hosted Sites receiver remain outside this source-publication milestone.

## Follow-up correction

Fresh-build QA did not initially catch in-place signed executable replacement during a live rebuild. That defect was reproduced from macOS crash evidence and corrected with staged, verified, atomic publication. The provided standalone installer was also corrected to keep its CLI and helper together and avoid in-place replacement. Live rebuild/install regression scripts are now CI and workflow gates. A Korean-path/C-locale production lifecycle failure was reproduced, fixed, and retested. See the follow-up in [verification](verification.md). The final updated local package passed 7/7 Electron tests; the replacement Photos consent request was later granted, as recorded above.

The follow-up implementation commit `2dd56d634534eecbfc6495020dbda318417841c3` passed [GitHub CI run 40512046668](https://github.com/albireo3754/reels-dashboard/actions/runs/40512046668). A fresh no-cache API read confirmed `completed/success`. Remote logs show 52 uninterrupted status responses during rebuild, successful temporary reinstall and production Unicode-path lifecycle checks, then successful web/Electron tests, app packaging and public-source audit. The later authorized live check is recorded above.

## Authorized preview correction

The first real preview revealed that the native response and Node canonical grant can represent the same macOS file through different parent aliases. The production file reader now resolves the path before checking the existing canonical grant, while still rejecting ungranted files and symlinks at the file itself. A focused unit test and the real preview test failed before this correction and passed afterward. The corrected packaged app passed all eight tests; a stricter single-preview check also confirmed the Vision warning-free path. The manually started authorization helper was stopped after its request finished, without revoking the user's Photos permission.

## Final publication verification

The final production correction and opt-in live test are in commit `0f5c446866fe8a9fc451c65fa80144127bc3f3e5`. [GitHub CI run 40518829999](https://github.com/albireo3754/reels-dashboard/actions/runs/40518829999) completed successfully in 3m22s, including original-test preservation, unit/native tests, live-process rebuild/install regressions, web/Electron fixture checks, packaging and public audit. The separate authorized local packaged suite passed 8/8, and the stricter live Vision check passed 1/1. All requirements of the PhotosIndex replacement, shared Sites-ready renderer, delegated workflow, testing and public-source publication milestone have supporting evidence.
