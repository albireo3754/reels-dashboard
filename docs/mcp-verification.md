# MCP verification

Local verification, 2026-10-28. Personal media and Photos deletion were not used. The evidence below distinguishes real engine execution from fixture tests.

| Check | Result |
| --- | --- |
| TypeScript and FSD public API/layer checks | Passed after module extraction and MCP wiring. |
| Node unit tests | 17 passed, including actual stdio discovery, schema rejection, socket authentication, offline/reconnect handling and independent settings patches. |
| Original Swift specification | All 26 upstream files / 75 methods remain byte-identical. |
| Swift tests | 95 passed at the current checkout path. A stale pre-move debug module cache was moved aside and rebuilt. |
| Editor engine tests | 11 passed against the bundled runtime, including actual rendering and HDR fixtures. |
| Existing web suite | 58 passed; separately edited subtitle-file features are outside this MCP PR. |
| Development Electron | 10 passed: six desktop boundary tests, two real editor tests and two real MCP tests. One opt-in personal Photos test was intentionally skipped. |
| Project config discovery | The content project's `codex mcp list` reports `reels_dashboard` enabled with the intended stdio command and timeouts. |
| Packaged app and installed-command verification | Pending final build. |
| PR CI and merge | Pending. |

The real MCP tests use the built `dist-mcp/server.mjs`, the SDK client, a non-demo Electron app and bundled FFmpeg/Python engine. They import generated H.264/AAC footage, patch independent settings, open the project in the UI, check dirty-state and revision rejection, decode video/cover PNGs, render video/audio/cover/manifests, prevent output overwrite, preserve source hashes, cancel an actual in-progress process, and reconnect across MCP disconnect and app restart. Settings reuse creates a new project. Cover-only export creates an actual PNG.

The returned MCP preview images were also inspected: the place guide is centered together, body captions remain independent, and the cover uses a left-aligned hook/signature. These are synthetic test images; they do not prove visual quality on all personal footage.

Build preparation uncovered compiler caches and media-library install names containing the previous checkout path. Generated caches are kept outside the checkout while rebuilding; original media, settings and the previous packaged app are not deleted. Successful rebuild and package checks will be recorded after completion.

Runtime limits: MCP uses a private local socket; no cloud access is established. Jobs are app-owned but not crash-persistent. A new or reconnected Codex chat must load a newly installed MCP configuration. Source paths, credentials, session transcripts and user-specific project configuration are not included in this public repository.
