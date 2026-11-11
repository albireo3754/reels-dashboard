# Complete captured-image evidence segment

## Standard loop — 2026-11-04

`scripts/evidence-loop.ts` is the default entry point. One hand-written spec drives the whole segment; the steps below used to be done by hand per project.

```sh
node --import tsx scripts/evidence-loop.ts run /private/spec.json /private/out --check-only
node --import tsx scripts/evidence-loop.ts run /private/spec.json /private/out
node --import tsx scripts/evidence-loop.ts connect /private/out "$USER_DATA" content:example
```

```json
{
  "version": 1, "projectId": "content:example", "title": "Owned captures",
  "context": {"venue":"","location":"","visit":"","menus":"","surroundings":"","notes":"","sources":[]},
  "request": "Inspect every image, including background subjects.",
  "archiveDir": "/private/persistent/archive",
  "captures": [
    {"id":"CLIP_01.MOV","sourcePath":"/private/CLIP_01.MOV","frames":{"fps":1,"width":1280}},
    {"id":"PHOTO_02.JPG","sourcePath":"/private/PHOTO_02.JPG"}
  ],
  "images": [{"captureId":"CLIP_01.MOV","path":"/tmp/old-crop.jpg","time":2.0,"kind":"video-frame","sourceLabel":"Earlier detail crop"}],
  "excluded": [{"path":"/private/board.jpg","reason":"Comparison board of frames already listed"}],
  "corrections": [{"id":"facility","reason":"User corrected the place name","context":{"venue":"","location":"","visit":"","menus":"","surroundings":"","notes":"Corrected fact","sources":[]},"captureIds":["CLIP_01.MOV"]}],
  "checks": [{"name":"Corrected name appears","captureIds":["CLIP_01.MOV"],"includes":["Corrected"]},{"name":"Old name is gone","fields":["tags"],"excludes":["Old name"]}]
}
```

| Stage | Output | Rule |
| --- | --- | --- |
| assemble | `input-manifest.json`, `input-audit.json` | ffmpeg extracts `frames` once per settings. An image-file capture without listed images becomes a photo; HEIC goes through a labelled JPEG derivative made with `sips`. A capture `note` (such as time and GPS) is carried into each row's `sourceLabel`. Only exact-byte copies consolidate; every input path stays as an alias. IDs are `im-` plus 20 SHA-256 characters. All images are copied into `archiveDir` **before** analysis, so results never link to temporary paths. |
| analyze | `base/` | Existing adapter and batch rules. A rerun reuses successful batches and retries only failed ones. |
| correct | `corrections/<id>/` | Re-analyzes only the named captures/images. `base/` is never rewritten. A changed correction needs a new `id`. |
| merge | `effective/results.json` | Base order, corrected rows replaced by ID. Refuses unknown IDs, changed source/hash/time and unresolved rows. `analysisRun` and `provenance` record the origin. |
| verify | `effective/metadata-table.md`, `semantic-checks.json`, `verification.json` | Input, result and table IDs must match in order. Every linked image must hash-match. Every capture must be represented and every check must pass. An empty check scope fails. |
| connect | `mediaEvidence` in `blog-projects.json` | Explicit. Refuses a result that did not pass and keeps a dated backup. Reopen the app afterwards. |

The loop is: run → read `verification.json` → add a correction or check to the spec → run again. The process exits 1 until verification passes. Judgement stays outside the code: choosing the inventory, writing context, deciding what a failed check means and writing the expected checks. `checks` are term matches over stored fields, so they catch contradictions and omissions, not visual misreadings; sample real images separately.

Validation: `tests/unit/media-evidence-loop.test.ts`. On 2026-11-04 the loop code replayed a completed private 486-image run: merging its two runs matched the hand-made effective result with 0 differing rows, 570 recorded input paths assembled to 486 images and 84 aliases, and verification passed.

The commands below remain available for a manifest that already exists.

## Manifest CLI

Use this CLI when an explicitly inventoried capture set and all existing extracted images must be analyzed before editorial selection. It calls the same `CodexImageAnalyzer` and frozen-context MCP as the desktop. It does not sample a video's beginning/middle/end again, publish anything, rewrite an article, or import into the desktop result database. Keep manifests, originals and results in the private content workspace, outside this repository.

```json
{
  "version": 1,
  "projectId": "content:example",
  "title": "Owned capture evidence",
  "context": {"venue":"Confirmed venue","location":"Confirmed place","visit":"Confirmed capture date","menus":"Confirmed orders and corrections","surroundings":"Relevant surroundings","notes":"Separate visible observations from supplied facts","sources":["/private/content/notes.md"]},
  "request": "Inspect every image, including background subjects; preserve unknowns and human corrections.",
  "captures": [{"id":"CLIP_01","sourcePath":"/private/original/clip.mov"}],
  "images": [{"id":"frame-001","captureId":"CLIP_01","path":"/private/frames/001.jpg","time":1.0,"kind":"video-frame","sourceLabel":"Original clip at 1 second"}]
}
```

Paths are absolute. Each capture must have at least one image; every image must point to a known capture. IDs must be unique, files must exist, photo time must be null and video frame time must be known. Read extraction manifests or original commands to recover frame provenance; do not infer it from filenames such as `noodles.jpg`. A local Photos derivative can be used when explicitly identified as such in the capture metadata/sourceLabel and scope report; do not claim original-resolution inspection.

Inventory construction remains the caller's responsibility. Preserve all input paths if exact-byte copies are consolidated before submission; never consolidate merely similar views. Comparison sheets are linked to their constituent frames, and UI screenshots/reference articles are distinguished from owned visual evidence. The CLI analyzes every submitted image independently; it cannot discover a file omitted from the manifest.

```sh
node --import tsx scripts/analyze-evidence.ts /private/input-manifest.json /private/run --check-only
node --import tsx scripts/analyze-evidence.ts /private/input-manifest.json /private/run
```

`--check-only` creates `input.json` and `input-check.json`, with `analysisComplete:false`. Real runs use batches of eight, two concurrent invocations, and persist successful batch results. Re-running the same output directory reuses only successful batches with the same fingerprint. Context, request, provenance and image bytes participate in that fingerprint. Changed input requires a new output directory. Run only one process per output directory. Each provider invocation receives only that batch's source mappings, not the entire inventory.

`results.json` preserves per-image fields and source/time references. `metadata-table.md` contains one row per image, including failed entries, with description, tags, OCR, contextual facts, uncertainties, face candidates and source/time/hash links. It is the human/agent-readable input to later scene and editorial decisions; never replace it with a selected-image summary. `coverage.json` distinguishes expected/resolved/missing/failed, changed inputs and represented captures. Completion requires `pass:true` and `analysisComplete:true`. A failed batch is not automatically retried inside a run. A restarted run is an explicit retry and should follow examination of the failure. Errors do not expose provider stderr or credentials.

For previously completed or verified merged results, run `node --import tsx scripts/render-evidence-table.ts RESULTS_JSON OUT_MD`. Verify that input/result/table ID sets agree. Keep exact-copy aliases mapped to their result rows. Retain temporary image inputs in a private persistent location before handing off a table intended for later decisions; verify copied bytes and preserve their original analysis paths. Do not silently rewrite the immutable original run.

After numeric coverage, verify meaning separately: search positive and negative examples, compare current user corrections against actual result IDs, and distinguish visible facts from `contextNotes`. Missing/blurred identification is not proof of absence. Only after this segment should the composition owner create/update scene inventory and make `use/omit/hold` publication decisions. A segment-only rerun leaves those choices and prose untouched. This CLI's result files are not desktop database synchronization.

Validation: `node --import tsx --test tests/unit/media-evidence.test.ts`, `npm run typecheck`, `npm run check:architecture`. Tests use an injected analyzer and synthetic fixtures; production execution is recorded privately in the content workspace.
