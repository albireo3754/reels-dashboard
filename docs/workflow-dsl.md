# YAML production workflows

A versioned YAML file defines the steps, skill/tool contracts, input/output files, completion criteria and transitions. The current Codex session performs each pending step; the existing LangGraph checkpoint service persists results. Dashboard renders the **stored definition plus that run's state**, rather than a separately maintained diagram. Existing editorial runs keep their original behavior.

## Start and resume

Use the [session skill](../skills/reels-workflow/SKILL.md). For blog production use the [built-in `blog` definition](#built-in-definitions-and-local-guides--2026-11-13) and put personal documents, instructions and skill names in a local guide file. For other work, copy [production.yaml](workflow-examples/production.yaml) into a private content workspace and add that workspace's skill names/paths and channel-specific instructions. Keep real media, facts and credentials outside this source repository. The sample uses real Desktop MCP tool names but does not grant permission to deliver or publish.

Validate through `reels_workflow_validate-definition` or CLI:

```sh
npm run --silent workflow -- validate-definition /absolute/path/to/definition-input.json
npm run --silent workflow -- create /absolute/path/to/run-input.json
npm run --silent workflow -- context <run-id>
```

Definition input: `{"workspace":"/absolute/path/to/content","definitionFile":"workflow.yaml"}`, or `{"workspace":"…","builtinDefinition":"blog","guideFile":"/absolute/path/to/workflows/blog.guides.yaml"}` (exactly one of `definitionFile`/`builtinDefinition`; `guideFile` optional). With a guide the result has `guide: {file, sha256, base, steps}`, showing per step the documents (path and hash), instruction, skills and tools that will be attached. The result also carries `skippable: {skipped, startsAt}`, a dry run of the leading steps a new run would skip (see [Idempotent steps](#idempotent-steps--2026-11-13)).

Run input:

```json
{
  "title": "Production work",
  "projectId": "existing-dashboard-project-id",
  "workspace": "/absolute/path/to/content",
  "definitionFile": "workflow.yaml",
  "instructions": "Read the workspace rules and brief; preserve confirmed facts.",
  "trackedFiles": ["brief.md"],
  "maxRevisions": 2
}
```

Use `"builtinDefinition": "blog"` instead of `definitionFile` for the app-owned blog flow, and add `"guideFile"` for a local guide. `skipCompleted` (default `true`) enables [idempotent steps](#idempotent-steps--2026-11-13); pass `false` to work every step from the entry. `projectId` is a stored association, not a lookup that creates/merges a Dashboard card. The current session can discover that card with the Desktop MCP. The new-workflow UI accepts the same fields. Open `http://127.0.0.1:4318/?workflow=1&run=<run-id>` to see topology, current state, per-step contracts, original YAML and copyable resume context. Polling refreshes state after another session submits a result.

`reels_workflow_context {runId}` / CLI `context` returns the pending task, expanded output paths, input hashes, definition hash, project ID and latest result. It does not restart or create a chat. A different Codex session can read the same task and submit its result; the first accepted submission advances the checkpoint and other submissions become stale. This is durable workflow handoff, not an exclusive lock on external work. Do not have two sessions perform the same external mutation concurrently.

## Definition v1

```yaml
version: 1
id: review-cycle
title: Write and review
entry: write
maxTransitions: 20
steps:
  - id: write
    title: Write a candidate
    kind: task
    instruction: Read the brief and latest review; write a candidate.
    skills: []
    tools: []
    inputs: [brief.md]
    outputs: [draft.md]
    completion: [Confirmed facts are preserved]
    on: {done: review}
  - id: review
    title: Review the candidate
    kind: review
    instruction: Inspect the candidate without changing tracked inputs.
    inputs: [draft.md]
    outputs: ['review-{attempt}.md']
    completion: [Record specific evidence for pass or revision]
    on: {pass: $complete, revise: write}
```

- Steps have unique IDs, a title, `kind`, instruction, completion criteria and `on` transitions. Unknown keys, duplicate YAML keys, custom tags, aliases, unreachable steps, missing targets and success-path cycles are rejected. Every step must have a completion path. Review `revise` is the only loop mechanism. There is no shell/eval/interpolation language.
- `task` accepts `done`; `review` accepts `pass`/`revise`. `blocked` and `cancel` are available globally. `$complete` ends the run. `maxRevisions` is a run-wide review-loop budget; `maxTransitions` bounds total recorded steps. Restart does not reset either.
- `skills` contains names from the session's available skills or explicit SKILL.md paths; Codex resolves and reads them. `tools` contains `{server, name, purpose}`. These are returned to Codex and shown in Dashboard. They do not automatically execute tools, verify tool availability, impose a tool sandbox, or prove invocation. Actual authorization remains with the user and the tool boundary.
- `inputs` and `outputs` are normalized workspace-relative files. Inputs must exist when entering the step. All declared outputs must be included in successful submission evidence and must exist. Files are realpath checked; workspace escapes are rejected. `{attempt}` in outputs expands to the persisted sequence + 1; use it for immutable review reports. Exact returned paths are in `task.step.outputs`.
- `completion` is the semantic acceptance contract for the session/reviewer. The server verifies IDs, transitions, file existence/hashes and budgets, not prose quality, factual correctness or whether a media tool was actually called. Record real tool job/receipt paths in evidence.
- Every accepted result retains step ID, outcome, summary and evidence hashes. Source/artifact files remain owned by the content workspace; the service stores hashes, not versioned copies of all artifact bytes. Reviews use fresh reports and cannot overwrite tracked inputs. For changed input, `restart` issues a new task/hash snapshot; it never edits the stored definition.
- The YAML text, SHA-256 and parsed definition are stored in the checkpoint at create. Resume continues that snapshot even when the YAML on disk changes. New definitions require a new run. Existing non-DSL runs are not converted.

## Shared definitions — 2026-11-13

Prefer one shared definition per kind of work over a hand-written `workflow.yaml` per piece. `definitionFile` accepts either a workspace-relative path or a **normalized absolute path** to a `.yaml`/`.yml` file whose real path sits directly inside a `workflows/` folder of a proper ancestor of the workspace. Example: workspace `<root>/research/<slug>` may use `<root>/workflows/blog.yaml`.

- The real path (symlinks resolved) must satisfy the rule, so a link inside `workflows/` that points elsewhere is rejected. Nested folders (`workflows/a/x.yaml`), a filesystem-root `/workflows/`, sibling trees, a `workflows/` inside the workspace itself, `..`/`.` segments and non-YAML files are rejected with `SHARED_DEFINITION` or a schema error. No configuration or environment variable widens this.
- Step `inputs`/`outputs`/`formFile` stay workspace-relative, so one definition serves every workspace under that root.
- The run stores the absolute path, the YAML text, its SHA-256 and the parsed definition exactly as for workspace definitions. Editing the shared file never changes existing runs; Dashboard renders the stored snapshot.

## Built-in definitions and local guides — 2026-11-13

**The app owns the flow; detailed guidance and personal taste stay local.** A built-in definition fixes the steps, kinds, transitions, inputs/outputs, completion criteria, `{attempt}` review reports and only general, publishable instructions. A local guide file in the private content tree points each step at local documents, adds instructions and names skills/tools. Nothing in a guide can change the flow.

### Built-in definitions

Select one by name with `builtinDefinition` on `validate-definition` and `create` (MCP, CLI and the new-workflow UI's 「앱 내장 워크플로」 select all use the same server fields). It is mutually exclusive with `definitionFile`; no file is needed in the workspace. The text lives in [`builtin-definitions.ts`](../src/app/workflow/builtin-definitions.ts), is parsed by the same validator, and is stored per run like a file (`definition.file` = `builtin:<name>`, YAML text, SHA-256, parsed definition). App updates do not change existing runs; skipping, the Dashboard graph and the stored YAML view work unchanged.

| Name | Steps | Media and composition rules |
|------|-------|-----------------------------|
| `blog` | `prepare` (task) → `experience` (input, `experience-form.json`) → `draft` (task) → `image_review` → `text_review` (reviews) → `layout` (task) → `visual_review` (review) → complete. Reviews revise to `draft`; `visual_review` revises to `layout`. | [photo-first-drafting.md](photo-first-drafting.md) is the source of truth; the step instructions name its sections instead of repeating them. |

`blog` outputs: `evidence/media-scenes.json` + `experience-form.json`; `article.markup.md`, `story-layout.md`, `evidence/story-media-plan.json`; `reviews/image-review-{attempt}.md` + `reviews/image-plan-{attempt}.md`; `reviews/text-review-{attempt}.md`; `publishing/smarteditor-draft-layout.html` + `reviews/layout-review.md`; `reviews/visual-review-{attempt}.md`. Step IDs and file names are kept stable so existing article folders are adopted by [idempotent steps](#idempotent-steps--2026-11-13).

### Local guide file

```yaml
version: 1
definition: blog          # optional; must equal the definition id when given
steps:
  draft:                  # a step id of that definition
    docs: [style/writing.md, templates/images.md]   # relative to the guide's base folder
    instruction: Follow the local image rhythm template.
    skills: [my-layout-skill]
    tools: [{server: my_server, name: my_tool, purpose: Why the step uses it}]
  image_review:
    instruction: Apply the local editorial gates.
```

- `guideFile` follows the `definitionFile` path rule: workspace-relative, or a normalized absolute YAML path directly in `<ancestor>/workflows/` (same [shared boundary](#shared-definitions--2026-11-13), errors start with `GUIDE:`). It is allowed with any definition, built-in or YAML.
- `docs` are normalized relative paths from the guide's **base**: the workspace for a workspace guide, or the folder holding `workflows/` for a shared guide. Real paths (symlinks resolved) must stay inside the base and be files; absolute paths, `..`, missing files and links that leave the base are rejected.
- Each step entry accepts only `docs`, `instruction`, `skills`, `tools`. Flow keys (`on`, `kind`, `inputs`, `outputs`, `completion`, `title`, …), unknown step IDs, top-level keys other than `version`/`definition`/`steps`, YAML aliases and duplicate keys are rejected.
- The task's `instruction` and `step.instruction` become the definition instruction followed by `로컬 가이드 (<guideFile>):`, the guide instruction and `먼저 읽을 문서:` with absolute document paths. `step.skills`/`step.tools` append the guide's entries (duplicates dropped). Inputs, outputs, transitions and completion are those of the definition.
- The guide file (its YAML text and SHA-256) is frozen with the run, like the definition. **Document contents are never copied**: the run stores each document's path and SHA-256 at create. Documents are not tracked inputs; editing one later does not make a review `STALE_INPUT`.
- No guide: the run uses the built-in instructions only. The step contract in Dashboard shows a 「로컬 가이드」 row for steps that have one.

## Idempotent steps — 2026-11-13

When a run created with `skipCompleted: true` (the default) reaches a step **for the first time**, the runtime checks whether that step's results already exist. If so, it records the step with outcome `skipped`, the reason and the evidence file hashes, adds the evidence to the tracked files, and moves on without issuing work. Dashboard labels it 「기존 산출물 채택 · 건너뜀」.

| Step | Skipped when | Only while |
|------|--------------|------------|
| `task` | Every declared input exists and every output exists and validates: `media-scenes.json` parses and its previews exist; `story-media-plan.json` parses and covers the scenes of its `inventory`; the input step's `formFile` is a valid form **or**, only when that file does not exist, submitted answers exist (recorded in the reason); other outputs exist and are non-empty. | Nothing in this run has been worked yet (all earlier records are `skipped`). After real work, later task steps always run, so a revised draft never skips a now-stale layout. |
| `input` | Its declared inputs exist, and one submitted answers export in the workspace root (`experience-answers-*.json` written by the shared form service) answers every question of the current `formFile` with the same prompt (`unknown`/`omit` count). Only a form file that does not exist counts as absent: then only a leading step accepts the newest submitted answers. A form file that exists but is unreadable, oversized or invalid (including a dangling link), or whose question images break the form-registration rule (JPEG/PNG/WebP, at most 4 MB), blocks the skip. The form file and its question images are recorded and tracked with the answers, so later changes to them are `STALE_INPUT` at review. | Any first visit. A form with a new, unanswered question opens the form as before. |
| `review` | Never. Reviews always run, even when report files exist. | — |

Never skipped either: steps with `{attempt}` outputs, and a step whose `done` would complete the run. A revisited step (after a review `revise`) always runs, and a step is not skipped when its own or the next step's declared inputs are missing or cannot be read. The skip's evidence files (outputs, scene previews, submitted exports, the form file and its question images) are read (hashed) before a skip is returned; if one cannot be read (for example no read permission), the step runs as normal work instead of leaving the run held. An adopted step's declared inputs are tracked like those of a worked step, so later reviews detect changes to them. Skipped records count toward `maxTransitions`. The runtime and the `validate-definition` preview use one rule (`adoptStep` in `src/app/workflow/adopt.ts`), so the preview's `startsAt` matches a run created from the same files. A found skip is judged again immediately before it is recorded. If the server stopped in between, the next start re-judges it: still valid → recorded; changed → the step is requested again as normal work. A run whose recovery fails is logged and left for an explicit `restart`; it does not stop the server from opening other runs. Skipping is a precondition check, not a quality judgment: the following review is still expected to read the adopted artifacts. `validate-definition` previews the leading skips; a later input step can still be skipped once its form file exists.

**Photo plan on submission.** A task step that declares an output named `story-media-plan.json` (by file name, as skipping judges it) gets the same plan check on a `done` submission as the built-in draft stage: exactly one tracked `media-scenes.json`, `inventory` equal to its path, the inventory and its scene previews unchanged since the task was issued, and one decision per scene (`MEDIA_PLAN_COVERAGE` otherwise). When such a step is requested, the previews named in the tracked `media-scenes.json` are added to the tracked files and its input hashes, as the built-in prepare stage does; a skipped prepare already records them as evidence. Submitting the step before it also checks those previews. `blocked`/`cancel` and steps without that output are unchanged.

Submitting the same result twice cannot corrupt state. The first accepted submission advances the run; a repeat with the already recorded `taskId`, the same outcome and the same evidence files with unchanged hashes changes nothing and fails with `STALE_TASK: ALREADY_RECORDED …`, so the caller knows its result is already in history. This applies to YAML runs only; built-in stages add derived evidence, so their repeats stay plain `STALE_TASK`. Any other late submission fails with plain `STALE_TASK`. A silent success is deliberately not returned, because another session submitting the same task must not believe its own work was accepted. Re-submitting a form is already rejected by the form service (`STALE_FORM`).

## User input

`kind: input` uses the existing shared experience form, not a second input UI. A prior task must produce a valid form JSON (see [experience intake](experience-intake.md)):

```yaml
- id: experience
  title: Your experience
  kind: input
  instruction: Answer from actual memory; unknown and omit are valid.
  formFile: experience-form.json
  completion: [The user submits explicit responses]
  on: {done: draft}
```

V1 supports one input step per run. Revision paths cannot return to that step. The runtime validates/registers the form and waits; generic `submit done` and SDK execution cannot bypass it. The shared form UI/API preserves actual answers and exports them into tracked inputs before advancing. Input outputs are assigned by the form service, so do not declare `outputs` for this kind. Do not combine a DSL run with the legacy `collectExperience`/`inputFormId` flags.

## Boundaries and connection

This uses the existing workflow HTTP server and independent `reels_workflows` stdio MCP from [workflows.md](workflows.md#mcp). The workflow server protocol is now **7** (5: shared definitions, `skipCompleted`, `skipped` records; 6: cross-review fixes to the skip rules; 7: `builtinDefinition` and `guideFile`); rebuild and restart an older host to use it. No client MCP configuration is changed automatically. An already-open chat can use the official CLI without waiting for MCP reconnection.

Desktop editing/Photos/render tools still require the running app and its `reels_dashboard` MCP or equivalent CLI. The YAML runner does not add unsupported multi-clip editing. DSL tasks are deliberately session-executed: the existing read-only SDK cannot invoke their MCP/skills contract and is disabled for them. Final public publishing remains manual.

## Verification — 2026-11-12

- Runtime tests cover frozen definition/task persistence across restart, invalid YAML and topology, workspace escapes, required outputs, stale/duplicate results, distinct review reports, user-form submission and revision/transition budgets.
- Full unit suite: 468 passed, 4 conditional skips (472 discovered). After the project association addition, DSL and shared-form tests were rerun separately.
- All 7 workflow browser scenarios passed. The DSL scenario creates from the UI, validates/reads/submits through a real stdio MCP, observes the same state on desktop/mobile widths, restarts the server, resumes through CLI and completes through the UI. Screenshots were inspected.
- Three isolated background Electron scenarios passed, including a YAML run through the desktop bridge, embedded-server lifetime and rejection of an outdated host. They use temporary profiles and do not touch the user's live app/data.
- Typecheck, FSD checks, web/desktop builds, public-source audit and diff whitespace checks passed. `verify:spec` still fails on the pre-existing `AppCommandRouterTests.swift` baseline hash mismatch; neither that Swift file nor its baseline was changed.
- No model was invoked to pretend to perform content work, and no real media was edited/delivered. The implementation and source builds are ready; the running installed app was not replaced. Apply the new build and reconnect workflow MCP clients to use protocol 4 there.


## Installed rollout — 2026-11-12

After explicit user authorization, the new package passed the three background Electron checks and replaced the existing app at `release/production-projects/mac-arm64/Reels Dashboard.app`. The prior app and closed workflow data were backed up under `release/workflow-dsl-20261112/`. Installed/package app.asar hashes matched; developer mode and the existing data profile were preserved. Fresh stdio MCP clients confirmed protocol 4, DSL tools, project state, and preserved workflow tasks/history. A real content workflow progressed through Photos discovery and preparation to the shared user-input form; the private receipt stays in its content workspace.

The live Photos inspection exposed degraded 64px fast-format thumbnails. `EvidenceInspectionService` now requests high-quality previews, using the existing provider's requested 1024px bound and degraded-result filtering. The signed helper was rebuilt and applied to the installed/prepared package. The existing timeout/cancellation test passed; actual Photos photo/video previews returned 1024px with readable signage/menu OCR. Search remains separate and originals are unchanged. No claim is made that a Photos video preview is a full video/audio review.

Native UI observation through computer use timed out; live MCP state and the packaged isolated UI checks were verified. The shared form-open API reported its desktop window opened.

## Verification — 2026-11-13 (shared definitions, idempotent steps)

- `tests/unit/workflow-idempotent.test.ts` (synthetic fixtures): shared-definition load/snapshot; rejection of other trees, nested folders, symlink escapes, a workspace-internal `workflows/`, non-normalized and non-YAML paths; leading skip with recorded evidence and a review that still runs; invalid plan/preview stopping the skip; `skipCompleted:false`; mid-run input skip only when answers cover the current form; repeated identical submission reported as `ALREADY_RECORDED` without changing the run; `{attempt}` task outputs never skipped (preview matches); no skip when the next step's inputs are missing.
- Workflow unit tests 54/54. Full unit suite 538 passed, 7 skipped, 1 failed: `face-mosaic.test.ts`, which fails identically on `main` without this change. Typecheck, architecture check, public audit, `build`, 7 workflow UI scenarios and 3 background Electron workflow scenarios passed.
- Dry run on a real private blog workspace with a temporary data root (the workspace was only read; file hashes were identical before and after). With the shared blog definition, a run started at the first review when the inventory, submitted answers and plan already existed. After the content session added a form with two new questions, `prepare` was skipped and the run waited at `experience` with only those questions open.
- A fixed review output (for example `reviews/plan.md`) cannot be rewritten on the second review after a `revise`: the first review tracks it, so rewriting it is `STALE_INPUT`, and resubmitting it unchanged violates the fresh-report rule. Use `{attempt}` for every review output.

## Cross-review fixes — 2026-11-13

A Codex cross review of `0c932be..8ae4403` led to these changes: a present but invalid form no longer counts as missing; input steps check their own inputs; skipped input steps track the form file and question images; preview and runtime share `adoptStep`; pending skips are judged again before recording and on start, with per-run failure isolation; `ALREADY_RECORDED` is limited to YAML runs. Each has a reproduction in `tests/unit/workflow-idempotent.test.ts`. Not changed (user decision): draft-submission plan validation for YAML runs, counting skips toward `maxTransitions`, and adopting the newest answers when no form file exists.

A second Codex review (`8ae4403..b2c6cb7`) led to two more changes: the own/next-input check reads (hashes) the files instead of only resolving them, and question images use the same validator as form registration (`checkedImage` in `src/app/workflow/files.ts`). Both have reproductions in the same test file.

## Verification — 2026-11-13 (built-in definitions, local guides)

- `tests/unit/workflow-builtin-guide.test.ts` (synthetic fixtures): `blog` selected by name with no file in the workspace (7 steps, `{attempt}` review outputs, stored text and SHA-256); exactly one of `definitionFile`/`builtinDefinition`, and a guide needs a definition; a shared guide merged after the built-in instruction with absolute document paths, appended skills/tools and unchanged outputs/transitions; document bodies not stored and the guide snapshot frozen; rejection of unknown steps, flow keys, a mismatched `definition`, `..`/absolute/missing documents, a link leaving the base, guide files outside the `workflows/` rule and duplicate YAML keys; a workspace guide; skipping with a built-in definition and a guide (starts at the first review, which carries the guide).
- Workflow unit tests 68/68. Full unit suite 560: 552 passed, 7 skipped, 1 failed (`face-mosaic.test.ts`, the known failure on `main`). Typecheck, architecture check and public-source audit passed.
- Browser e2e (`test:workflow-ui`) could not run: Playwright fails to load every spec with `TypeError: (0 , api_1.createContextKey) is not a function` from the OpenTelemetry exporter imported through `src/app/workflow/server.ts`. The same happens on an unchanged copy of `main`, so it is an environment/dependency issue, not this change. A new scenario was added to `tests/workflow/definition.spec.ts`; the same flow (select `blog`, give a guide, see the guided first request and the 「로컬 가이드」 contract row) was checked by hand in a headless browser against an isolated server.
- Dry run on a real private blog workspace with a temporary data root: the built-in definition and the earlier shared YAML definition gave the same skip result (three leading steps adopted, start at `image_review`), and the guide attached to six steps. Workspace files were only read.
