# Packaged reel editor engine

The Electron host calls `native/editor-engine/.build/runtime/reels-editor`. This is a PyInstaller onedir executable containing Python and Pillow. FFmpeg, ffprobe, their non-system dynamic libraries, and component licenses live beside it. Runtime execution does not use the original checkout, system Python, Homebrew, or the user's PATH. macOS frameworks and installed Apple fonts remain system dependencies; Apple font files are never bundled.

The currently supported packaged target is **Apple Silicon, macOS 15 or later**, matching the deployment target of the media dependencies. The Swift PhotosIndex source has a lower minimum; that does not establish compatibility for the complete editor bundle.

## Hardware encoding policy — 2026-11-11

Production video encoding no longer selects `libx264` or `libx265` automatically.
SDR reel exports, playback proxies and card-news videos use
`h264_videotoolbox -allow_sw 0`; non-Dolby HDR uses HEVC Main10 VideoToolbox with
software encoding disabled. CPU decoding, image preparation and some FFmpeg
filters can still consume CPU; this is an encoder policy, not a zero-CPU claim.

The old Dolby Vision CPU branch had a concrete reason: a plain FFmpeg
`hevc_videotoolbox` conversion retained HLG/10-bit but lost Dolby Vision signaling
in a real-input check. The replacement is the bundled `reels-hardware-render`:

- AVFoundation reads 10-bit buffers and original presentation times. Metal/Core
  Image composites the existing PNG overlays without SDR tone mapping. Adjacent
  layers with identical timing are flattened once; template geometry is unchanged.
- AVAssetWriter requires a hardware HEVC Main10 encoder using
  `AVVideoEncoderSpecificationKey` / `RequireHardwareAcceleratedVideoEncoder`.
  Hardware failure is an error, never a silent CPU retry.
- Dolby Vision Profile 8.4 HLG metadata is regenerated for the composited pixels
  (`HDRMetadataInsertionMode=Auto`, `PreserveDynamicHDRMetadata=false`). Ambient
  viewing metadata is propagated. Other Dolby profiles stop with an explicit error.
- FFmpeg remuxes the encoded video and copies the original audio. Both native and
  final outputs are checked for Dolby Vision signaling; final HLG/BT.2020/10-bit
  fields are checked before delivery. No claim of bit-identical video is made.
- Target bitrate follows the source estimated rate, capped by `--dovi-maxrate`
  (80,000 kbps default). CPU-only `--crf` is no longer accepted. The style manifest
  records the actual target, hardware requirement, compositor and frame count.

Implementation follows Apple's [Dolby Vision editing/export guidance](https://developer.apple.com/av-foundation/Incorporating-HDR-video-with-Dolby-Vision-into-your-apps.pdf).
Changing pixels invalidates the original dynamic metadata, so the exporter creates
metadata for the edited result rather than blindly injecting the old RPU.

`scripts/build-editor.mjs` builds and signs the native executable and includes it
in `editor-runtime/bin`; runtime use never compiles ad-hoc Swift. Missing native
runtime or unsupported hardware/profile fails clearly. The legacy content-vault
CLI is separate and is not silently synchronized by this change.

```sh
EDITOR_RUNTIME="$PWD/native/editor-engine/.build/runtime/reels-editor" \
native/editor-engine/.build/venv/bin/python -m unittest discover -s native/editor-engine -p test_hardware.py -v
```

Set `EDITOR_TEST_DOVI_SOURCE` to an explicitly authorized local Dolby Vision file
for the real-input test. It copies a short MP4 sample to a temporary directory,
verifies timed overlays and Dolby metadata, and preserves the input. MP4 is
intentional: an FFmpeg MOV copy in an early test stripped the fixture's Dolby
configuration before the renderer was called.

Verification on 2026-11-11: source/frozen engine tests (13 each), hardware tests
(5, including an authorized real Dolby Vision input), and development/packaged
MCP and card-news Electron checks (4 each) passed. The full Node suite passed
389 tests with concurrency 4; type, architecture and public-source checks passed.
A 2160×3840, 60 fps, 26.766667-second Profile 8.4 input rendered through the
packaged runtime in **33.13 seconds**, targeting 55,065,112 bit/s. The 184,616,488-byte
output retained all 1,606 frames with identical presentation timestamps, copied
audio bytes, HLG/BT.2020/10-bit and Dolby Vision 8.4 signaling. The real-input test
also decoded RPU side data and checked a timed caption disappearing. This is one
machine/input measurement, not a universal performance or quality guarantee.

## Source preservation

Twenty allowlisted `.py` files were copied from the existing `reels/scripts/reels_editor` FSD package. `native/editor-engine/source-inventory.json` records each original relative path and SHA-256. The original checkout was not edited. The local architecture checker is copied from the original project and validates the same layer/public-API boundaries.

Two vendored files have narrowly scoped extensions:

- `features/video_overlay/cli.py` accepts `--preview-time` and a progress callback. Legacy preview behavior remains available when no time is supplied. A timed preview reads the selected source frame and composites only active layers.
- `shared/media.py` adds a subprocess progress reader. Audio copying and HDR handling were retained at migration; the current encoder policy is documented above.

The new `shared/timing.py` recognizes only expressions generated by the engine. It never evaluates arbitrary text. Body captions use the existing rounded microsecond, half-open interval `[start, end)`. Description intervals retain the original inclusive `between(t,start,end)` behavior. A persistent pin is independent of timed descriptions and captions.

The wrapper honors `place.useDefaultPosition` and `cover.useDefaultPosition`: true omits explicit position arguments so the original renderer chooses its precise defaults; false passes the requested positions. The latest place-guide grouping, centered pin/description, left-aligned cover hook/signature, tape texture, and automatic cover sizing remain in the vendored engine.

## Template adjustments

The editor UI exposes the five existing numbered presets as independent video/cover appearance choices. `place.offsetX/offsetY` map to `--place-offset-x/y`; `cover.hookOffsetX/hookOffsetY` and `cover.placeOffsetX/placeOffsetY` map to their corresponding grouped CLI offsets. These optional frame-ratio fields are bounded to [-1,1], apply after default/manual positions and are preserved by draft validation and MCP patches. UI inputs display percentages. No vendored renderer changes or original content-workspace changes were needed for these controls.

`cover.hookSize` is an optional integer from 1 to 185 at reference width 2160, matching the existing engine's bound. Selecting a cover preset removes this override. Content, timing, absolute positions and offsets are preserved when selecting appearance presets. The same adapter builds preview/export arguments; the 12-test engine suite now also verifies all three video materials, both cover templates, explicit sizing, offsets and preview/export placement agreement.

## CLI contract

```text
reels-editor probe INPUT
reels-editor proxy INPUT OUTPUT_MP4
reels-editor preview REQUEST_JSON OUTPUT_PNG --time SECONDS
reels-editor cover REQUEST_JSON OUTPUT_PNG
reels-editor render REQUEST_JSON OUTPUT_VIDEO
```

The request is `{sourcePath, place, captions, cover}` using `src/shared/editor.ts`. Caption item IDs are UI metadata; the renderer receives only start/end/text. Cover hook newlines become the existing CLI's two-line separator. Source and output must differ. The host owns user file grants, output selection, and project persistence.

- `probe` returns one JSON object with duration, display width/height, HDR/audio flags, and color metadata.
- `proxy` returns `{outputPath, hdrToSDR}`. It creates H.264/AAC playback media with a maximum dimension of 1080 pixels. HDR proxies explicitly linearize and tone-map to BT.709 SDR through zscale/tonemap. This conversion applies **only to the playback proxy**, never to the source or exported edit.
- `preview` and `cover` return `{outputPath, manifestPath}`. Preview uses the requested time; cover uses `cover.time`.
- `render` emits newline-delimited `{type:"progress", percent, outTimeSeconds}` events and then `{type:"result", outputPath, manifestPath}`. Diagnostic output goes to stderr. A successful FFmpeg exit is required before final completion.
- The host starts the executable in its own process group and cancels that group, so Python and FFmpeg receive termination together. The engine never creates a detached encoder process.

Every output manifest retains the original resolved placement/style evidence. Project settings remain the reusable editing input; temporary caption-file paths in the engine manifest are not portable project references.

## Build

```sh
node scripts/build-editor.mjs
```

Build-time dependencies: Node, `uv`, Python 3.12, Xcode command-line tools, Homebrew with x264/x265, and an installed FFmpeg/ffprobe. Python/Pillow/PyInstaller build versions are pinned in `native/editor-engine/requirements-build.txt`.

If the installed FFmpeg lacks zscale, `build_media.py` builds a separate FFmpeg 8.1 under `.build/media`, using checksum-pinned FFmpeg source and a checksum-pinned zimg 3.0.6 bottle extracted under `.build/deps`. It does not replace or relink the installed FFmpeg. `FFMPEG_BIN` and `FFPROBE_BIN` may identify another reviewed build with zscale.

The packaging step recursively discovers Mach-O dependencies, copies non-system libraries, rewrites their install names to relative loader paths, and ad-hoc signs the relocated files. It rejects unresolved or conflicting library names. Licenses and source/version metadata are included per component. The executable, FFmpeg, and ffprobe are checked with a minimal PATH before the staged runtime replaces the previous build.

The FFmpeg configuration includes GPL components. The repository's MIT source license does not override the licenses of packaged Python/media dependencies. Before distributing an installer, satisfy the corresponding-source and notice requirements for the exact binaries; publishing this repository is not publication of those binary artifacts.

The original Japanese pin style requires the matching Apple Toppan Bunkyu Midashi Mincho ExtraBold font. If unavailable, the engine reports the missing font instead of changing typography or trying to execute a script in the old checkout.

## Validation

```sh
native/editor-engine/.build/venv/bin/python native/editor-engine/check_reels_architecture.py
native/editor-engine/.build/venv/bin/python -m unittest discover -s native/editor-engine -p test_editor.py -v
EDITOR_RUNTIME="$PWD/native/editor-engine/.build/runtime/reels-editor" \
EDITOR_TEST_HDR=1 \
native/editor-engine/.build/venv/bin/python -m unittest discover -s native/editor-engine -p test_editor.py -v
```

The focused suite covers source parity, FSD boundaries, cue boundaries, persistent pins, timed descriptions, selected-frame previews, default versus manual positions, actual video/cover output, audio retention, progress events, invalid input, source-overwrite refusal, proxy generation, and synthetic HDR proxy/export separation. Frozen CLI test subprocesses receive only a minimal system PATH.

The final standalone runtime passed all **11 tests** in 11.510s after being copied into a separate Korean/spaced temporary path and executed with a minimal PATH. The source FSD check also passed at the relocated development checkout. The runtime is about 62MB, with 19 relocated media binaries/libraries; all bundled Mach-O dependencies and relative symlinks passed the relocation audit. Synthetic fixtures do not establish all camera-specific Dolby Vision behavior; the hardware route additionally requires real-input verification as described above.


## Signed follow cover (2026-10-29)

`follow_cover.py` adds cover template `rosy-follow` through the same `editor_cli.py cover` route used by previews and PNG export. It produces a fixed 1080×1920 center crop with two message lines, one CTA and a Bradley Hand account signature plus optional system rose glyph. No place overlay is rendered. Optional cover fields are `followCta`, `followSignature`, and `followDarkness` (0–0.85); older saved configurations remain unchanged. Cover-only validation omits the place-name requirement; video/both exports retain it. `.style.json` records actual text, fonts, bounding boxes and darkness. Existing vendored renderer files are unchanged.

`EditorBridge.export(project, "cover")` uses the existing cover render service and PNG save dialog. It does not append an end card to a video. UI and agent patch schemas both accept the new fields.
