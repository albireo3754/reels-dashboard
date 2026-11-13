# Content history and evaluation pipeline

Markup editor saves now retain every changed version independently of the rotating recovery backups. This is local collection, not model training. Raw changes and feedback are never automatically gold labels.

## Save and feedback contract

The actual `POST /api/blog/save` → `MarkupStore` → `blog-markup-store.save` path writes to the manuscript's `.history/<filename>/content-evals/`:

- `revisions/<sha256>.json`: exact original text, including frontmatter, style, layout and media references. No media bytes are copied.
- `transactions/<uuid>.json`: before/after revision, exact replacement span (`start`, `removed`, `inserted`, UTF-16 offsets), caller-declared actor and its evidence, base revision, project ID when opened from a Dashboard card, linked decision IDs and merge/skipped-edit context.
- `receipts/<uuid>.json`: committed, recovered, not-observed or overwritten. An attempted write alone is not a successful revision.
- `events/<hash>.json`: explicit proposal keep/apply intent, ghost insertion/dismissal, annotation intent and observed external changes. Feedback retains `clientEventId`, request/review provenance, submitted revision and observed revision. Intent is not proof that a proposal survived save or undo.

The existing manuscript lock, merge, text guard and atomic rename remain in place. The journal is prepared before rename; failure preparing history leaves the manuscript unchanged. A crash after rename is reconciled under the same lock on the next load/save. If current bytes match a pending after-revision, recovery records `recovered`; otherwise it records `not-observed`, without guessing whether the content existed briefly. A second disk check after journal preparation narrows the external-writer race. Obsidian does not honor this lock; a later external overwrite remains possible. This is process-crash recovery, not a filesystem/power-loss transactional guarantee.

No-op saves make no new transaction. Client feedback retries use the same UUID; a conflicting payload under that ID is refused. Repeated content shares one revision snapshot; changing A→B→A still creates distinct save attempts. Durable revisions also supply old merge bases after rotating backups expire. No automatic retention policy deletes evaluation history; users should budget disk space for full text snapshots. Recovery currently scans transaction/receipt filenames, so this is a local article store, not a high-volume event service.

`actor: user` means the editor path/caller declared a user save, not authenticated human authorship. Direct API callers and programmatic editor operations can use that path. `actorEvidence` preserves this limit. External changes are `unknown`; no change is assigned an inferred reason. `projectId` can be null for the standalone editor, while `articleId` is a stable hash of its absolute path (moving a file creates a new identity).

Feedback is queued in browser localStorage before sending and retried on reload of the same article/origin. A changed server port creates a new browser origin: an unsent browser queue is not automatically migrated across it. Server-acknowledged events remain in the article store. Failure is shown in the editor. The current keep action still hides the suggestion only for the current editor view; this feature adds durable evidence, not permanent suppression.

## Observation boundaries

| Source | Collection |
| --- | --- |
| Markup editor manual/autosave, text/style/photo insertion/removal | Saved original text and exact before/after diff |
| Shared markup store called directly | Same journal; actor comes from caller |
| Review apply/keep, explicit ghost accept/dismiss, annotation | Automatic raw intent/observation; no reason required |
| External file edits | Observed at the next app load/save relative to last tool save; intermediate states and actual author unknown |
| Review request/run and published re-open evidence | Existing files imported with source identity; no new crawler |
| Legacy layered canonical editor | New journal is not wired into its separate save implementation |
| Naver SmartEditor direct edits | Not observed automatically; import a separately captured comparison/evidence file |
| Unsaved typing / undo / implicit ghost disappearance | Not all captured; snapshots reflect saved content; dismiss is not a semantic rejection label |
| User confirmation / gold / held-out evaluation | Explicit case record, never derived automatically from a diff |

## CLI and private dataset

Run from this checkout (Node 22.12+, repository dependencies). No API key or model call is needed for the deterministic demo:

```sh
npm run evals:demo
npm run evals -- import /private/import.yaml /private/dataset
npm run evals -- case /private/case.yaml /private/dataset
npm run evals -- freeze /private/experiment.yaml /private/runs
npm run evals -- replay /private/runs/FROZEN_ID
npm run evals -- compare /private/left/result.json /private/right/result.json
```

Use a directory outside Git for outputs, e.g. `~/.local/share/reels-dashboard/content-evals`. Import reads only explicitly listed files; it does not scan all chat histories or personal media. It snapshots the source, splits Markdown at headings/lesson boundaries, preserves file/hash/line/observation time, and exports `dataset.yaml` and quoted `dataset.csv`. JSON documents remain whole raw records. Identical source revisions/sections deduplicate on rerun. `contentId` lets downstream consumers group identical text from different sources while retaining both provenance records. These sections are raw evidence units, not 281 independent quality judgements or individual chat messages.

```yaml
version: 1
sources:
  - file: /private/article.notes.md
    kind: notes # notes, review, session-summary, published-comparison, experiment, history
    articleId: article-example
    split: development # new production can be holdout-candidate
```

Case records have a separate namespace and immutable revisions:

```yaml
version: 1
id: preserve-user-phrase
rawIds: [SOURCE_RECORD_SHA256]
status: candidate
split: development
input: Preserve the user's explicitly confirmed phrase.
expectedFindingIds: [unwanted-rewrite]
exhaustive: false
```

Confirm only after reviewing the cited raw record, frozen input, expected finding IDs and scope. `status: confirmed` requires `confirmation: {actor: user, by: ..., evidence: ..., at: ISO_TIMESTAMP}`. This is a local declaration/evidence contract, not an authentication system. Changing a case produces another hashed case revision. Historical `development` sources cannot be promoted to `holdout` by the case command. Reserve future unseen articles as `holdout-candidate` before using them to tune prompts; split declaration does not itself prove no leakage. This release does not add a labeling UI or automatic candidate selection.

## Adapter and judge contract

Experiment YAML/JSON declares `version: 1`, `name`, `model`, `workflow`, `settings`, absolute `adapter`, `files`, `cases`, `scope`, `unexecuted`, optional `timeoutMs` and `maxAttempts` (1 by default, at most 3). Each file has `file` and a role: `input`, `document`, `skill`, `role`, `workflow` or `dependency`. List every required guide/skill/role/dependency explicitly: the freezer snapshots their actual text and hashes, not just a guide filename. It does not discover transitive dependencies.

An adapter exports `run({directory,input,signal,attempt})` and returns:

```json
{
  "findings": [{"caseId":"case-id","ids":["finding-id"]}],
  "evidence": ["trace.json"],
  "usage": null,
  "execution": "fixture",
  "unexecuted": ["visual review"]
}
```

Execution is `fixture`, `model`, or `existing-artifact`. Usage is unknown (`null`) unless the existing runtime supplies measured numeric fields; do not turn missing usage into zero. Evidence must exist inside the attempt directory and is hashed. Started/finished attempt records retain retries, errors and cancellation. An interrupted process can leave `started.json` without `finished.json`: that is an incomplete attempt, not success. New replays create separate execution directories.

The adapter is trusted executable code, not sandboxed. Inputs are frozen in `packet.json` and content-addressed files. Later edits to original input files do not change the packet; active adapter/dependency source changes block replay and require a new freeze. Custom in-process adapters must honor `signal` and settle after stopping their work. `commandAdapter` wraps an existing CLI runtime without a shell, passes the frozen packet path, bounds output, kills the process group on cancellation/timeout, and captures stdout/stderr. It does not change credentials, provider/model defaults or the existing workflow engine. Use a wrapper around the existing v1/v2 runtime and map its results to this contract; role guidance remains in agent TOMLs and production procedures in their existing SKILL.md.

The initial judge is deterministic **finding-id-set/v1**, not an LLM judge. It requires confirmed cases, measures expected versus emitted IDs and records omitted/unconfirmed cases as `not-run`. It does not understand arbitrary Korean rewrites or align semantically similar findings automatically. Explicit ID mapping or a separately versioned adapter is required. Precision is null for non-exhaustive labels; recall is null when no positive findings are expected. Scores only cover declared scope. A completed execution can contain failed or unexecuted cases.

Pairs require the same frozen input/case hash and judge scope. Context differences are disclosed separately for workflow comparisons. `existing-artifact` pairs are never declared comparable model runs: a shared historical report does not prove equal original inputs. Fixture comparisons validate plumbing, not writing quality. [Fixture adapter](content-evals-examples/fixture-adapter.mjs) and [archive adapter](content-evals-examples/archive-adapter.mjs) are runnable examples; [demo](../scripts/content-evals-demo.ts) freezes two variants and produces pass/fail results without a model.

## Code and verification

- [History store](../src/shared/content-history.ts), [save integration](../src/shared/blog-markup-store.ts), [feedback endpoint](../src/app/blog-editor/content-feedback.ts).
- [Dataset/cases](../src/app/content-evals/dataset.ts), [runner/judge](../src/app/content-evals/runner.ts), [command adapter](../src/app/content-evals/command-adapter.ts).
- [Contract and HTTP tests](../tests/unit/content-evals.test.ts): two saves, duplicate/no-op, restart, failed journal, pending recovery, external attribution, import rerun, confirmation/holdout, paired replay/retry/abort.
- [Headless UI test](../tests/web/content-evals.spec.ts): actual direct edits, keep action, persisted revisions and reload. Existing autosave tests cover concurrent/stale writes, conflicts and retained alternatives.

Private import manifests, case candidates, historical comparison and learning HTML are stored outside this repository. The running production app is not restarted or replaced by these checks; source/build verification does not enable collection in an older installed app.
