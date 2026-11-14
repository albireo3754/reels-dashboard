# Project media metadata analysis

The desktop owns three independent boundaries: media preprocessing (`MediaAnalysis.prepare`), an `ImageAnalyzer` adapter, and a project-scoped result store. Photos and video stills use the same contract. An adapter receives image paths, project identity/date basis, curated context and the requested analysis; it returns description, tags, OCR candidates and uncertainties. It cannot change the dashboard or editorial copy.

## Use

For an already extracted set of captures/images, use the [complete evidence segment](media-evidence.md) before editorial selection. It analyzes every listed image with source/time provenance and explicit coverage checks; it does not replace that set with the three-frame video sampling described below.

Open **사진·영상 메타데이터 분석** on a production project card. Choose a linked folder and analyzer, then start. Only direct photo/video children of that folder are included; subfolders, final outputs elsewhere, and unrelated files are not implicitly included. The default maximum is 100 source files (MCP allows up to 200); exceeding it is an explicit error, not silent truncation.

Each photo produces one JPEG preview. Each video produces up to three stills near the beginning, midpoint and end. Results retain source path, file version (size/mtime fingerprint), frame time and image identity. This is sampled image analysis, not continuous video, audio or action recognition. A pair of raised glasses does not prove a toast occurred. OCR remains a candidate, not verified venue/menu/price data.

Search matches descriptions, tags, OCR and source filenames. Context notes and uncertainty text are displayed but excluded from search so an absent-menu explanation does not create a false match. The dialog can edit descriptions; MCP can also correct tags/OCR/uncertainties. Human corrections live separately from model history and survive reanalysis of the same unchanged source. Revision checks reject stale corrections. Changed media receives a new sample identity; old results retain their original provenance.

## Providers and authentication

The first connected provider is `CodexImageAnalyzer`, using installed `codex exec` and its existing CLI authentication. No API key is created, read or copied by this feature. `REELS_CODEX_BIN` can specify the executable. The provider runs without user config/rules in an isolated run directory with read-only sandbox, ephemeral sessions, attached images and JSON Schema output. Host validation checks every image ID and the returned fields. No shell interpolation is used. CLI stderr is not returned to the UI because it may contain private context.

Images are sent to the selected provider and count against that account's access/usage limits. CLI login status alone does not guarantee that a request will succeed. The UI distinguishes model failures, preprocessing failures, partial completion and interrupted runs. A model invocation has a five-minute timeout; media reads also have bounded timeouts.

Official reference: [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive). The installed CLI's `exec --help` confirms image attachments, structured output and authentication-preserving `--ignore-user-config` support. Claude and local model adapters can implement `ImageAnalyzer`, but neither is enabled or claimed to work in this version. Vector indexing is not required for the current text search.

## Persistence and MCP

Private data stays under the app's user-data `media-analysis/` folder, outside the source checkout and shared snapshots. Hashed project IDs name JSON records; `frames/<runId>/` holds derived JPEGs. Model history is append-only; effective search results apply human overrides. Writes are serialized within the service and atomically renamed. A profile-level `active.pid` prevents simultaneous analyzer processes. Human edits from another process are rejected while analysis is active. If the process crashes, inspect the recorded PID before removing the stale lock; never remove a lock belonging to a live run.

- `reels_start_analysis`: start a bounded asynchronous run on a linked folder.
- `reels_search_analysis`: query results, source timestamps, history and run status.
- `reels_correct_analysis`: revision-checked human override.

The same service is available through desktop IPC and `scripts/analyze-project.ts USER_DATA PROJECT_ID LINKED_FOLDER`. The script is useful for an authorized run without restarting an active editor. Do not run concurrent app/CLI writers for the same profile; respect the process lock. The content document remains the canonical script/caption record.

## Validation

Synthetic tests cover project isolation, unknown providers and unlinked folders, stale human corrections, reanalysis preserving overrides, and searching effective text. Electron tests exercise real IPC, UI search/edit, restart persistence and MCP reading the same results. No paid model calls or personal media are used by automated tests. A separate real-media run is recorded in the content workspace, not committed here.

Build available at `release/media-analysis/mac-arm64/Reels Dashboard.app`. The existing running app was not restarted. Close it before opening the new build to use the new IPC/MCP tools. Verification: type/FSD, 78 unit tests, 7 development Electron checks and 7 packaged Electron checks passed. A separate packaged UI check loaded the completed project analysis into an isolated profile and verified search; it did not mutate the running user's editor.

## Context-aware analysis — 2026-10-31

`start` accepts a reusable `context` with venue, location, visit/capture facts, ordered menus and aliases, surroundings, filename-specific notes and source references. The desktop form exposes these fields. Context is saved on analysis start (closing the form alone does not save it). The service reuses saved context when a caller omits it. An explicit context update requires the current analysis `expectedRevision`, rejecting stale edits. No linked documents are silently read or sent: callers supply curated facts from the authoritative content records.

Context-v2 runs snapshot the context and `promptVersion: context-v2` (the later MCP transport uses `context-v3-mcp`). The provider additionally receives project title, project date and date basis, plus each image's source filename and time. Publication/record dates must not become capture dates. Confirmed menu names and synonyms enrich matching visual descriptions and tags; the prompt forbids applying all menu names to portraits or unrelated street images. Supplied facts are distinguished from visible evidence in `contextNotes`, which is displayed alongside the result and remains separate from OCR and uncertainties. Existing results without context notes remain readable. Human overrides continue to win after reanalysis.

Context is evidence for naming and interpreting a scene, not proof that an unseen subject appears in it. Conflicts, unconfirmed sides and price/payment details are not filled by guesswork. Existing runtime stores private context; no project-specific facts are embedded in public source code.

CLI: `node --import tsx scripts/analyze-project.ts USER_DATA PROJECT_ID LINKED_FOLDER [CONTEXT_JSON]`. The optional context file is read explicitly; the script obtains a revision before starting.

Context-v2 validation: type/FSD and the full 78-test suite passed; targeted tests verify context delivery, run snapshots, reuse, stale-context rejection, cross-project isolation and exclusion of non-matching context notes from search. Development and packaged Electron context-form/result-display checks passed. The new bundle is `release/media-analysis-context/mac-arm64/Reels Dashboard.app`; earlier builds are preserved.

## Context intake before every analysis

Before calling `start`, the operator must read the production project's authoritative content/capture records and existing analysis context, reconcile recent corrections, and prepare venue, location, capture/visit date, menu/subject names, surroundings, filename-specific notes and sources. Record unknown/not-applicable fields explicitly; do not fabricate facts to fill a form. The detailed content workflow is [맥락 주입 가이드](../../../Obsidian/side/reels/templates/media-analysis-context.md). This is an authoring guide, not a runtime dependency on that workspace.

Use `search({projectId})` to obtain stored context and its revision. For first use or changed facts, pass the curated `context` plus `expectedRevision` to `start`. Omit context only after checking the stored version against current authoritative records. Check the returned run's context snapshot, then completion status and representative positive/negative search examples. Linked source paths are references, not automatic document ingestion.

This procedure is mandatory for agent-operated production analysis. Runtime validation currently permits absent/empty context: it is not a hard context-readiness gate. Context form values persist on start, not on closing the form. No additional model run is needed merely to add or revise these instructions.

## Face mosaic review workflow

New Codex runs return `faceRegions` for each sample: normalized rectangles in the displayed image orientation. An empty array means the analyzer reported no visible faces; missing data means the run predates this feature or did not produce a result. These are suggestions, not an anonymity guarantee. Check every face, including distant and partial faces, and add, remove or expand rectangles before output. Images continue to be sent to the existing Codex CLI account; no separate model or API key is introduced.

In the desktop analysis dialog, open **얼굴 모자이크 검토** on a result. Drag on the image to add a rectangle, select a rectangle to delete it, adjust the block-size slider, and save a PNG copy. The app saves a `.mosaic.json` sidecar with the source, regions and settings. The red rectangles are an area preview; inspect the saved mosaic as well.

A command-line review workflow is also available. Find a sample ID in `reels_search_analysis`/the saved analysis, then run from this checkout:

```sh
node --import tsx scripts/face-mosaic.ts plan USER_DATA PROJECT_ID SAMPLE_ID /private/path/plan.json
node --import tsx scripts/face-mosaic.ts preview /private/path/plan.json /private/path/preview.png
node --import tsx scripts/face-mosaic.ts render /private/path/plan.json /private/path/output.png
```

Review and edit `regions` (`x`, `y`, `width`, `height` are 0–1 fractions of the oriented image), and `blockSize` (4–100 pixels; larger is stronger). Regenerate preview to a new filename after each edit. The preview draws red boxes; the output uses BOX downsampling and nearest-neighbor enlargement, not generated content. Both outputs are new PNGs and refuse to overwrite existing files. The private plan preserves source, frame time, regions and settings; keep it with the result. Source size/mtime is checked before planning and rendering, but is not a cryptographic content digest.

JPEG/PNG/WebP photo output uses the oriented original at full resolution. HEIC and video use the already extracted JPEG sample, at up to 960 pixels; a video sample is a still image only and does not anonymize the video. The source is never overwritten. The user must review the resulting image, including edges and any missed faces, before sharing. This workflow does not modify Photos or automatically export to a production project.

## Isolated Codex invocation with a batch MCP — 2026-10-31

The outer dashboard MCP (`reels_start_analysis`) remains the production entrypoint. The inner Codex process registers a different, invocation-local MCP, `reels_analysis`. It exposes exactly one read-only tool: `get_analysis_context({})`. That tool serves a validated, frozen snapshot of the curated project context, request, and this batch's image identities. It cannot select another project, read an arbitrary path, mutate the dashboard or recursively start analysis. Images remain explicit `-i` attachments. The complete dashboard MCP is not registered in the child.

For each batch, the host writes a private manifest into a fresh scratch directory, then launches `codex --no-daemon exec` with `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, a read-only sandbox and invocation-local `-c mcp_servers.reels_analysis.*` settings. The server is required and its enabled-tool allowlist contains only `get_analysis_context`. User MCP config files are not rewritten. Existing CLI authentication is reused without copying credential files.

Additional settings set `project_doc_max_bytes=0`, disable web search and memory injection/generation, and switch off apps/plugins/shell-tool/skill-search/multi-agent feature flags. The available-skill catalog budget is the documented positive minimum, one token; the installed CLI probe reported no available skills. Environment inheritance uses an explicit allowlist for identity, auth-home location, locale, executable path, TLS certificates and proxy configuration. Parent agent/thread variables and API-key environment variables are not forwarded. No previous session is resumed.

**Limits:** This reduces ambient context and integrations; it is not a container, a full filesystem read jail, or removal of Codex's built-in instructions and tools. The CLI probe still reported built-in tools. Managed organization/system requirements are not bypassed, and feature flags do not prove every built-in capability has disappeared. The MCP server's own surface is strictly read-only and batch-bound; arbitrary filesystem/process behavior of all remaining built-in tools is not claimed to be isolated.

The child must successfully call the MCP. Before accepting model output, the host verifies a completed `mcp_tool_call` event and a server-written receipt whose SHA-256 matches the exact manifest. Missing MCP startup/context reads fail analysis; there is no fallback to title-only analysis. New runs are marked `context-v3-mcp`. This is a transport check, not an automatic source-gathering or context-completeness gate: the [context intake procedure](#context-intake-before-every-analysis) still applies.

As of 2026-11-01 the child also sets `CODEX_LOCAL_CHANNEL_DISABLED=1`, explicitly
preventing the local-channel SessionStart hook from starting/rebinding a separate
long-lived App Server. The environment allowlist and private batch MCP remain
unchanged. This marker is a lifecycle opt-out, not a replacement for MCP isolation.

The MCP is bundled as `dist-electron/analysis-context-mcp.cjs`. Desktop launches it with the Electron executable in `ELECTRON_RUN_AS_NODE=1` mode; the CLI runner uses Node. Build desktop before running the source CLI. Tests exercise the real stdio server, the single-tool registry, rejection of extra project/path selectors, a frozen snapshot, a matching read receipt and environment filtering. Separate live CLI/image checks use a synthetic red image; no production metadata is replaced by these checks.

Official sources: [Codex MCP configuration](https://developers.openai.com/codex/mcp), [configuration reference](https://developers.openai.com/codex/config-reference), [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode). Verified installed CLI: 0.166.0. The invocation-local MCP and reduced context were tested rather than inferred solely from flags.

Isolation verification: the full unit suite passed (81 tests at this checkout), including the new stdio/argument rejection/frozen-context checks. A live `codex exec` probe called the configured MCP, returned the test context marker, reported no available skills, and did not apply the planted project instruction. The real adapter analyzed a synthetic red image and passed both MCP-event and digest-receipt checks. The packaged Electron app also completed a one-image run through its bundled MCP (`context-v3-mcp`). Evidence: local `artifacts/analysis-isolation-live.json`. No production project was reanalyzed for these tests. Build: `release/media-analysis-isolated/mac-arm64/Reels Dashboard.app`; existing running app was not restarted.

### Packaged integration and restart — 2026-10-31

The shared main worktree was built without discarding other in-progress changes; no separate branch merge or commit was made. Type/architecture checks, 81 unit tests and two isolated packaged Electron checks passed. The face-mosaic package is under `release/face-mosaic/mac-arm64/`.

The previous production-projects app was backed up to `release/production-projects-before-face-mosaic/mac-arm64/` and replaced. After restart the observed running application was `release/media-analysis-isolated/mac-arm64/Reels Dashboard.app`; its app.asar and editor-runtime executable SHA-256 were identical to the face-mosaic package, so it was not needlessly restarted again. The live UI exposes media analysis, all 66 project IDs are retained, and MCP reports runtime ready with no unsaved editor or active jobs. Real Codex face detection accuracy remains unverified.

## Idempotent analysis and usage — 2026-11-14

Every prepared sample is identified by SHA-256 of the entire original byte stream plus media kind and frame time. Paths and filesystem modification times are excluded, so byte-identical copies reuse results; any byte edit changes identity. The existing size/mtime version is retained separately for source-change and mosaic guards. Full hashing reads sequentially with bounded memory. Reuse additionally binds provider, requested model/effort, prompt version, exact serialized project context (including title/date/date basis) and request. Legacy results without reuse keys are analyzed once. Successful results are reused; failed/missing samples continue. `force: true` on `reels_start_analysis` explicitly bypasses reuse. Human overrides remain separate and win for the same content sample ID. Runs report `skippedSamples` and `analyzedSamples`.

`reels_start_analysis` accepts `model` and `reasoning`; precedence is MCP argument, `REELS_ANALYSIS_MODEL` / `REELS_ANALYSIS_REASONING`, then `gpt-6.1-sol` / `high`. No model picker is added. The CLI receives explicit `--model` and `model_reasoning_effort`. Runs expose requested values, per-call `calls`, and `usage` totals through search. Calls record input, cached input, output and reasoning tokens, observed actual model/effort, elapsed milliseconds and attached-image count. Missing event counters/model/effort are `null`, never inferred from requested settings or recorded as zero. Counter totals remain unknown if any call lacks that counter; no-call runs have no token total. CLI failures without observable events record unknown usage. No pricing/cost inference is made.

## Three selection stages — 2026-11-14

Selection is a separate, explicit operation: `reels_get_analysis_selection`,
`reels_run_analysis_selection` and `reels_update_analysis_selection`. Read its
own numeric revision before writes. Private `media-selection/<project hash>.json`
records candidates (usable/reason/human), groups (all member IDs, representative,
reason/human), and actual usage (sample/content/edit IDs). No member is deleted or
hidden. A model-success result is conservatively retained as usable with its scene
and uncertainties as evidence; humans can reject it with a reason. This deliberately
avoids silently dropping useful footage based on an unverified quality classifier.

Grouping runs independently of paid image analysis. It computes 64-bit dHash from
9×8 grayscale samples using the bundled FFmpeg, grouping within four differing bits
and mean brightness within 12/255. Each member is compared to the current group
anchor; groups are suggestions, not proof of the same scene. The higher grayscale
variance is the representative heuristic (stable sample ID tie break), with the
reason recorded. Human representatives survive regrouping while still members.
Explicit actual-use updates record content/edit attribution; mere folder membership
never counts as usage. UI controls and automatic reconciliation with existing edit
source/copy mappings remain follow-up work in TASKS.md.
