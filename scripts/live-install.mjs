#!/usr/bin/env node
// Live install of main into an immutable release folder (docs/agent-workflow.md).
//   node scripts/live-install.mjs [--dry-run] [--sha=<commit>] [--site-deployed=<sha>] [--allow-cached] [--skip-tests] [--no-services]
// Layout (REELS_LIVE_ROOT, default ~/side/reels-live):
//   repo.git            bare mirror of origin
//   releases/<sha>/     one detached worktree per installed commit, built in place and never edited
//   current -> releases/<sha>   what the LaunchAgents run; switched atomically, switched back on failure
// Nothing here resets, cleans or overwrites a working checkout. --no-services skips launchctl and the
// bridge check and exists for synthetic checks of this script only.
import {execFileSync, spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, open, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const value = (n) => argv.find((a) => a.startsWith(n + '='))?.slice(n.length + 1) ?? null;
const dryRun = flag('--dry-run'), skipTests = flag('--skip-tests'), noServices = flag('--no-services'), allowCached = flag('--allow-cached');
const siteDeployed = value('--site-deployed'), wantSha = value('--sha');
const uid = process.getuid();
const liveRoot = path.resolve(process.env.REELS_LIVE_ROOT ?? path.join(os.homedir(), 'side/reels-live'));
const mirror = path.join(liveRoot, 'repo.git'), releases = path.join(liveRoot, 'releases'), current = path.join(liveRoot, 'current');
const lockFile = path.join(liveRoot, 'install.lock'), recordFile = path.join(liveRoot, 'install.json');
const originUrl = process.env.REELS_LIVE_ORIGIN ?? 'https://github.com/albireo3754/reels-dashboard.git';
const userData = process.env.REELS_USER_DATA ?? path.join(os.homedir(), 'Library/Application Support/Reels Dashboard');
const statusFile = path.join(userData, 'mobile-bridge/status.json');
const agentsDir = path.join(os.homedir(), 'Library/LaunchAgents');
const BRIDGE = 'com.rosy.reels-mobile-bridge', AUTOPILOT = 'com.rosy.reels-afterwork-autopilot';
const SITE_INPUTS = ['apps/mobile-briefing', 'packages/briefing'];
// Anything else can reach the packaged app; these never do.
const NOT_APP = [':(exclude)docs', ':(exclude)tests', ':(exclude)apps/mobile-briefing', ':(exclude)scripts/mobile-briefing', ':(exclude)scripts/live-install.mjs', ':(exclude).github', ':(exclude)*.md'];
const BRIDGE_TESTS = ['tests/unit/mobile-bridge-instructions.test.ts', 'tests/unit/local-object-store.test.ts', 'tests/unit/publishing-copy.test.ts', 'tests/unit/route-map-sync.test.ts'];
const KEEP = 3, PRUNE_AFTER_MS = 24 * 3600_000;

const log = (m) => console.log(new Date().toISOString(), m);
const gitM = (...a) => execFileSync('git', ['--git-dir', mirror, ...a], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
function run(cmd, args, cwd) {
  log('$ ' + [cmd, ...args].join(' ') + (cwd ? '   (in ' + path.relative(liveRoot, cwd) + ')' : ''));
  const r = spawnSync(cmd, args, {cwd: cwd ?? liveRoot, stdio: 'inherit'});
  if (r.status !== 0) throw new Error(cmd + ' ' + (args[0] ?? '') + ' failed (' + (r.status ?? r.signal) + ')');
}
const changed = (from, to, paths) => !from || (from !== to && gitM('diff', '--name-only', from, to, '--', ...paths) !== '');
const plist = (label, key) => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', path.join(agentsDir, label + '.plist')], {encoding: 'utf8'}).trim();
const installedSha = async () => { try { return path.basename(await readlink(current)); } catch { return null; } };

async function readRecord() { try { return JSON.parse(await readFile(recordFile, 'utf8')); } catch { return {history: []}; } }
async function saveRecord(entry, good) {
  const rec = await readRecord();
  const history = [entry, ...(rec.history ?? []).filter((h) => h.startedAt !== entry.startedAt)].slice(0, 30);
  await writeFile(recordFile + '.tmp', JSON.stringify({good: good === undefined ? rec.good ?? null : good, last: entry, history}, null, 1), {mode: 0o600});
  await rename(recordFile + '.tmp', recordFile);
}
async function lock() {
  try { const fh = await open(lockFile, 'wx', 0o600); await fh.writeFile(String(process.pid)); await fh.close(); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(await readFile(lockFile, 'utf8').catch(() => '0'));
    let alive = false; try { process.kill(pid, 0); alive = true; } catch {}
    throw new Error(alive ? 'another live install is running (pid ' + pid + ')' : 'stale lock ' + lockFile + ' (pid ' + pid + ' is gone); read ' + recordFile + ', then remove the lock');
  }
}
async function switchTo(sha) {
  const tmp = current + '.next';
  await rm(tmp, {force: true});
  await symlink(path.join('releases', sha), tmp);
  await rename(tmp, current); // atomic replace of the symlink
  log('current -> releases/' + sha.slice(0, 12));
}

/** Detached worktree at sha, built once; a marker records a finished build so reruns skip it. */
async function build(sha, deps) {
  const dir = path.join(releases, sha), marker = path.join(dir, '.live-built');
  if (existsSync(marker)) return log('releases/' + sha.slice(0, 12) + ' already built');
  if (existsSync(dir)) run('git', ['--git-dir', mirror, 'worktree', 'remove', '--force', dir]); // an unfinished build of ours
  run('git', ['--git-dir', mirror, 'worktree', 'add', '--detach', '--quiet', dir, sha]);
  if (deps) run('npm', ['ci', '--no-audit', '--no-fund'], dir);
  if (!skipTests && deps) run(process.execPath, ['--import', 'tsx', '--test', ...BRIDGE_TESTS], dir);
  run('npm', ['run', 'build:desktop'], dir);
  await writeFile(marker, sha + '\n');
}

async function readStatus() { try { return JSON.parse(await readFile(statusFile, 'utf8')); } catch { return null; } }
/** A new bridge process reports connected at the target revision and the site holds its snapshot. */
async function restartBridge(sha, {lenient = false} = {}) {
  if (noServices) {
    if (process.env.REELS_LIVE_TEST_VERIFY === 'fail' && !lenient) throw new Error('synthetic verify failure');
    return 'skipped';
  }
  const before = await readStatus(), since = Date.now();
  run('launchctl', ['kickstart', '-k', 'gui/' + uid + '/' + BRIDGE]);
  for (let i = 0; i < 36; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await readStatus();
    if (!s || s.connected !== true || !(Date.parse(s.checkedAt) > since) || (before?.pid && s.pid === before.pid)) continue;
    if (!('codeRevision' in s)) { if (lenient) return 'connected (old bridge, revision not reported)'; continue; }
    if (s.codeRevision !== sha) throw new Error('bridge runs ' + s.codeRevision + ', expected ' + sha);
    if (!s.localRevision || s.acceptedRevision !== s.localRevision) continue;
    if (s.projectedAt && Date.parse(s.projectedAt) > since) return 'connected, fresh snapshot accepted';
    if (allowCached || lenient) return 'connected, cached snapshot accepted (app MCP not reachable)';
  }
  throw new Error('bridge did not confirm ' + sha.slice(0, 7) + ' with a fresh accepted snapshot within 180 s (is the app running? --allow-cached accepts a cached one)');
}

async function preflight() {
  if (!noServices) {
    for (const label of [BRIDGE, AUTOPILOT]) {
      const p = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(agentsDir, label + '.plist')], {encoding: 'utf8'}));
      if (![p.WorkingDirectory, ...(p.ProgramArguments ?? [])].some((a) => typeof a === 'string' && a.startsWith(current + '/')))
        throw new Error(label + ' does not run from ' + current + ' yet; do the one-time switch in docs/agent-workflow.md first');
      if (label === BRIDGE) for (const key of ['REELS_BRIDGE_KEYCHAIN_HELPER', 'REELS_PREVIEW_FFMPEG', 'REELS_PREVIEW_FFPROBE']) {
        const file = p.EnvironmentVariables?.[key];
        if (typeof file !== 'string' || spawnSync('test', ['-x', file]).status !== 0) throw new Error(BRIDGE + ' needs ' + key + ' pointing at an executable outside the release folders');
      }
    }
  }
  if (!existsSync(mirror)) run('git', ['clone', '--quiet', '--bare', originUrl, mirror]);
  run('git', ['--git-dir', mirror, 'fetch', '--quiet', '--prune', 'origin', '+refs/heads/main:refs/heads/main']);
  const main = gitM('rev-parse', 'refs/heads/main');
  const to = wantSha ? gitM('rev-parse', '--verify', wantSha + '^{commit}') : main;
  if (gitM('merge-base', to, main) !== to) throw new Error(to.slice(0, 7) + ' is not on main');
  // Restore to the last release a bridge confirmed, not to whatever current points at after an interruption.
  const pointer = await installedSha(), good = (await readRecord()).good ?? null;
  if (pointer && good && pointer !== good) log('current points at ' + pointer.slice(0, 7) + ', which was never confirmed; the restore target stays ' + good.slice(0, 7));
  const from = good ?? pointer;
  return {from, to, site: changed(from, to, SITE_INPUTS), app: changed(from, to, NOT_APP), deps: true};
}

/** Keeps the current and previous release plus the newest builds up to KEEP; removes only our own worktrees. */
async function prune(keep) {
  const dirs = (await readdir(releases)).filter((d) => /^[0-9a-f]{40}$/.test(d));
  const built = await Promise.all(dirs.map(async (d) => ({d, t: (await stat(path.join(releases, d))).mtimeMs})));
  const rest = built.filter((x) => !keep.includes(x.d)).sort((a, b) => b.t - a.t).slice(Math.max(0, KEEP - keep.length));
  // A process started through current/ (an autopilot tick) shows no release in its argv, so while one runs
  // nothing is removed. The restarted bridge is excluded: it runs the release just installed.
  const bridgePid = noServices ? null : (/"PID" = (\d+);/.exec(spawnSync('launchctl', ['list', BRIDGE], {encoding: 'utf8'}).stdout ?? '')?.[1] ?? null);
  const viaCurrent = (spawnSync('pgrep', ['-f', current + '/'], {encoding: 'utf8'}).stdout ?? '').split('\n').filter((p) => p && p !== bridgePid && p !== String(process.pid));
  if (viaCurrent.length) return log('pruning deferred: ' + viaCurrent.length + ' process(es) run through current/');
  for (const {d, t} of rest) {
    // Executors resolve their release path into argv; a release younger than a day is kept regardless.
    const dir = path.join(releases, d);
    if (Date.now() - t < PRUNE_AFTER_MS && !process.env.REELS_LIVE_TEST_PRUNE_NOW) continue;
    if (spawnSync('pgrep', ['-f', dir]).status === 0) { log('keeping ' + d.slice(0, 7) + ': a process still runs from it'); continue; }
    run('git', ['--git-dir', mirror, 'worktree', 'remove', '--force', dir]);
  }
}

async function main() {
  await mkdir(releases, {recursive: true, mode: 0o700});
  if (!dryRun) await lock();
  try {
    const {from, to, site, app} = await preflight();
    const deps = changed(from, to, ['package-lock.json']) || !from;
    log('live ' + (from?.slice(0, 7) ?? 'none') + ' -> ' + to.slice(0, 7) + ' | site inputs ' + (site ? 'CHANGED' : 'unchanged') + ' | app inputs ' + (app ? 'CHANGED: reinstall the app after this' : 'unchanged'));
    if (site && from && siteDeployed !== to) throw new Error('site inputs changed: deploy the site from a clean worktree at ' + to + ' first, then pass --site-deployed=' + to);
    if (dryRun) return log('dry run: no changes made');
    const entry = {startedAt: new Date().toISOString(), from, to, site, app, result: 'building'};
    await saveRecord(entry);
    try { await build(to, true); }
    catch (e) { Object.assign(entry, {result: 'build_failed', error: e.message, finishedAt: new Date().toISOString()}); await saveRecord(entry); throw e; }
    await switchTo(to);
    try {
      entry.bridge = await restartBridge(to);
    } catch (e) {
      entry.error = e.message;
      if (from && from !== to) {
        await switchTo(from);
        let restored = false;
        try { entry.rollbackBridge = await restartBridge(from, {lenient: true}); restored = true; }
        catch (r) { entry.next = 'switched back to ' + from.slice(0, 7) + ' but the bridge did not confirm: ' + r.message; }
        entry.result = restored ? 'restored' : 'needs_manual';
        entry.finishedAt = new Date().toISOString();
        await saveRecord(entry, restored ? from : undefined);
        throw e;
      }
      Object.assign(entry, {result: 'needs_manual', finishedAt: new Date().toISOString(), next: 'no confirmed release to return to'});
      await saveRecord(entry);
      throw e;
    }
    Object.assign(entry, {result: 'installed', finishedAt: new Date().toISOString(), next: app ? 'reinstall the app' : null});
    await saveRecord(entry, to);
    await prune([to, from].filter(Boolean));
    log('installed ' + to.slice(0, 7) + (app ? ' — app inputs changed: reinstall the app' : ''));
  } finally {
    if (!dryRun) await rm(lockFile, {force: true});
  }
}
main().catch((e) => { console.error('LIVE_INSTALL_FAILED ' + e.message); process.exit(1); });
