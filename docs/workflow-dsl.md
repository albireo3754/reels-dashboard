# YAML production workflows

A versioned YAML file defines the steps, skill/tool contracts, input/output files, completion criteria and transitions. The current Codex session performs each pending step; the existing LangGraph checkpoint service persists results. Dashboard renders the **stored definition plus that run's state**, rather than a separately maintained diagram. Existing editorial runs keep their original behavior.

## Start and resume

Use the [session skill](../skills/reels-workflow/SKILL.md). Copy [production.yaml](workflow-examples/production.yaml) into a private content workspace and add that workspace's skill names/paths and channel-specific instructions. Keep real media, facts and credentials outside this source repository. The sample uses real Desktop MCP tool names but does not grant permission to deliver or publish.

Validate through `reels_workflow_validate-definition` or CLI:

```sh
npm run --silent workflow -- validate-definition /absolute/path/to/definition-input.json
npm run --silent workflow -- create /absolute/path/to/run-input.json
npm run --silent workflow -- context <run-id>
```

Definition input: `{"workspace":"/absolute/path/to/content","definitionFile":"workflow.yaml"}`.

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

`projectId` is a stored association, not a lookup that creates/merges a Dashboard card. The current session can discover that card with the Desktop MCP. The new-workflow UI accepts the same fields. Open `http://127.0.0.1:4318/?workflow=1&run=<run-id>` to see topology, current state, per-step contracts, original YAML and copyable resume context. Polling refreshes state after another session submits a result.

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

This uses the existing workflow HTTP server and independent `reels_workflows` stdio MCP from [workflows.md](workflows.md#mcp). The workflow server protocol is now **4**; rebuild and restart an older host to use it. No client MCP configuration is changed automatically. An already-open chat can use the official CLI without waiting for MCP reconnection.

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
