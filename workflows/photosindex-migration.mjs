import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export const meta = {
  name: 'photosindex-migration',
  description: 'Specify every PhotosIndex contract, migrate to Electron/React, verify both surfaces, and optionally publish.',
  phases: [
    { title: 'Specification', detail: 'All Swift tests and the real UI/CLI contract precede implementation.' },
    { title: 'Repository', detail: 'Initialize an isolated repository and freeze shared contracts.' },
    { title: 'Migration', detail: 'Native, Electron, and React owners work in separate directories.' },
    { title: 'Integration', detail: 'Reconcile contracts without removing requirements or tests.' },
    { title: 'QA', detail: 'Independent browser-renderer and Electron agents exercise the app.' },
    { title: 'Acceptance', detail: 'Run actual checks and audit the complete requirement matrix.' },
    { title: 'Publication', detail: 'One owner publishes the reviewed repository only with --publish.' },
  ],
};

const reportSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'evidence', 'blockers'],
  properties: {
    status: { type: 'string', enum: ['passed', 'failed', 'blocked'] },
    evidence: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
  },
};

function options(args) {
  const result = { source: process.env.PHOTOSINDEX_SOURCE, repo: undefined, publish: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source') result.source = args[++i];
    else if (args[i] === '--repo') result.repo = args[++i];
    else if (args[i] === '--publish') result.publish = true;
    else throw new Error(`Unknown workflow argument: ${args[i]}`);
  }
  if (!result.source) throw new Error('Provide --source or PHOTOSINDEX_SOURCE. The source is read-only.');
  if (result.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(result.repo)) {
    throw new Error('--repo must be an explicit GitHub owner/repository.');
  }
  if (result.publish && !result.repo) throw new Error('--publish requires --repo owner/repository.');
  return { ...result, source: resolve(result.source) };
}

function assertReport(report, label) {
  if (report?.dryRun === true) return;
  if (report?.status !== 'passed' || !report.evidence?.length || report.blockers?.length) {
    throw new Error(`${label} did not pass: ${JSON.stringify(report)}`);
  }
}

async function command(file, args, cwd, logPath) {
  const startedAt = new Date().toISOString();
  const chunks = [];
  const exitCode = await new Promise((accept, reject) => {
    const child = spawn(file, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', accept);
  });
  const output = Buffer.concat(chunks).toString('utf8');
  await writeFile(logPath, output);
  if (exitCode !== 0) throw new Error(`${file} ${args.join(' ')} failed (${exitCode}); inspect ${logPath}`);
  return { command: [file, ...args], exitCode, startedAt, finishedAt: new Date().toISOString(), logPath, output };
}

export default async function run(ctx) {
  const config = options(ctx.args);
  const cwd = resolve(ctx.cwd);
  const source = config.source;
  if (source === cwd) throw new Error('Source and destination must differ; preserve the original PhotosIndex.');
  const results = {};
  const common = `Destination: ${cwd}. Read-only PhotosIndex source: ${source}. Current run evidence: ${ctx.runDir}.
Follow applicable instructions. Do not spawn additional agents. Do not edit other owners' files.
Preserve every original PhotosIndex behavior and test. Never replace a failing behavior with a fixture-only implementation.
Never run real source deletion during QA; exercise destructive branches with isolated deterministic fixtures.
Do not commit private source paths, actual media, GPS, credentials, personal records, caches, or workflow logs.
Do not commit, push, publish, or deploy in this task unless the publication phase explicitly instructs you.
Return a structured passed/failed/blocked report with concrete file and command evidence; unfinished work is not passed.`;
  const delegate = async (label, prompt) => {
    const result = await ctx.agent(`${common}\n\n${prompt}`, { label, cwd, schema: reportSchema });
    assertReport(result, label);
    results[label] = result;
    return result;
  };

  await ctx.phase('Specification');
  const specs = await ctx.parallel([
    () => delegate('test-spec', `Own docs/photosindex-test-spec.md and docs/photosindex-test-inventory.json only.
Read every Swift test file and test method. Map every test to its contract, source behavior, and migration acceptance criterion.
Inventory original paths and methods; distinguish placeholder tests from behavior coverage. No source copying or implementation yet.`),
    () => delegate('ui-spec', `Own docs/photosindex-ui-spec.md only.
Read the actual SwiftUI views, CLI parsing, command router, native services, and public models.
Document all current UI behavior and all CLI-only functions needed in the replacement, including failures, paging, permission, export/move validation, and recovery.
Separate existing implementation from planned functionality. No implementation yet.`),
  ], { concurrency: 2 });
  const dryRun = specs.every((value) => value.dryRun === true);
  if (!dryRun) {
    for (const name of ['photosindex-test-spec.md', 'photosindex-test-inventory.json', 'photosindex-ui-spec.md']) {
      const content = await readFile(join(cwd, 'docs', name), 'utf8');
      if (!content.trim()) throw new Error(`Empty specification: ${name}`);
      if (name.endsWith('.json')) JSON.parse(content);
    }
  }
  await delegate('specification-audit', `Read-only audit of all source tests and UI against the three specification artifacts.
Check every source test method is inventoried, no unsupported source behavior is claimed, and all command paths are represented.
Fail with exact omissions; do not proceed on file existence or aggregate counts alone.`);

  await ctx.phase('Repository');
  await delegate('repository', `Own root package/build configuration, src/shared/, .gitignore, LICENSE/NOTICE, and README.
Initialize this destination as its own Git repository, never reuse the enclosing vault repository.
Prepare Electron with React/Vite and TypeScript; establish one typed adapter contract for desktop and standalone web/Sites.
Freeze adapter/request types before parallel migration. Include synthetic fixtures and no runtime dependence on the old source checkout.
Provide scripts typecheck, test, test:web, test:electron, build, package:mac, and audit:public.
test uses node --import tsx --test tests/unit/*.test.ts; browser and Electron use separate Playwright configurations.
Do not create remote resources in this phase. Record spec-first provenance before migration.`);

  await ctx.phase('Migration');
  await ctx.parallel([
    () => delegate('native-migration', `Own native/photosindex/ and scripts/build-native.mjs only.
Migrate the Swift modules, ALL original tests, license, CLI, and native helper app from the read-only source.
Preserve PhotoKit permissions, grouping, evidence/OCR/redaction, complete decisions, export, verified move, and recovery invariants.
The final bundled app must work without a separately installed PhotosIndex or developer checkout.
Use isolated helper identity/socket/storage and retain CLI compatibility. Do not grant or reset system permissions silently.
Run the entire migrated Swift suite and compare the original test inventory. Report packaging and permission limitations honestly.`),
    () => delegate('electron-migration', `Own src/desktop/, scripts/build-desktop.mjs, and tests/unit/desktop* only.
Implement main/preload using the frozen shared contracts. Keep context isolation, renderer sandbox, sender validation, method/argument allowlists, and narrow media access.
Launch bundled native helper and CLI without shell interpolation or reliance on system PhotosIndex paths.
Connect every spec command, job failures, dialogs, evidence assets, and local dashboard persistence. Keep web/Sites export sanitized.
Support packaging and clean lifecycle; do not stub production commands with fixtures.`),
    () => delegate('react-migration', `Own src/renderer/ and tests/unit/renderer* only.
Implement responsive React PhotosIndex replacement and dashboard through the shared adapter.
Expose all spec functions: permissions, date sync, coarse/fine groups, group metadata, paged evidence, complete include/exclude decisions,
validation, export plan/apply, verified move plan/apply with explicit deletion context, receipts/recovery/errors.
Share components with standalone web/Sites mode; clearly identify demo/read-only mode and disable unavailable native operations.
Use synthetic fixtures for UI development and never include real user media or data.`),
  ], { concurrency: 3 });

  await ctx.phase('Integration');
  await delegate('integration', `Integrate all owners' work against the specs. You may fix cross-boundary issues now that parallel writes are finished.
Implement and document build/package commands and audit:public. The public audit must inspect tracked files and publication artifacts for secrets,
private absolute paths, actual Photos data/media, generated caches, and missing licenses. Do not print secret values.
Ensure all Swift tests are preserved; add contract tests where bridges introduce new behavior. Produce docs/acceptance-matrix.md
mapping every spec feature to implementation and a real test. Distinguish synthetic tests from native/macOS checks.
Do not add unrelated full video editing scope. Run typecheck, unit tests, and build; fix failures without reducing scope.`);

  await ctx.phase('QA');
  await ctx.parallel([
    () => delegate('browser-renderer-qa', `Own tests/web/, playwright.web.config.ts, and docs/web-qa.md only.
Test the standalone web renderer through actual browser interactions, using deterministic adapter fixtures.
Cover normal and error states, date/group/evidence paging, include/exclude validation, export and move confirmation,
dashboard state, responsive mobile layouts, and sanitized shared snapshots. Assert operations and outcomes, not only screenshots.
Run npm run test:web. Report any production changes required rather than silently editing another owner's files.`),
    () => delegate('electron-qa', `Own tests/electron/, playwright.electron.config.ts, and docs/electron-qa.md only.
Independently launch the actual Electron application and test preload isolation, IPC validation, native process startup,
dialogs/path boundaries, persistence/restart, and full UI flow with an isolated test backend.
Separately exercise real bundled helper status/protocol and packaged app startup without the old PhotosIndex installation or source checkout.
Do not delete actual photos, trigger unsolicited Photos permission prompts, or claim synthetic flows prove real PhotoKit behavior.
Run npm run test:electron and report observed runtime failures with reproducible steps.`),
  ], { concurrency: 2 });

  await ctx.phase('Acceptance');
  await delegate('qa-remediation', `Read both QA reports and acceptance matrix. Fix reported failures in production code, retaining all requirements.
Re-run relevant QA after fixes. Ensure package:mac includes the native helper/CLI and supports a no-existing-installation launch.
Produce docs/release-audit.md with explicit verified/unverified coverage, original and migrated test counts, artifact checks,
and publication scope. A failing or unverified required feature is a failed report, never a waiver.`);
  const checks = [
    ['swift', ['test', '--package-path', 'native/photosindex']],
    ['npm', ['run', 'test:native-rebuild']],
    ['npm', ['run', 'test:native-install']],
    ['npm', ['run', 'typecheck']],
    ['npm', ['test']],
    ['npm', ['run', 'build']],
    ['npm', ['run', 'test:web']],
    ['npm', ['run', 'test:electron']],
    ['npm', ['run', 'package:mac']],
    ['npm', ['run', 'audit:public']],
  ];
  results.checks = [];
  if (!dryRun) {
    const directory = join(ctx.runDir, 'checks');
    await mkdir(directory, { recursive: true });
    for (const [index, [file, args]] of checks.entries()) {
      await ctx.log(`Running acceptance check ${index + 1}/${checks.length}`, [file, ...args]);
      const { output: _output, ...evidence } = await command(file, args, cwd, join(directory, `${index + 1}.log`));
      results.checks.push(evidence);
    }
  }
  await delegate('completion-audit', `Read-only final audit. Inspect every acceptance-matrix row, test inventory, QA report,
actual build outputs, and the current diff. Confirm the complete PhotosIndex replacement works in Electron, standalone React
is reusable with Sites, Swift tests are preserved, and no production feature relies solely on test mocks or the previous installation.
Check actual command logs under the current workflow run directory, not stale reports. Missing evidence means failed.`);

  if (config.publish) {
    await ctx.phase('Publication');
    await delegate('publication', `You are the sole publisher. The user has explicitly authorized public GitHub publication to ${config.repo}.
Verify git rev-parse --show-toplevel equals this destination and inspect the complete staged diff and public audit first.
Create ${config.repo} as public only if absent, or verify the existing remote is the exact requested repository; never overwrite an unrelated remote.
Commit only reviewed project source/spec/tests/docs, preserve license, and push without force. No vault files, media, caches, credentials, or run logs.
Verify GitHub visibility is PUBLIC and the remote branch commit equals the reviewed local commit.
Run or inspect available CI for that commit and fail on unresolved required failures. Record actual repository URL and commit evidence.`);
    if (!dryRun) {
      const top = await command('git', ['rev-parse', '--show-toplevel'], cwd, join(ctx.runDir, 'repository-root.log'));
      if (resolve(top.output.trim()) !== cwd) throw new Error('Publication used an enclosing repository.');
      const local = await command('git', ['rev-parse', 'HEAD'], cwd, join(ctx.runDir, 'local-commit.log'));
      const branch = await command('git', ['branch', '--show-current'], cwd, join(ctx.runDir, 'published-branch.log'));
      if (!branch.output.trim()) throw new Error('Publication left a detached HEAD; an explicit published branch is required.');
      const remote = await command('git', ['ls-remote', `https://github.com/${config.repo}.git`, `refs/heads/${branch.output.trim()}`], cwd, join(ctx.runDir, 'remote-commit.log'));
      if (remote.output.trim().split(/\s+/)[0] !== local.output.trim()) {
        throw new Error('The requested GitHub repository does not contain the reviewed local HEAD on its published branch.');
      }
      const repo = await command('gh', ['repo', 'view', config.repo, '--json', 'visibility,url,defaultBranchRef'], cwd, join(ctx.runDir, 'publication.log'));
      const state = JSON.parse(repo.output);
      if (state.visibility !== 'PUBLIC') throw new Error('Published repository is not public.');
      results.publication = { ...state, commit: local.output.trim(), branch: branch.output.trim() };
    }
  }
  return { mode: dryRun ? 'dry-run' : 'executed', published: !dryRun && config.publish, results };
}
