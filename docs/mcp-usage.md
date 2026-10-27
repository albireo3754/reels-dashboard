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
