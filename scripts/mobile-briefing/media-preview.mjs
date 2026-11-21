import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {lstat, mkdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash} from '../../packages/icloud-object-sdk/index.mjs';

export const PREVIEW_PRESET = 'h264-540-v1';
export const MAX_RANGE_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_MS = 120_000;
const MAX_RANGE_MS = 8_000;
const workerPath = fileURLToPath(new URL('./preview-worker.mjs', import.meta.url));
const wireErrors = new Set(['SOURCE_CHANGED', 'SOURCE_UNAVAILABLE', 'NOT_LOCAL', 'PREVIEW_FAILED', 'PREVIEW_TIMEOUT']);

export function previewError(error) {
  return wireErrors.has(error?.message) ? error.message : 'PREVIEW_FAILED';
}

function runWorker(args, timeout, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = fork(workerPath, args, {
      detached: true,
      execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      serialization: 'advanced',
    });
    let result;
    let interrupted;
    // The worker, ffprobe and FFmpeg share a process group, including while
    // an iCloud open/read is stalled and the worker cannot finish on its own.
    function interrupt(code) {
      if (worker.exitCode !== null || worker.signalCode !== null) return;
      interrupted = code;
      if (worker.pid) {
        try {
          process.kill(-worker.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') worker.kill('SIGKILL');
        }
      }
    }
    const abort = () => interrupt('PREVIEW_FAILED');
    const timer = setTimeout(() => interrupt('PREVIEW_TIMEOUT'), timeout);
    signal?.addEventListener('abort', abort, {once: true});
    worker.once('message', message => { result = message; });
    worker.once('error', () => { interrupted ??= 'PREVIEW_FAILED'; });
    worker.once('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (interrupted || code !== 0 || !result || result.error) {
        reject(new Error(interrupted ?? result?.error ?? 'PREVIEW_FAILED'));
      } else {
        resolve(result.value);
      }
    });
  });
}

export function createPreviewRunner({registry, cacheDir, ffmpeg, ffprobe}) {
  const preparations = new Map();

  async function execute(job, cacheKey, deadline, signal) {
    await mkdir(cacheDir, {recursive: true, mode: 0o700});
    const cache = await lstat(cacheDir);
    if (!cache.isDirectory() || cache.uid !== process.getuid() || (cache.mode & 0o777) !== 0o700) {
      throw new Error('PREVIEW_FAILED');
    }
    const destination = join(cacheDir, cacheKey + '.mp4');
    const staging = job.kind === 'prepare' ? join(cacheDir, '.' + randomUUID() + '.mp4.tmp') : '';
    try {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('PREVIEW_TIMEOUT');
      return await runWorker([
        registry, destination, staging, ffmpeg, ffprobe, JSON.stringify(job),
      ], remaining, signal);
    } finally {
      if (staging) await rm(staging, {force: true});
    }
  }

  return async function run(job, {signal} = {}) {
    signal?.throwIfAborted();
    if (job.preset !== PREVIEW_PRESET || !['prepare', 'range'].includes(job.kind) ||
        typeof job.object_key !== 'string' || !job.object_key || typeof job.etag !== 'string' || !job.etag) {
      throw new Error('PREVIEW_FAILED');
    }
    const expiresAt = Date.parse(job.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('PREVIEW_TIMEOUT');
    const key = hash(JSON.stringify([job.object_key, job.etag, job.preset]));
    const limit = job.kind === 'prepare' ? MAX_PREVIEW_MS : MAX_RANGE_MS;
    const deadline = Math.min(expiresAt, Date.now() + limit);
    if (job.kind === 'range') return execute(job, key, deadline, signal);

    const existing = preparations.get(key);
    if (existing) return existing;
    const pending = execute(job, key, deadline, signal).finally(() => preparations.delete(key));
    preparations.set(key, pending);
    return pending;
  };
}

export function createMediaJobPoller({request, runPreview, pollOriginal, log}) {
  const pending = new Map();
  let previewSession;
  let mediaEnabled = false;

  function updateHeartbeat(heartbeat) {
    mediaEnabled = heartbeat.mediaEnabled === true;
    if (heartbeat.previewsEnabled === true) {
      previewSession ??= new AbortController();
    } else {
      previewSession?.abort();
      previewSession = undefined;
    }
  }

  async function complete(job, signal) {
    const route = '/api/bridge/preview-jobs/' + job.id;
    let options;
    try {
      const result = await runPreview(job, {signal});
      options = job.kind === 'range'
        ? {body: result, headers: {'Content-Type': 'application/octet-stream'}}
        : {body: JSON.stringify(result), headers: {'Content-Type': 'application/json'}};
    } catch (error) {
      if (signal.aborted) return;
      const code = previewError(error);
      log('Media preview failed: ' + code);
      options = {headers: {'X-Reels-Source-Error': code}};
    }
    if (signal.aborted) return;
    try {
      await request(route, {method: 'PUT', ...options, signal});
    } catch {
      // On a connection error, the server may redeliver the job. A completed
      // conversion is already cached; an expired result is discarded by D1.
      if (!signal.aborted) log('Media preview result could not be delivered.');
    }
  }

  async function pollPreviews(signal) {
    const {jobs} = await (await request('/api/bridge/preview-jobs', {signal})).json();
    if (signal.aborted) return;
    for (const job of jobs) {
      if (typeof job.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(job.id) || pending.has(job.id)) continue;
      const active = complete(job, signal).finally(() => pending.delete(job.id));
      pending.set(job.id, active);
    }
  }

  async function poll() {
    const operations = [];
    if (previewSession) operations.push(pollPreviews(previewSession.signal));
    if (mediaEnabled) operations.push(pollOriginal());
    for (const outcome of await Promise.allSettled(operations)) {
      if (outcome.status === 'rejected') throw outcome.reason;
    }
  }

  async function stop() {
    updateHeartbeat({});
    await Promise.allSettled(pending.values());
  }

  return {updateHeartbeat, poll, stop};
}
