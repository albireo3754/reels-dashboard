# Release audit — 2026-10-27

## Publication

- Repository: https://github.com/albireo3754/reels-dashboard
- Visibility: PUBLIC, confirmed with GitHub CLI after push.
- Published implementation commit: `00c92d69dc5222293448ff5a2740e88356d671da`; local and remote `main` matched immediately after publication.
- CI: https://github.com/albireo3754/reels-dashboard/actions/runs/40508791211 — SUCCESS, all install/type/spec/unit/native/build/web/Electron/package/public-audit steps passed in 3m1s.
- Only reviewed code, specifications, tests, license notices and one synthetic UI screenshot were published. Source audit passed before publication and again after adding the acceptance/release records. Original PhotosIndex source checkout remained unchanged.

## Verified implementation and artifacts

The [acceptance matrix](acceptance-matrix.md) covers all eleven PhotosIndex commands and the shared dashboard boundary. Local results are 85 Swift tests, 8 TypeScript tests, 42 browser UI tests and 7 packaged Electron tests passed. The complete original test suite remains byte-identical.

A local Apple Silicon app exists at `release/mac-arm64/Reels Dashboard.app`. Its resources include the native helper, CLI and native MIT notice; the app archive includes the main MIT license. Packaged QA confirmed it uses its own helper process/socket and cleans the owned process up after a native permission failure. The package is a local QA artifact, not a notarized public release binary.

## Unverified / awaiting user state

The QA Mac is locked, and the new helper's Photos authorization is `not-determined`. A permission request is pending on the host. The user must unlock macOS and approve Photos access before the harmless live read-only indexing check can finish. Authorization was not bypassed or inferred from the older installed app.

Actual personal media deletion is intentionally not an automated QA step. Verified-move contracts use the preserved Swift tests and synthetic UI/IPC tests. No live Site receiver was deployed; the requested common renderer and connection adapter are available with a documented hosting contract.

The broader goal remains open for the consent-dependent live check. Publishing the repository and passing fixture tests do not erase that remaining verification item.

## Follow-up correction

Fresh-build QA did not initially catch in-place signed executable replacement during a live rebuild. That defect was reproduced from macOS crash evidence and corrected with staged, verified, atomic publication. The provided standalone installer was also corrected to keep its CLI and helper together and avoid in-place replacement. Live rebuild/install regression scripts are now CI and workflow gates. A Korean-path/C-locale production lifecycle failure was reproduced, fixed, and retested. See the follow-up in [verification](verification.md). The final updated local package passed 7/7 Electron tests; the replacement Photos consent request remains pending.

The follow-up implementation commit `2dd56d634534eecbfc6495020dbda318417841c3` passed [GitHub CI run 40512046668](https://github.com/albireo3754/reels-dashboard/actions/runs/40512046668). A fresh no-cache API read confirmed `completed/success`. Remote logs show 52 uninterrupted status responses during rebuild, successful temporary reinstall and production Unicode-path lifecycle checks, then successful web/Electron tests, app packaging and public-source audit. The remaining local consent-dependent check is unchanged.
