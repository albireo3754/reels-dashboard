# External Edits automation

Edits tools operate the installed `/Applications/Edits.app` through the **running Reels Dashboard main process**, which owns a native `editsax` child. They do not edit project databases or compose a replacement video. The existing editor tools still edit Dashboard's own projects.

`reels tools --group edits` lists the group. Groups are filters: the command is **`reels edits-status`**, not `reels edits status`. MCP names are `reels_edits_*`. CLI and MCP derive input schemas from the same tool definitions and reach the same private app socket. When Dashboard is offline, they keep the existing app-offline error; neither starts a helper independently.

## Build and permission checks

```sh
npm run build:edits-native
npm run test:edits-native
npm run typecheck
npm run check:architecture
node --import tsx --test tests/unit/edits-automation.test.ts
npm run build
reels edits-status
```

The helper is a directly spawned signed executable, **not a second launched app**. Development uses `native/editsax/.build/editsax`; macOS packages include `Contents/Resources/native/editsax`. Builds require one Developer ID Application identity, optionally selected by `EDITSAX_SIGNING_IDENTITY` (or the existing Photos signing selector). A fresh staged binary is signed and verified before atomic replacement; an existing mapped executable is never overwritten in place. `package:mac` includes this build through `build:native`. There is no ad-hoc local fallback, new permission prompt or TCC database change.

`edits-status` reports the actual helper's `AXIsProcessTrusted()` result and the exact Edits app path/running/version information. **A direct child is an intended responsibility path, not proof of TCC attribution.** Verify the actual development and packaged Dashboard route before claiming one permission is sufficient. Terminal-side AX success does not establish Dashboard trust. If the app route is denied, report the actual helper/parent identity and ask the user through the task's status record to enable **System Settings → Privacy & Security → Accessibility → Reels Dashboard**. Do not open permission prompts automatically. Screen capture permission is checked separately.

## Session availability and deferred live acceptance

status.screenLocked is exactly true, false, or the string unknown. Only explicit false reports unlocked; unknown is not coerced to either boolean. The TS status boundary rejects malformed wire values. A read-only session observation recorded a locked screen while on-console and logged-in. Live GUI acceptance is deferred until the user unlocks the Mac. Do not repeat live AX/music/UI diagnoses, unlock/log in, activate windows or open permission/question prompts to force progress. The lock observation does not establish the cause of prior cannotComplete/root-cycle responses, and trusted status in an isolated Electron run does not prove ordinary installed-app TCC.

Keep code review, pure tests, headless web checks, compilation, isolated integration and packaging separate from that deferred work. The last live list was zero objects with complete=false; a successful package or mock test must not overwrite that result. Resume real read/edit/music/Export acceptance only after the session is available and the applicable review gates pass. No automatic polling for unlock is part of these tools.

## Commands and verification

All writes accept `--dry-run`. It returns `attempted:false`, `verified:false`, a plan and prompt-free status; it never presses, types, changes selection, imports, exports or copies a result. A successful transport call is not verification of a UI action.

| CLI slug / MCP suffix              | Operation and postcondition                                                                        | Mode / current validation                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `edits-status` / `edits_status`    | Actual helper trust, exact app path/version/running state, process identity                        | Read; real Dashboard route required                                        |
| `edits-ax-tree`, `edits-ax-find`   | Bounded nodes and concrete targets; return all selector matches                                    | Read; no synthetic tree on permission failure                              |
| `edits-ax-press`                   | Allowed intent + observed action/target; returns before/after and verification scope               | AX; conditional coordinate fallback only when non-execution is established |
| `edits-ax-set-value`               | Permitted editable field and value readback                                                        | AX; forbidden/unknown fields rejected                                      |
| `edits-menu`                       | `File>Import Media`, `File>Close`, `Clip>Duration`                                                 | AX allowlist                                                               |
| `edits-screenshot`                 | Edits-window PNG, dimensions and window ID                                                         | Separate capture permission; `--out` required in CLI                       |
| `edits-open-project`               | Observed project thumbnail → both supplied name and ID verified                                    | AX; may need a native-reported coordinate fallback                         |
| `edits-import-media`               | Closed chooser → a new persisted project Media alias linked to the exact available source          | AX + restricted dialog keys; originals untouched                           |
| `edits-clip-list`                  | Visible timeline IDs, labels, selection; optional read-only project metadata                       | Read; metadata availability is reported separately                         |
| `edits-clip-trim`                  | Inward trim through timecode/Trim start/end; source in/out readback                                | AX; expansion remains an explicit limitation                               |
| `edits-clip-mute`                  | Clip volume to −70 (−∞ display) or 0dB; readback                                                   | AX; the Sound adjustments toggle is not a mute switch                      |
| `edits-text-add`, `edits-text-set` | New/requested text ID and persisted exact body verified                                            | AX; optional Duration uses the observed dialog                             |
| `edits-audio-search`               | Observed response, explicit empty state, or completion=unconfirmed                                 | AX; preserve title/artist/version distinctions                             |
| `edits-audio-add`                  | Exact result label → one new music object at timeline zero, matching library title/artist/asset ID | AX; originals remain independent                                           |
| `edits-audio-volume`               | Music/audio kind checked before writes; UI dB and persisted gain verified                          | AX                                                                         |
| `edits-audio-segment`              | Slip tool and bounded track-frame drag; verify source in, fixed timeline start and duration        | Coordinate; geometry is a candidate until real metadata readback passes    |
| `edits-export`                     | Actual local Export success + exactly one new stable app MP4 + exclusive copy to a new path        | AX then file copy; no synthesis or publishing                              |

The TS workflow and validation paths are implemented, but **mock tests do not establish real app behavior**. The latest recorded real read is incomplete: an application-root cycle yielded zero timeline objects. Writes remain guarded and native review/fixes are ongoing. The TS re-review, final integrated HEAD review, packaged trust/read smoke and music acceptance are separate results. A missing control, denied permission, stale target, ambiguous match or changed internal project schema is an explicit failure, not blanket proof that Edits lacks the feature. Do not label an unexecuted method as app-verified.

Examples (replace the synthetic IDs/paths with observed results):

```sh
reels tools --group edits
reels edits-ax-tree --depth 12 --max-nodes 3000
reels edits-ax-find --selector '{"identifier":"editor.timecode"}'
reels edits-open-project --name 'Example project' --dry-run
reels edits-clip-list
reels edits-audio-search --query 'Where Our Blue Is'
reels edits-audio-add --result-label 'Where Our Blue Is, Tatsuya Kitani, · 3:16' --dry-run
reels edits-audio-volume --track-id 11111111-1111-4111-8111-111111111111 --decibels 0 --dry-run
reels edits-audio-segment --track-id 11111111-1111-4111-8111-111111111111 --in-seconds 10 --dry-run
reels edits-export --output-path /abs/new-edits-export.mp4 --dry-run
reels edits-screenshot --out /abs/edits-window.png
```

## Recorded validation boundary

- TS review fixes: **26 focused tests passed**. Edits plus socket/MCP/source-CLI checks: **120 passed, one fish-environment skip, zero failures**. Built CLI: **4 passed**. Type/FSD/public audit/diff checks and web/desktop build passed at the re-review snapshot. These source files are held for the independent re-review.
- The previous whole-unit checkpoint was 638 passed / five conditional skips / zero failures. It predates later review fixes and does not replace regression checks on the final integrated main.
- The Subrole-phase native handoff recorded 47 pure tests and release compilation. The signed child was exercised only through background Dashboard. Subsequent native policy/cycle changes are still under independent review; that earlier count is not a claim about the current native working tree.
- Real development evidence initially showed seven timeline objects in a partial 416-node tree. Diagnostics identified AXSubrole -25200. After the strict Subrole absence policy, a new read instead encountered an application-root cycle: **242 nodes, zero timeline objects, complete=false**. That run did not reach the original Subrole node. Neither real recovery nor read acceptance is established.
- Background status/diagnostic transport/export dryRun passed; this is infrastructure coverage, not editing or Export acceptance. `trusted:true` and screen-capture preflight describe that exact process route only. No live screenshot, editing or Export was performed.
- Packaging and actual installed-app TCC/behavior require their own checks. High-level writes stay blocked while the tree is incomplete. A signing success, build manifest or passing mock test does not satisfy those checks.

## Packaging and integration preparation

Build from a clean, tested worktree of the final integrated commit after the native owner has handed off fixed source. Keep any original checkout changes out of the build. These commands are preparation; they have not yet been run for the final integration:

```sh
npm run package:mac
REELS_ELECTRON_EXECUTABLE="$PWD/release/mac-arm64/Reels Dashboard.app/Contents/MacOS/Reels Dashboard" npm run test:electron -- tests/electron/edits.spec.ts
codesign --verify --strict 'release/mac-arm64/Reels Dashboard.app/Contents/Resources/native/editsax'
```

The package needs the PhotosIndex app and CLI, editor runtime, bundled reels CLI, and signed Edits AX binary. `package:mac` builds these using the existing build chain. Compare the packaged `Contents/Resources/native/editsax` and `Contents/Resources/cli/reels.mjs` with the artifacts from that same commit; record hashes and the actual package path. The background Electron test keeps the QA profile separate and does not install the user's global CLI launcher.

For lock-safe contract checks, set REELS_EDITS_STATUS_ONLY=1: the background test reads status once and exits before any AX tree or action. It also stops before GUI reads whenever screenLocked is true or unknown, preserving the distinction between a known lock and unavailable session state. The packaged test must retain raw status/tree diagnostics and the observed clip-list completeness when those live reads are permitted. A skipped AX path or partial/zero-item read is not real read acceptance. Do not exercise writing commands until the app route is trusted, the full tree is safe and the applicable review gates pass. Runtime or permission failures need their exact evidence and outcome; they must not trigger an alternate terminal helper or uncertain action replay.

Main integration remains a separate gate: re-read the latest main and original staged/unstaged/untracked paths, integrate competing changes in the isolated worktree, and obtain the final independent review of that HEAD. Only then consider a non-overlapping `--ff-only` main update. Do not stash/reset or include another session's changes. Build/apply the validated commit, preserve active user jobs/unsaved data, and do not create an installation `.app` backup unless requested. No push is part of this work.

Only remove the owned worktree/branch after the build/application checks finish and the coordinator confirms no native worker, app or other process still uses its cwd. Until then keep the source and review evidence available.

## Raw native boundary

One request per child: stdin JSON `{protocol:1,id,operation,args}` then EOF, one stdout `{protocol:1,id,ok,result}` or `{protocol:1,id,ok:false,error:{code,message,details}}`. Main checks protocol, request ID, exit status, 16MiB output and timeout, and disposes its tracked children. No runtime helper-path override, independent helper socket, arbitrary shell command or CLI-direct spawn path is provided.

A concrete AX target is `{pid,root,path,fingerprint}`. `root` distinguishes application children from the separately reacquired menu bar. Targets are rechecked immediately before use; a changed PID/path fingerprint fails stale rather than selecting something similar. A caller-supplied intent is not authorization: native policy must match the actual node, ancestors, focus and dialog. Unknown/localized/unlabelled controls fail closed. Press intents cover editor controls, timeline/home selection, library results and the specific import/Duration confirmations; values cover timecode, audio search, clip volume, text content, import paths and Duration.

Coordinate fallback cannot replay an uncertain action. Only an absent AXPress or an authoritative not-implemented/action-unsupported result may establish non-execution. Timeout, cannot-complete, lost response, ordinary failure, or API success with unchanged UI is **unknown**, so read state and stop. Each high-level command performs its own postcondition check. A failed multi-step command may have applied earlier steps; never retry the whole write automatically.

The internal `Timeline.db` schema is an observed implementation detail. Reads use SQLite read-only mode against the live database/WAL; no project file is edited, copied into source fixtures or used as an alternate write API. A current project is linked through visible clip IDs. Unknown format/ambiguity is reported. Private paths, production databases and media stay outside this repository.

## Object and import verification

When project ID and name are both supplied, both must match, including the already-open path. Audio volume accepts music/audio objects and clip mute accepts video objects; unknown or wrong kinds fail before selection or value changes. Text add verifies one new text ID and its persisted body; text set verifies the requested text ID, body and any requested duration. A matching inspector field or another text object is insufficient.

Import completion is proved by the currently linked project, closed chooser, a new persisted current-project Media alias and exact available source identity. The result declares verification.kind=persisted-media-import and mediaPanelVisibility=not-assessed: it does not assert that the item is displayed in a Media panel. Unrelated UI labels/buttons neither prove nor disprove that persisted import; a missing alias or incorrect source fails verification. The adapter reads MediaIndex.db and the linked non-credential asset fields in Media.db with SQLite read-only mode. External sources must resolve to the explicitly selected canonical path and size; a managed copy must match exact bytes (streaming SHA-256) within the library Media directory. Same-basename ambiguity is rejected. File chooser values never prove import completion. Original files are not changed. This source-identity check is specific to importing and is not a recurring video-quality/hash audit.

Search returns verified results after an observed response/settled result view, or verified empty results after an explicit empty-state cue. A different query can legitimately return identical results after an observed loading/list transition. If only the query text changes and no fresh-response/empty-state evidence is observable, return the currently seen results with completion=unconfirmed and verified=false. Repeating that query, including from a fresh service instance, does not promote the unchanged view to verified; an actual response transition or completion cue is still required. For an unconfirmed view, do not label that a missing song or a failed feature, and do not replay the query automatically.

Native Snapshot.diagnostics is preserved in tree/find/action snapshots. Edits-specific errors preserve the native operation's attempted boolean and fallback (coordinate or null), plus bounded diagnostic counts/samples and AX API/attribute/role fields through the private socket, CLI and MCP; arbitrary details, labels, values and raw error messages are not copied into this diagnostic channel. Confirmed absent Subrole counters are distinct from truncation reasons. An absence count never implies the whole tree is complete. attempted/fallback describe the reported native operation; an earlier step in a high-level command may already have applied. They do not turn outcome=unknown into not-applied or authorize an automatic replay.

## Audio workflow and limits

Keep original clip sound and select the exact song from Edits' own library. If the title is unknown, obtain the user's song choice through the applicable task flow; never treat a question screen's selected option as their answer. Do not download external music or attach a reference video's extracted mix as a substitute.

Capture title/artist/version and the selected music object's library metadata. Export candidate segments through Edits; compare their decoded waveform correlation/lag and RMS with the reference using the same measurement method. A signal match does not establish library provenance. Apply the measured source start/volume and re-read the actual values; preserve video cuts/hook/duration. Keep prior outputs in the content workspace, then deliver a verified Edits export. The export command refuses existing destination files; replace a fixed delivery file only after independent verification in the authorized content workflow.

Unsupported or unverified scope: importing beyond current dialog capabilities, expanding existing trimmed clips, unidentified controls, unknown deep links, exact timecode input when fps cannot be established, project formats beyond the observed schema, and real slip precision until readback succeeds. No Instagram post/share automation, authentication handling, Photos move/delete or project-DB writes are exposed.
