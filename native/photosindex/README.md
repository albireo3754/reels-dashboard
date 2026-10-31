# Bundled PhotosIndex service

This package preserves the PhotosIndex Swift engine, CLI and upstream tests. Reels Dashboard supplies the user-facing React UI. The embedded background app owns PhotoKit and Vision access, indexing, decision validation, copy-only export, verified move and recovery journals.

Build from the repository root with `node scripts/build-native.mjs`. Outputs:

- `native/photosindex/.build/PhotosIndex.app`
- `native/photosindex/.build/photosindex`

Package both side by side under the Electron application's `Resources/native/` directory. The CLI resolves only an explicitly configured helper path or `PhotosIndex.app` beside itself; it does not search the machine for an older PhotosIndex installation.

## Runtime configuration

| Environment variable | Helper launch argument | Default |
| --- | --- | --- |
| `PHOTOSINDEX_APP_PATH` | selected app path for `open` | `PhotosIndex.app` beside the CLI |
| `PHOTOSINDEX_SOCKET_PATH` | `--photosindex-socket` | `/tmp/reels-photosindex-<uid>.sock` |
| `PHOTOSINDEX_EXPORT_ROOT` | `--photosindex-export-root` | iCloud Drive's `Naver Clip` directory |
| `PHOTOSINDEX_SUPPORT_ROOT` | `--photosindex-support-root` | `~/Library/Application Support/ReelsDashboard/PhotosIndex` |

Launch arguments override environment values. All configured filesystem paths must be absolute. The CLI forwards configuration as individual argument-array entries through LaunchServices, preserving spaces and Unicode. The export root remains a boundary checked by the native export planner; changing configuration does not bypass hash, path, digest, upload or selection validation.

`PhotosIndex.app` is an accessory application with no launch window. It starts its command host at application startup and stops it on normal termination. Electron owns the visible interface and should terminate its own helper when appropriate; forced process termination can leave a stale socket, which the existing owner-only startup checks handle.

The native bundle keeps its established bundle identifier and signing identifier to support existing macOS Photos permission identity. This does not guarantee permission on another machine or after a differently signed build. No signing certificate name or secret is stored in this repository. Local builds require one Developer ID Application identity (or an explicit `PHOTOSINDEX_SIGNING_IDENTITY` selection). Only disposable CI artifacts may use `CI=true PHOTOSINDEX_SIGNING_MODE=ci-adhoc`. The previous development/adhoc modes are removed. See [signing and permission continuity](../../docs/native-signing.md).

## Validation

```sh
swift test --package-path native/photosindex
zsh native/photosindex/scripts/test-sign-app.zsh
node scripts/build-native.mjs
```

See the repository's test and UI specifications for the complete compatibility contract. PhotoKit live behavior and permission prompts must be verified separately from mock-backed unit tests. Automated tests must not move or delete personal library assets.

## Helper lifecycle ownership

After the socket host starts, the helper atomically publishes `helper-instance.json` under its configured support root. The directory is owner-only (`0700`), and the record is owner-only (`0600`):

```json
{"schemaVersion":1,"instanceID":"unique-process-instance","pid":123,"executablePath":"/absolute/bundled/helper/executable","socketPath":"/absolute/private/socket"}
```

Electron may use this to terminate its own helper only after validating the current executable and socket arguments of that PID. A PID or metadata file alone is not proof of process identity. The record may appear a few milliseconds after the first status response. SIGTERM and SIGINT trigger normal AppKit termination, which removes the matching record before releasing the socket. Cleanup never removes a replacement instance's record. A force-killed process can leave stale metadata; validate process identity before acting on it.

## Optional standalone CLI installation

After building, run `zsh native/photosindex/scripts/install-cli.sh` from the repository root. The default destination is `~/.local`; set `PHOTOSINDEX_INSTALL_ROOT` to another absolute prefix to install elsewhere. The installer keeps the CLI and helper together in `<prefix>/lib/reels-dashboard/` and places a small launcher at `<prefix>/bin/photosindex`. It does not overwrite an app in `~/Applications`.

The launcher locates its paired helper without an external `PHOTOSINDEX_APP_PATH`, honors an explicit override, and preserves spaces and Unicode in installation paths and arguments. Installation stages and verifies both signed binaries, atomically exchanges the complete pair, then atomically publishes the launcher. Reinstallation does not overwrite a running helper's Mach-O inode.

`node scripts/test-native-install.mjs` validates this flow under a temporary installation prefix. It never changes `HOME` or writes to the user's real installation, and it makes only status requests.


## Desktop editor source preparation

The direct native bridge additionally supports `editor.materialize` with exactly three string arguments: `id` (group ID), `index-run`, and `asset-id` (public asset ID). It requires current Photos permission, a current index run, membership in the selected group, and a video asset. It does not add or alter the existing CLI commands.

The command uses the existing PhotoKit original materializer to prepare one video under `<supportRoot>/editor-sources/<UUID>/`. The request cannot choose an output directory. Cache directories use mode `0700`, and the resulting regular file uses `0600`; returned paths are checked against the allocated directory. The response is `{assetID, sourcePath, originalFilename?}` and includes no PhotoKit local identifier or location metadata. `originalFilename` is the already-sanitized public filename, when present. Failed preparation removes its partial UUID cache. Existing successful caches remain available for editor jobs; deleting a cache is separate from deleting a Photos asset.

Preparation can download an iCloud original and uses the materializer's existing 300-second request deadline. It never invokes PhotoKit deletion, export-to-iCloud, or move operations. Desktop and Sites sharing policies must keep the returned local path private.

Verification: the additional editor tests use synthetic local files and a fake materializer. They cover group membership, stale runs, Photos permission, photo rejection, output-argument rejection, private output confinement, symlink refusal, failed-cache cleanup, unique repeated preparation, and preservation of the original fixture. The full Swift suite passes **95 tests**. This does not claim that a live Photos video was materialized in this change.
