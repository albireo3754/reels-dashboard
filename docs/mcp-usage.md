# Reels Dashboard MCP

The local MCP server lets an agent work with the running desktop editor. Electron remains the owner of project files, Photos access and render jobs. There is no HTTP port and no second editor state inside the MCP process.

## Setup

Build the application and the stdio entry point with `npm ci && npm run build`. Build the native/editor runtimes using the README instructions if they are not already available. Open the desktop app with `npm start` or use the newly packaged app. A previously packaged app needs rebuilding to include the agent socket.

In the content project's `.codex/config.toml`, configure the actual absolute paths for that machine:

```toml
[mcp_servers.reels_dashboard]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/reels-dashboard/dist-mcp/server.mjs"]
cwd = "/absolute/path/to/reels-dashboard"
env_vars = ["REELS_USER_DATA"]
enabled = true
startup_timeout_sec = 20
tool_timeout_sec = 180
```

Use Node 22.12 or later. Keep this personal config outside the public app repository. `REELS_USER_DATA` is optional and is primarily for isolated QA; without it, both app and MCP use the normal Reels Dashboard application-support directory. Do not point a fixture/demo instance at production data.

Run `codex mcp list` from that trusted content project to verify discovery. Load a new chat or reconnect MCP connections so the client discovers the newly registered server. The MCP process can list its tools before the app starts, but calls return `APP_OFFLINE` until the app is running. A local stdio server does not need OAuth login.

## Editing flow

1. `reels_get_app_state` shows the active saved project, current playback time, unsaved UI flag and active render jobs.
2. `reels_list_projects` and `reels_get_project` read saved state. `reels_open_project` opens a project in the editor when no unsaved changes would be lost.
3. `reels_import_video` creates an edit from an explicit absolute source path. Optional `reuse: {projectId, expectedUpdatedAt}` copies an existing project's settings to the new source. It never replaces the source file or the old project.
4. `reels_update_project` accepts a partial `patch` with independent `place`, `captions` and `cover` fields. Use the latest returned `updatedAt` for `expectedUpdatedAt`. Caption `items` is an explicit full-list replacement. `cover.hookSize: null` restores template sizing.
5. `reels_preview_frame` returns real PNG image content and the engine's resolved style manifest. Video previews require `time`; cover previews use `settings.cover.time`. For tool transport, images are reduced to at most 1280 pixels on the long edge. `displaySize` reports the returned image size; manifest coordinates refer to the full-resolution engine output.
6. `reels_start_render` accepts `video`, `cover`, or `both` and an absolute new output path (`.mov`/`.mp4` for video or both, `.png` for cover). `both` creates a neighboring `_cover.png`. Existing outputs and manifests are never overwritten.
7. Poll `reels_get_render_job` until `completed`, `failed` or `cancelled`. Completed jobs include output and manifest paths. `reels_cancel_render` waits for subprocess cleanup. Disconnecting the MCP client does not cancel the app-owned job.

Typical partial patch:

```json
{
  "projectId": "the UUID returned by get_project",
  "expectedUpdatedAt": "the updatedAt returned by get_project",
  "patch": {
    "place": { "x": 0.5, "y": 0.24 },
    "cover": { "time": 7.25 }
  }
}
```

This moves the place-guide group and selects a cover frame, preserving caption text/timing and the cover hook. Providing placement coordinates chooses manual placement unless `useDefaultPosition` explicitly says otherwise. It does not translate already-baked source text or apply color grading.

`reels_list_templates` describes the supported cover and place-guide choices. Actual output manifests, not template names alone, establish what was rendered.

## Existing content and local footage

`reels_list_local_media`, `reels_get_content` and `reels_upsert_content` connect existing capture folders, completed videos/covers and canonical content documents to the production dashboard without editing imports or proxy generation. Read the current dashboard revision before writing. See [local content workflow](local-content-library.md) for stable IDs, full resource-list replacement, private fields and availability checks.

## Photos and limits

`reels_photos_status`, `reels_photos_index`, `reels_photos_groups`, `reels_photos_group` and `reels_photos_inspect` use the app's validated native boundary. Inspection creates a bounded evidence page. `reels_import_photos_video` takes a group/index-run/asset selection and uses the same checked materialization as the UI. Existing macOS Photos permission is required; grant it through the app. Re-index after a native-helper restart rather than treating old index-run IDs as persistent project IDs.

The MCP does not expose arbitrary shell/IPC calls, Photos deletion or move execution, uploads, or publication. Content documents remain authoritative for prose. Color grading, independent description-font controls, and multi-clip timeline editing are outside the current engine's interface.

Project edits persist across restart. Render job records are in-memory for the current app instance; normal app quit is blocked during active work. Do not claim crash recovery of jobs. `STALE_PROJECT` means re-read and compare; `EDITOR_BUSY` means preserve unsaved UI work. After a timeout or lost connection, inspect state before retrying a mutation.

The socket directory is private, connection metadata is mode 0600, and requests require the current random token. Both MCP and app boundaries validate input. No credentials or socket tokens are stored in the repository.

## Validation

```sh
npm run check:architecture
npm run typecheck
npm test
npm run build
npm run test:mcp
```

MCP integration tests launch a real non-demo Electron app with an isolated temporary profile and generated synthetic media. They exercise stdio discovery, live UI updates, revision/dirty-state protection, actual PNG decoding, real video/audio/cover output, cancellation, disconnect and restart. They do not access or delete personal Photos media.

See [interface design](agent-interface.md) and [verification record](mcp-verification.md).


## 제작 프로젝트 연결·병합 — 2026-10-31

`reels_list_project_edits`에서 저장된 영상/카드뉴스 편집의 소유 프로젝트를 확인한다. `reels_link_project_edit`로 미연결 편집을 붙이고, 이미 독립 카드가 있으면 `reels_merge_projects`로 대표 카드에 합친다. 쓰기는 현재 dashboard revision을 사용하며 병합 전 전체 백업 경로를 반환한다. [스키마·동작](production-projects.md).

## Photos location and OCR search — 2026-10-31

`reels_photos_search` accepts `location: {latitude, longitude, radiusMeters}`,
`text`, or both. Dates are optional (`startDate`, `endDate`, inclusive local
Asia/Seoul dates). Without dates the helper reads library metadata across the
available time range. GPS-less assets are excluded only for a location filter;
`missingLocationCount` reports their count in the date scope. Place-name geocoding
is not included: resolve the intended public place to coordinates first.

A search keeps a private in-memory candidate snapshot, newest first, independent
of the current date index. `pageSize` is 1–10 (default 5). For text queries it is
**candidates examined**, not matching results. Continue with
`reels_photos_search_page({searchId, offset: nextOffset, pageSize})` even when a
page has no matches. `nextOffset: null` means that snapshot was exhausted. At most
four snapshots are retained, for 30 minutes; helper restart/eviction requires a
new search. No Photos content is modified, exported, or deleted.

OCR uses Vision on a bounded high-quality 1600px Photos preview (including the representative
preview of a video), not all frames or Apple's private semantic search index.
Korean/English text is normalized for Unicode, case and whitespace. Per-asset
image/OCR failures are returned in `failures`, separately from nonmatches. The
page may be retried while its snapshot is live. Low-resolution previews, unusual
fonts and video-only signage can cause misses. A match returns safe asset
metadata, local capture date, distance when applicable, and matching OCR text;
use the existing date-index/group/inspection tools to inspect adjacent captures.
Text-only library discovery omits filenames to avoid expensive per-asset resource
lookups; use the returned local date and asset ID with date indexing for filenames.
Geographic discovery filters GPS before looking up candidate resources.

Examples:
```json
{"location":{"latitude":35.2,"longitude":129.09,"radiusMeters":300},"text":"간판 글자","pageSize":5}
```
```json
{"text":"메뉴","startDate":"2026-01-01","endDate":"2026-10-31","pageSize":5}
```

Validation: Swift search tests cover distance filtering, missing GPS, stable
pagination, Korean OCR matching, failures, inclusive dates, invalid inputs,
snapshot eviction, permission denial and preservation of the current date index.
TypeScript tests cover schemas and MCP-to-native argument forwarding. Opt-in
`tests/electron/photos-search.spec.ts` exercises real stdio MCP → Electron →
PhotoKit/Vision in an isolated background profile; set `REELS_PHOTOS_SEARCH_LIVE=1`
only for authorized personal-library QA. `REELS_PHOTOS_SEARCH_AUTHORIZE=1` requests
macOS permission only when explicitly authorized. Reports must stay outside the
public repository (`REELS_PHOTOS_SEARCH_REPORT`).

Verification on 2026-10-31: 100 native tests passed (including actual Vision OCR
of synthetic Korean signage), followed by the added snapshot-expiry regression;
76 TypeScript unit tests, typecheck, architecture boundaries and diff whitespace
checks passed. Live stdio MCP → background Electron → PhotoKit/Vision passed on
an authorized library, with real location candidates and real Korean OCR matches;
image timeouts were returned separately. Personal evidence is kept in the content
workspace, not this repository. Packaged output: `release/photos-search/mac-arm64/Reels Dashboard.app`.
The packaged helper hash was checked against the tested release helper. Existing
running app sessions are not automatically replaced by building this artifact.
