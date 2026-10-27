# Acceptance matrix

This matrix maps the requested replacement to implemented production paths and observed tests. Native service/CLI tests and synthetic renderer tests are intentionally distinguished from live Photos access.

| Requirement | Production implementation | Evidence | Remaining limit |
| --- | --- | --- | --- |
| Specification before migration | test inventory + UI spec, initial documentation commit | 26 files / 75 methods; `verify:spec` | None for source inventory |
| Delegated workflow | `workflows/photosindex-migration.mjs` | Syntax and runtime dry-run; actual implementation used separate spec/native/React/web-QA/Electron-QA/audit agents | Reusable full script was not rerun over the completed project |
| status / authorize | React connection controls → preload → main → native socket → AppCommandRouter | Native packaged status + web six permission states + Electron authorize fixture | Real OS consent pending locked QA Mac |
| sync | Date control → native IndexRuntime | Original Swift and synthetic UI/IPC; real unauthorized call rejection | Live authorized read-only date test pending |
| groups.list / groups.show | Date/level/group UI → native router/runtime | Swift grouping/router, Chromium, packaged IPC | Live library contents pending consent |
| groups.inspect | Private output allocation → native evidence service; granted preview files | Swift evidence paging/redaction + web first/middle/last/partial/error + packaged IPC | Real PhotoKit/Vision samples pending consent |
| decisions.validate | Native validation of saved/imported original JSON | Swift partition/integrity tests + web invalid/import/selection tests | No fixture-only production validation |
| export.plan / export.apply | Reviewed plan/digest → native export service | Swift planner/applier + web and packaged IPC copy scenarios | Real personal exports not performed in QA |
| move.plan / move.apply | Separate destructive confirmation → native move service | Swift post-upload rehash, failure and journal recovery; web/IPC confirm/cancel/recovery | Actual personal deletion deliberately excluded from automated QA |
| Bundled replacement | Swift helper + CLI in app resources, explicit paths, build/profile-specific socket | Exact packaged helper path/PID/socket + shutdown metadata/PID checks | Native macOS only; no old installation dependency |
| Common React / Sites | shared contracts, web adapter, allowlisted snapshot and HTTPS adapter | Web read-only/mobile/schema cases; unit PUT/credential/redirect/error contract; packaged export allowlist | No particular Site receiver deployed |
| Persistent dashboard | private atomic local JSON through main | Unit persistence/corruption + browser edit/reload + packaged restart | Native multi-date index persistence is not part of upstream parity |
| Web UI QA | separate Playwright Chromium configuration | 42 tests passed; desktop/mobile screenshots reviewed | Synthetic Photos fixtures labeled |
| Electron QA | separate agent, configuration, app launches and real main IPC | Final packaged 7/7, none skipped/flaky | Consent-dependent PhotoKit reading pending |
| Public repository | allowlisted source, licenses, ignore rules, source audit | GitHub PUBLIC and pushed code commit `00c92d69dc5222293448ff5a2740e88356d671da` | CI result tracked in release audit |

The retained 75 original tests are covered individually by [the test specification](photosindex-test-spec.md). The additional native tests raise the migrated total to 85. The production adapter calls the real bundled Swift implementation; the demo adapter is selected explicitly and never silently replaces a missing native service.
