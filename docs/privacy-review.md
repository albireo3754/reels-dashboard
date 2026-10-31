# Publication privacy review — 2026-10-31

The review covered all 14 commits reachable from the two repository branches, tracked files, non-ignored untracked files, commit metadata and the public demo screenshot. No credential pattern, actual home directory, runtime database or personal photo/video was found in those commits. Email and phone fixtures were synthetic; commit emails used GitHub noreply addresses. Public repository links and third-party attribution remain intact.

Personal social-account defaults and the developer-specific native bundle identifier were replaced throughout branch history. The bundled editor inventory was updated consistently. Current uncommitted source, tests and documentation were also sanitized, including the private briefing deployment URL. Existing feature work remains uncommitted. Changing the native signing identifier can cause Photos permission to be requested again after rebuilding; this review does not rebuild or restart the running app.

## Before committing and pushing

Enable the tracked hooks in each checkout:

```sh
git config core.hooksPath .githooks
npm run audit:public
node scripts/audit-public.mjs --history --all
node --import tsx --test tests/unit/public-audit.test.ts
```

The pre-commit hook reads index blobs, so a clean working copy cannot hide a sensitive staged version. The pre-push hook checks the full ancestry of each pushed revision, including older commits whose current files have already been cleaned. Deletions do not require scanning. CI fetches complete history and checks the checked-out revision before dependency installation. Hooks can be bypassed and must be enabled in new clones; CI is an additional check after upload, not a substitute for local review.

The scanner reports filenames and categories without printing matching values. It detects home paths, common credential formats, personal email/phone patterns, account signatures, private deployment URLs and prohibited data paths/extensions. Explicit synthetic test values are allowed. It is not a general PII detector: unknown token formats, arbitrary prose, filenames, EXIF and image pixels still need human review. The checked-in dashboard screenshot was visually confirmed to contain synthetic UI data.

## History-removal boundary

Both remote branch tips were rewritten using an atomic push with exact force-with-lease protection. Remote refs were re-read after the push. GitHub-owned pull-request references, cached commit pages, Actions artifacts and other people's clones are outside a branch rewrite. The closed PR #1 reference (`refs/pull/1/head`) was confirmed to still point to the old history after the push. Complete server-side removal requires GitHub Support; not all GitHub copies have been erased. Never merge an old clone's history back into cleaned branches.

Validation: audit regression (staged/working divergence, ancestor detection, masked output, credential and database rejection), five publishing/follow-template tests, four editor timing/inventory/architecture checks, signing-script tests and preservation of 26 upstream test files / 75 methods passed. A full app build and live Photos permission flow were not run for this cleanup.
