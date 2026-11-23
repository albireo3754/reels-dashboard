// Starts an isolated loopback Worker with in-memory D1 and R2 and synthetic credentials.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, devices } from '@playwright/test';
import { Log, LogLevel, Miniflare } from 'miniflare';

const config = JSON.parse(await readFile('dist/server/wrangler.json', 'utf8'));
const serverRoot = path.resolve('dist/server');
const modules = [config.main, ...(await readdir(serverRoot, { recursive: true }))
  .filter(file => file.endsWith('.js') && file !== config.main)]
  .map(file => ({ type: 'ESModule', path: path.join(serverRoot, file) }));
const bridge = { 'x-reels-bridge-key': 'synthetic-preview-qa-key' };
const viewer = {
  'oai-authenticated-user-id': 'synthetic-preview-qa-user',
  'oai-authenticated-user-email': 'preview-qa@example.invalid',
};
const videoId = 'a'.repeat(64);
const secondId = 'b'.repeat(64);
const imageId = 'c'.repeat(64);
const folderId = 'd'.repeat(64);
const photoFixtures = [
  { id: '3'.repeat(64), label: '세로 사진', width: 720, height: 1280 },
  { id: '4'.repeat(64), label: '가로 사진', width: 1280, height: 720 },
  { id: '5'.repeat(64), label: '정사각형 사진', width: 720, height: 720 },
];
const key = 'f'.repeat(64);
const contentId = 'synthetic-preview';
const statusPath = '/api/previews/' + videoId;
const jobsPath = '/api/bridge/preview-jobs';
const epoch = '2000-01-01T00:00:00.000Z';
const firstChunkSize = 256 * 1024;
const chunkSize = 2 * 1024 * 1024;
const previewEtag = '"synthetic-preview-v1"';
const temp = await mkdtemp(path.join(tmpdir(), 'briefing-preview-qa-'));
const artifacts = process.env.PREVIEW_ARTIFACT_DIR ?? 'artifacts/video-preview';
await mkdir(artifacts, { recursive: true });

async function startWorker(enabled) {
  const worker = new Miniflare({
    host: '127.0.0.1',
    log: new Log(LogLevel.ERROR),
    modules,
    modulesRoot: serverRoot,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    assets: {
      directory: path.resolve('dist/server', config.assets.directory),
      routerConfig: { has_user_worker: true },
    },
    d1Databases: { DB: 'preview-qa' },
    r2Buckets: { BUCKET: 'preview-qa' },
    bindings: {
      BRIDGE_SECRET: bridge['x-reels-bridge-key'],
      MEDIA_PREVIEWS_ENABLED: String(enabled),
      MEDIA_READS_ENABLED: String(!enabled),
    },
  });
  workers.push(worker);
  const origin = (await worker.ready).origin;
  const db = await worker.getD1Database('DB');
  const bucket = await worker.getR2Bucket('BUCKET');
  for (const file of (await readdir('drizzle')).filter(file => file.endsWith('.sql')).sort()) {
    const sql = await readFile(path.join('drizzle', file), 'utf8');
    await db.batch(sql.split('--> statement-breakpoint').map(stmt => db.prepare(stmt.trim())));
  }
  return { origin, db, bucket };
}

function snapshot(etag) {
  const asset = (id, objectKey, label, mimeType, isDirectory = false) => ({
    id, objectKey, label, mimeType, isDirectory, etag, contentId, available: true, itemCount: null,
    role: 'draft', fileName: label, bytes: isDirectory ? 0 : 41_000_000,
  });
  return {
    sourceId: 'primary-mac', sourceLabel: '합성 Mac', sourceUpdatedAt: new Date().toISOString(),
    sourceRevision: etag,
    contents: [{
      id: contentId, title: '휴대폰 미리보기 검증', date: '2026-01-02', dateBasis: 'record',
      stage: 'editing', nextAction: '', publicURL: '',
    }],
    assets: [
      asset(videoId, key, '합성 러프컷', 'video/mp4'),
      asset(secondId, key, '같은 영상의 다른 등록', 'video/mp4'),
      asset(imageId, '1'.repeat(64), '합성 사진', 'image/jpeg'),
      asset(folderId, '2'.repeat(64), '합성 폴더', 'video/mp4', true),
      ...photoFixtures.map(photo => asset(photo.id, photo.id, photo.label, 'image/jpeg')),
    ],
  };
}

function createClient(origin) {
  const call = (route, options) => fetch(origin + route, options);
  const view = (route = statusPath, options = {}) => call(route, {
    ...options, headers: { ...viewer, ...options.headers },
  });
  const service = (route, options = {}) => call(route, { ...options, headers: { ...bridge, ...options.headers } });
  const jsonBody = value => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const ingest = etag => service('/api/bridge/snapshot', { method: 'PUT', ...jsonBody(snapshot(etag)) });
  const jobs = async () => (await (await service(jobsPath)).json()).jobs;
  const post = (route = statusPath) => view(route, { method: 'POST' }).then(r => r.json());
  const get = (route = statusPath) => view(route).then(r => r.json());
  const complete = (job, value, headers) => service(jobsPath + '/' + job.id, {
    method: 'PUT', body: value, headers,
  });
  const prepare = (job, bytes) => complete(job, JSON.stringify({ bytes, etag: previewEtag }), {
    'content-type': 'application/json',
  });
  const fail = (job, error) => complete(job, undefined, { 'x-reels-source-error': error });
  return { call, view, service, ingest, jobs, post, get, complete, prepare, fail };
}

async function until(fn, message, timeout = 8_000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await fn();
    if (result) return result;
    await sleep(75);
  } while (Date.now() < deadline);
  assert.fail(message);
}

const workers = [];
let browser;
try {
  const fixture = path.join(temp, 'synthetic.mp4');
  execFileSync(process.env.FFMPEG ?? 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=360x640:rate=30', '-t', '16', '-c:v', 'libx264',
    '-threads', '2', '-pix_fmt', 'yuv420p', '-g', '30', '-b:v', '1600k',
    '-minrate', '1600k', '-maxrate', '1600k', '-bufsize', '1600k',
    '-x264-params', 'nal-hrd=cbr', '-movflags', '+faststart', fixture,
  ]);
  const clip = await readFile(fixture);
  assert.ok(clip.length > firstChunkSize + chunkSize, 'fixture must require multiple relay chunks');
  const shortFixture = path.join(temp, 'synthetic-short.mp4');
  execFileSync(process.env.FFMPEG ?? 'ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', fixture,
    '-t', '7', '-c', 'copy', '-movflags', '+faststart', shortFixture,
  ]);
  const shortClip = await readFile(shortFixture);
  assert.ok(shortClip.length > firstChunkSize && shortClip.length < chunkSize);

  const { origin, db, bucket } = await startWorker(true);
  const api = createClient(origin);
  const pendingRange = (accept = () => true) => until(async () =>
    (await api.jobs()).find(job => job.kind === 'range' && accept(job)), 'no pending byte range');
  const upload = (job, bytes = clip) => api.complete(job, bytes.subarray(job.range_start, job.range_end + 1), {
    'content-type': 'application/octet-stream',
  });
  const setHeartbeat = value => db.prepare("UPDATE sources SET heartbeat_at = ? WHERE id = 'primary-mac'").bind(value).run();
  const waitForEmptyRanges = () => until(async () => {
    const { n } = await db.prepare('SELECT COUNT(*) AS n FROM preview_ranges').first();
    return n === 0 && (await bucket.list({ prefix: 'preview-relay/' })).objects.length === 0;
  }, 'D1 and R2 still contain a range');

  const seeded = await api.ingest('revision-1');
  assert.equal(seeded.status, 200, await seeded.text());
  const heartbeat = await (await api.service('/api/bridge/heartbeat', { method: 'POST' })).json();
  assert.deepEqual([heartbeat.previewsEnabled, heartbeat.mediaEnabled, heartbeat.sourceRevision], [true, false, 'revision-1']);
  assert.equal((await api.call(statusPath, { method: 'POST' })).status, 401);
  assert.equal((await api.call(statusPath + '/media', { method: 'HEAD' })).status, 401);
  assert.equal((await api.view(jobsPath)).status, 401);
  assert.equal((await api.view(jobsPath + '/00000000-0000-4000-8000-000000000000', { method: 'PUT' })).status, 401);
  assert.equal((await api.view('/api/media/' + videoId, { method: 'HEAD' })).status, 503);
  assert.equal((await api.view('/api/media/' + videoId, { headers: { range: 'bytes=0-1' } })).status, 503);
  for (const id of [imageId, folderId, key, '0'.repeat(64)]) {
    assert.equal((await api.view('/api/previews/' + id, { method: 'POST' })).status, 404);
    assert.equal((await api.view('/api/previews/' + id + '/media', { method: 'HEAD' })).status, 404);
  }
  await setHeartbeat(epoch);
  assert.deepEqual(await api.post(), { status: 'offline' });
  assert.deepEqual(await api.jobs(), []);
  await api.service('/api/bridge/heartbeat', { method: 'POST' });
  assert.deepEqual(await api.get(), { status: 'idle' });

  const parallel = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    api.post(i % 2 ? statusPath : '/api/previews/' + secondId)));
  assert.ok(parallel.every(state => state.status === 'pending'));
  const [prepare, duplicate] = await api.jobs();
  assert.equal(duplicate, undefined);
  assert.deepEqual(Object.keys(prepare).sort(), ['etag', 'expires_at', 'id', 'kind', 'object_key', 'preset']);
  assert.deepEqual([prepare.kind, prepare.object_key, prepare.etag, prepare.preset], ['prepare', key, 'revision-1', 'h264-540-v1']);
  assert.match(prepare.expires_at, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.ok(Date.parse(prepare.expires_at) - Date.now() > 140_000);
  assert.deepEqual((await (await api.service('/api/bridge/jobs')).json()).jobs, []);
  assert.equal((await api.complete(prepare, '{}', { 'content-type': 'application/octet-stream' })).status, 415);
  assert.equal((await api.prepare(prepare, 0)).status, 400);
  assert.equal((await api.fail(prepare, 'UNKNOWN_ERROR')).status, 400);
  assert.equal((await api.complete(prepare, 'x', { 'x-reels-source-error': 'PREVIEW_FAILED' })).status, 400);
  assert.equal((await api.prepare(prepare, clip.length)).status, 200);
  assert.equal((await api.prepare(prepare, clip.length)).status, 409);
  const ready = await api.post();
  assert.deepEqual(ready, { status: 'ready', bytes: clip.length, etag: previewEtag, version: prepare.id });
  assert.deepEqual(await api.jobs(), []);

  const media = statusPath + '/media?v=' + ready.version;
  const head = await api.view(media, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(clip.length));
  assert.equal(head.headers.get('etag'), previewEtag);
  assert.equal(head.headers.get('content-type'), 'video/mp4');
  assert.equal(head.headers.get('cache-control'), 'private, no-store');
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const tail = await api.view(media, { method: 'HEAD', headers: { range: 'bytes=-17' } });
  assert.equal(tail.status, 206);
  assert.equal(tail.headers.get('content-range'), `bytes ${clip.length - 17}-${clip.length - 1}/${clip.length}`);
  assert.equal(tail.headers.get('content-length'), '17');
  assert.equal((await api.view(media, {
    method: 'HEAD', headers: { range: 'bytes=-17', 'if-range': '"older-preview"' },
  })).status, 200);
  const invalid = await api.view(media, { headers: { range: `bytes=${clip.length}-` } });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), 'bytes */' + clip.length);
  assert.deepEqual(await api.jobs(), []);

  // The response and first bytes arrive while the bridge is withholding the second upload.
  const full = api.view(media);
  const firstJob = await pendingRange();
  assert.deepEqual(Object.keys(firstJob).sort(), ['etag', 'expires_at', 'id', 'kind', 'object_key', 'preset', 'preview_etag', 'range_end', 'range_start']);
  assert.deepEqual([firstJob.range_start, firstJob.range_end, firstJob.preview_etag], [0, firstChunkSize - 1, previewEtag]);
  assert.match(firstJob.expires_at, /^\d{4}-\d\d-\d\dT.*Z$/);
  assert.equal((await api.complete(firstJob, clip.subarray(0, 10), {
    'content-type': 'application/octet-stream',
  })).status, 400);
  const uploadStatuses = await Promise.all([upload(firstJob), upload(firstJob)]);
  assert.deepEqual(uploadStatuses.map(res => res.status).sort(), [200, 409]);
  const fullResponse = await full;
  assert.equal(fullResponse.status, 200);
  assert.equal(fullResponse.headers.get('content-length'), String(clip.length));
  const reader = fullResponse.body.getReader();
  const initial = [];
  let received = 0;
  while (received < firstChunkSize) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    received += value.byteLength;
    initial.push(value);
  }
  assert.deepEqual(Buffer.concat(initial), clip.subarray(0, firstChunkSize));
  const secondJob = await pendingRange(job => job.range_start === firstChunkSize);
  assert.equal(secondJob.range_end - secondJob.range_start + 1, chunkSize);
  assert.equal((await upload(secondJob)).status, 200);
  const chunks = [...initial];
  // Drain the second chunk before waiting for another pull through the fixed-length stream.
  while (received < firstChunkSize + chunkSize) {
    const { value, done } = await reader.read();
    assert.equal(done, false);
    received += value.byteLength;
    chunks.push(value);
  }
  const rest = await pendingRange(job => job.range_start === firstChunkSize + chunkSize);
  assert.equal((await upload(rest)).status, 200);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  assert.deepEqual(Buffer.concat(chunks), clip);
  await waitForEmptyRanges();

  const ranged = api.view(media, { headers: { range: 'bytes=300000-300999', 'if-range': previewEtag } });
  const range = await pendingRange();
  assert.deepEqual([range.range_start, range.range_end], [300000, 300999]);
  assert.equal((await upload(range)).status, 200);
  const response = await ranged;
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-length'), '1000');
  assert.equal(response.headers.get('content-range'), `bytes 300000-300999/${clip.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), clip.subarray(300000, 301000));
  await waitForEmptyRanges();

  const timed = api.view(media, { headers: { range: 'bytes=0-1' } });
  const timedJob = await pendingRange();
  assert.equal((await timed).status, 503);
  await waitForEmptyRanges();
  assert.equal((await upload(timedJob)).status, 409);

  // A range left by a disconnected invocation is expired by the authenticated poll.
  const canceled = new AbortController();
  const abandoned = api.view(media, { headers: { range: 'bytes=0-1' }, signal: canceled.signal });
  const canceledJob = await pendingRange();
  canceled.abort();
  await assert.rejects(abandoned, { name: 'AbortError' });
  await db.prepare('UPDATE preview_ranges SET expires_at = ? WHERE id = ?')
    .bind(epoch, canceledJob.id).run();
  await db.prepare(`
    INSERT INTO preview_ranges (id, preview_id, object_key, etag, preset, preview_etag,
                               range_start, range_end, status, created_at, expires_at)
    VALUES ('interrupted', ?, ?, 'revision-1', 'h264-540-v1', ?, 0, 1, 'uploading', ?, ?)
  `).bind(prepare.id, key, previewEtag, epoch, epoch).run();
  await bucket.put('preview-relay/interrupted', new Uint8Array(2));
  await api.service('/api/bridge/heartbeat', { method: 'POST' });
  assert.deepEqual(await api.jobs(), []);
  await waitForEmptyRanges();
  assert.equal((await upload(canceledJob)).status, 409);

  const missing = api.view(media, { headers: { range: 'bytes=0-1' } });
  const missingJob = await pendingRange();
  assert.equal((await api.fail(missingJob, 'SOURCE_UNAVAILABLE')).status, 200);
  assert.equal((await missing).status, 503);
  assert.deepEqual(await api.get(), { status: 'error', error: 'SOURCE_UNAVAILABLE' });
  await waitForEmptyRanges();
  assert.deepEqual(await api.post(), { status: 'pending' });
  const retry = (await api.jobs())[0];
  assert.notEqual(retry.id, prepare.id);

  await db.prepare('UPDATE preview_preparations SET expires_at = ? WHERE id = ?').bind(epoch, retry.id).run();
  assert.deepEqual(await api.get(), { status: 'error', error: 'PREVIEW_TIMEOUT' });
  assert.equal((await api.prepare(retry, clip.length)).status, 409);
  await api.service('/api/bridge/heartbeat', { method: 'POST' });
  assert.deepEqual(await api.jobs(), []);
  assert.equal(await db.prepare('SELECT COUNT(*) AS n FROM preview_preparations').first('n'), 0);

  assert.deepEqual(await api.post(), { status: 'pending' });
  const priorRevision = (await api.jobs())[0];
  assert.equal((await api.ingest('revision-2')).status, 200);
  assert.equal((await api.prepare(priorRevision, clip.length)).status, 409);
  assert.equal((await api.view(media, { method: 'HEAD' })).status, 409);
  assert.deepEqual(await api.get(), { status: 'idle' });

  const disabledWorker = await startWorker(false);
  const disabled = createClient(disabledWorker.origin);
  assert.equal((await disabled.ingest('disabled')).status, 200);
  await disabledWorker.db.prepare(`
    INSERT INTO preview_ranges (id, preview_id, object_key, etag, preset, preview_etag,
                                range_start, range_end, status, created_at, expires_at)
    VALUES ('old', 'old', ?, 'disabled', 'h264-540-v1', ?, 0, 1, 'complete', ?, ?)
  `).bind(key, previewEtag, epoch, epoch).run();
  await disabledWorker.bucket.put('preview-relay/old', new Uint8Array(2));
  const switches = await (await disabled.service('/api/bridge/heartbeat', { method: 'POST' })).json();
  assert.deepEqual([switches.previewsEnabled, switches.mediaEnabled], [false, true]);
  assert.equal(await disabledWorker.db.prepare("SELECT id FROM preview_ranges WHERE id = 'old'").first(), null);
  assert.equal(await disabledWorker.bucket.head('preview-relay/old'), null);
  assert.equal((await disabled.view(statusPath, { method: 'POST' })).status, 503);
  assert.equal((await disabled.view(statusPath + '/media', { method: 'HEAD' })).status, 503);
  assert.equal((await disabled.view('/api/media/' + videoId, { method: 'HEAD' })).status, 200);
  assert.deepEqual(await disabled.jobs(), []);

  // Run the phone flow against the same built Worker. The fake bridge forwards synthetic bytes only.
  browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const photos = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  const photoPage = await photos.newPage();
  await photos.route('**/*', route => {
    if (new URL(route.request().url()).origin !== disabledWorker.origin) return route.abort();
    return route.continue({ headers: { ...route.request().headers(), ...viewer } });
  });
  await photoPage.route('**/api/media/' + imageId, route => route.fulfill({ status: 404 }));
  for (const { id, width, height } of photoFixtures) {
    await photoPage.route('**/api/media/' + id, route => route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="teal"/></svg>`,
    }));
  }
  await photoPage.goto(disabledWorker.origin + '/?content=' + contentId);
  const viewPhoto = photoPage.getByRole('button', { name: '합성 사진 열기' });
  const original = photoPage.getByRole('dialog', { name: '자료 미리보기' });
  await viewPhoto.click();
  await original.getByRole('alert').waitFor();
  assert.match(await original.getByRole('alert').textContent(), /이미지를 표시할 수 없어요/);
  assert.equal(await original.locator('img').count(), 0);
  await photoPage.keyboard.press('Escape');
  await original.waitFor({ state: 'hidden' });
  assert.equal(await viewPhoto.evaluate(node => node === document.activeElement), true);
  for (const { label, width, height } of photoFixtures) {
    await photoPage.getByRole('button', { name: `${label} 열기` }).click();
    const image = original.getByRole('img', { name: label });
    await image.waitFor();
    assert.deepEqual(await image.evaluate(node => [node.naturalWidth, node.naturalHeight]), [width, height]);
    assert.equal(await image.evaluate(node => getComputedStyle(node).objectFit), 'contain');
    assert.equal(await photoPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await original.getByRole('button', { name: '미리보기 닫기' }).click();
  }
  await photos.close();
  console.log('Original photo aspect ratios and unavailable-file UI passed.');

  const context = await browser.newContext({ ...devices['iPhone 13'], serviceWorkers: 'block' });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) return route.abort();
    return route.continue({ headers: { ...route.request().headers(), ...viewer } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const originalRequests = [];
  page.on('request', req => {
    if (new URL(req.url()).pathname.startsWith('/api/media/')) originalRequests.push(req.url());
  });
  assert.equal((await page.goto(origin + '/?content=' + contentId)).status(), 200);
  const open = page.getByRole('button', { name: '합성 러프컷 미리보기 재생', exact: true });
  await open.waitFor();
  assert.equal(await page.getByRole('button', { name: '합성 사진 미리보기 재생' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '합성 러프컷 열기', exact: true }).count(), 0);
  await setHeartbeat(epoch);
  await open.click();
  const dialog = page.getByRole('dialog', { name: '영상 미리보기' });
  const state = dialog.getByRole('status');
  await state.filter({ hasText: 'Mac이 오프라인' }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'phone-mac-offline.png') });
  await api.service('/api/bridge/heartbeat', { method: 'POST' });
  await dialog.getByRole('button', { name: '다시 시도' }).click();
  await state.filter({ hasText: '준비하고 있어요' }).waitFor();
  const uiPrepare = await until(async () => (await api.jobs()).find(job => job.kind === 'prepare'), 'no UI prepare');
  await page.screenshot({ path: path.join(artifacts, 'phone-preparing.png') });
  await dialog.getByRole('button', { name: '미리보기 닫기' }).click();
  await dialog.waitFor({ state: 'hidden' });
  await open.click();
  assert.equal((await api.jobs())[0].id, uiPrepare.id, 'a closed viewer never cancels the shared preparation');
  assert.equal((await api.fail(uiPrepare, 'NOT_LOCAL')).status, 200);
  await state.filter({ hasText: '다운로드되면' }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'phone-preparation-error.png') });
  await dialog.getByRole('button', { name: '다시 시도' }).click();
  const uiRetry = await until(async () => (await api.jobs()).find(job => job.kind === 'prepare'), 'no UI retry');
  assert.notEqual(uiRetry.id, uiPrepare.id);

  assert.equal((await api.prepare(uiRetry, shortClip.length)).status, 200);
  const uiMissing = await pendingRange();
  assert.equal((await api.fail(uiMissing, 'SOURCE_CHANGED')).status, 200);
  await state.filter({ hasText: '원본 영상이 바뀌었어요' }).waitFor();
  await dialog.getByRole('button', { name: '다시 시도' }).click();
  const uiRecovery = await until(async () => (await api.jobs()).find(job => job.kind === 'prepare'), 'no UI range retry');
  assert.notEqual(uiRecovery.id, uiRetry.id);
  assert.equal((await api.prepare(uiRecovery, shortClip.length)).status, 200);
  assert.equal((await api.view(statusPath + '/media?v=' + uiRetry.id)).status, 409);

  const video = dialog.locator('video');
  await video.waitFor();
  await video.evaluate(element => {
    element.muted = true;
    element.dataset.playing = 'no';
    element.addEventListener('playing', () => { element.dataset.playing = 'yes'; });
    void element.play();
  });
  const uiFirst = await pendingRange();
  assert.deepEqual([uiFirst.range_start, uiFirst.range_end], [0, firstChunkSize - 1]);
  const firstUploadAt = performance.now();
  assert.equal((await upload(uiFirst, shortClip)).status, 200);
  const withheld = await pendingRange(job => job.range_start >= firstChunkSize);
  await page.waitForFunction(() => document.querySelector('video')?.dataset.playing === 'yes', null, { timeout: 5000 });
  assert.ok((await api.jobs()).some(job => job.id === withheld.id), 'the next upload is still withheld during playback');
  console.log(`First 256 KiB to playing: ${Math.round(performance.now() - firstUploadAt)} ms of the ${shortClip.length}-byte synthetic MP4, with its tail withheld.`);
  assert.equal(await video.evaluate(element => element.playsInline && element.controls), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(artifacts, 'phone-playing.png') });

  // Keep polling the fake bridge while the media element seeks to both sides of the timeline.
  let relayDone = false;
  const relay = (async () => {
    while (!relayDone) {
      for (const job of await api.jobs()) {
        if (job.kind === 'range') assert.ok([200, 409].includes((await upload(job, shortClip)).status));
      }
      await sleep(75);
    }
  })();
  try {
    await video.evaluate(element => element.pause());
    for (const target of [5, 1]) {
      await video.evaluate((element, offset) => { element.currentTime = offset; }, target);
      await page.waitForFunction(offset => {
        const element = document.querySelector('video');
        return element && !element.seeking && Math.abs(element.currentTime - offset) < 0.1 && element.readyState >= 2;
      }, target);
    }
    await context.setOffline(true);
    await state.filter({ hasText: '인터넷 연결이 끊겼어요' }).waitFor();
    await context.setOffline(false);
    await state.filter({ hasText: '미리보기를 재생할 수 있어요' }).waitFor();
    await setHeartbeat(epoch);
    await state.filter({ hasText: 'Mac이 오프라인' }).waitFor({ timeout: 12_000 });
    assert.equal(await dialog.locator('video').count(), 0);
    assert.equal((await api.service('/api/bridge/heartbeat', { method: 'POST' })).status, 200);
    assert.equal((await api.get()).status, 'ready');
    await state.filter({ hasText: '미리보기를 재생할 수 있어요' }).waitFor().catch(async error => {
      throw new Error(`After Mac reconnected: ${await state.textContent()}, API ${(await api.get()).status}`, { cause: error });
    });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await open.waitFor();
  } finally {
    relayDone = true;
    await relay;
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(originalRequests, []);
  await context.close();

  console.log('Preview QA passed: private media access, mobile playback/seek/retry, photo aspect ratios and missing-file state, and D1/R2 cleanup.');
} finally {
  await browser?.close();
  await Promise.all(workers.map(worker => worker.dispose()));
  await rm(temp, { recursive: true, force: true });
}
