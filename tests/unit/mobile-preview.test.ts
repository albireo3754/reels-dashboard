import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test, {type TestContext} from 'node:test';

// @ts-expect-error The plain Node bridge is also the production entry point.
import {createMediaJobPoller, createPreviewRunner, MAX_RANGE_BYTES, PREVIEW_PRESET} from '../../scripts/mobile-briefing/media-preview.mjs';
// @ts-expect-error The SDK deliberately has no build dependency.
import {LocalObjectStore} from '../../packages/icloud-object-sdk/index.mjs';

const runtime = resolve('native/editor-engine/.build/runtime/bin');
const ffmpeg = process.env.REELS_PREVIEW_FFMPEG ?? join(runtime, 'ffmpeg');
const ffprobe = process.env.REELS_PREVIEW_FFPROBE ?? join(runtime, 'ffprobe');
const expiry = (ms = 150_000) => new Date(Date.now() + ms).toISOString();

type Job = {kind: string; object_key: string; etag: string; preset: string; expires_at: string};
type Result = {bytes: number; etag: string};

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'reels-preview-test-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const registry = join(dir, 'registry.json');
  const cacheDir = join(dir, 'cache');
  const store = new LocalObjectStore();
  async function register(file: string): Promise<Job> {
    const record = await store.register(file);
    await writeFile(registry, JSON.stringify({objects: store.exportRegistry()}));
    return {kind: 'prepare', object_key: record.key, etag: record.etag, preset: PREVIEW_PRESET, expires_at: expiry()};
  }
  return {dir, cacheDir, register, runner: (options = {}) =>
    createPreviewRunner({registry, cacheDir, ffmpeg, ffprobe, ...options})};
}

function encode(file: string, filters = 'testsrc2=s=192x108:r=12:d=0.3', options: string[] = []) {
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', filters, ...options, '-c:v', 'libx264', file]);
}

function probe(file: string) {
  return JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', file], {encoding: 'utf8'})).streams;
}

async function cacheFile(cacheDir: string) {
  const entries = await readdir(cacheDir);
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^[a-f0-9]{64}\.mp4$/);
  return join(cacheDir, entries[0]);
}

test('mobile preview converts a rotated portrait with AAC, caches an atomic faststart file, and serves registered preview ranges', async t => {
  const f = await fixture(t);
  const horizontal = join(f.dir, 'horizontal.mp4');
  const rotated = join(f.dir, 'rotated.mov');
  encode(horizontal, 'testsrc2=s=1280x720:r=60:d=0.4', ['-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.4', '-c:a', 'pcm_s16le', '-f', 'mov']);
  execFileSync(ffmpeg, ['-v', 'error', '-display_rotation', '90', '-i', horizontal, '-c', 'copy', rotated]);

  const job = await f.register(rotated);
  const run = f.runner();
  const first: Result = await run(job);
  const output = await cacheFile(f.cacheDir);
  const bytes = await readFile(output);
  const [video, audio] = probe(output);
  assert.deepEqual([video.width, video.height, video.codec_name, video.pix_fmt, video.r_frame_rate], [540, 960, 'h264', 'yuv420p', '30/1']);
  assert.equal(video.side_data_list?.some((side: {rotation?: number}) => Boolean(side.rotation)) ?? false, false);
  assert.equal(audio.codec_name, 'aac');
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal((await stat(f.cacheDir)).mode & 0o777, 0o700);
  assert.equal(first.bytes, bytes.length);
  assert.ok(bytes.indexOf('moov') > 0 && bytes.indexOf('moov') < bytes.indexOf('mdat'));
  assert.deepEqual(await f.runner()(job), first);

  const range = {...job, kind: 'range', preview_etag: first.etag, range_start: first.bytes - 101, range_end: first.bytes - 1};
  assert.deepEqual(await run(range), bytes.subarray(-101));
  await assert.rejects(run({...range, preview_etag: job.etag}), /SOURCE_CHANGED/);
  await assert.rejects(run({...range, range_end: first.bytes}), /PREVIEW_FAILED/);
  await assert.rejects(run({...range, range_start: -MAX_RANGE_BYTES}), /PREVIEW_FAILED/);
  await rm(output);
  await assert.rejects(run(range), /SOURCE_UNAVAILABLE/);
  assert.deepEqual(await readdir(f.cacheDir), []);
});

test('mobile preview bounds wide SDR, leaves small muted video at native size, and converts HLG and PQ to BT.709', async t => {
  const f = await fixture(t);
  const cases = [
    {size: '1600x900', expected: [960, 540]},
    {size: '194x108', expected: [194, 108]},
    {size: '108x192', expected: [108, 192], transfer: 'arib-std-b67'},
    {size: '192x108', expected: [192, 108], transfer: 'smpte2084'},
  ];
  for (const [index, item] of cases.entries()) {
    const input = join(f.dir, 'input-' + index + '.mp4');
    const hdr = item.transfer ? ['-vf',
      'format=yuv420p10le,setparams=range=tv:color_primaries=bt2020:colorspace=bt2020nc:color_trc=' + item.transfer] : [];
    encode(input, 'testsrc2=s=' + item.size + ':r=12:d=0.3', hdr);
    if (item.transfer) assert.equal(probe(input)[0].color_transfer, item.transfer);
    const job = await f.register(input);
    const cacheDir = f.cacheDir + index;
    await f.runner({cacheDir})(job);
    const output = await cacheFile(cacheDir);
    const tracks = probe(output);
    assert.equal(tracks.length, 1);
    const [video] = tracks;
    assert.deepEqual([video.width, video.height], item.expected);
    assert.equal(video.pix_fmt, 'yuv420p');
    if (item.transfer) {
      assert.deepEqual([video.color_transfer, video.color_space, video.color_primaries], ['bt709', 'bt709', 'bt709']);
      const decode = (file: string) => execFileSync(ffmpeg, [
        '-v', 'error', '-i', file, '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo', '-',
      ]);
      const original = decode(input);
      const toneMapped = decode(output);
      assert.equal(original.length, toneMapped.length);
      const meanDifference = toneMapped.reduce((sum, value, i) => sum + Math.abs(value - original[i]), 0) / toneMapped.length;
      assert.ok(meanDifference > 5, 'HDR conversion must change the pixels, not just the color flags');
    }
  }
});

async function controlledEncoder(dir: string) {
  const marker = join(dir, 'encoder-pids');
  const release = join(dir, 'encoder-release');
  const file = join(dir, 'converter.cjs');
  await writeFile(file, `#!${process.execPath}
const fs = require('node:fs');
const child = require('node:child_process').spawn('/bin/sleep', ['300'], {stdio:'ignore'});
fs.writeFileSync(process.argv.at(-1), 'partial-output');
fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify([process.pid, child.pid]) + '\\n');
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(release)})) return;
  clearInterval(timer);
  child.kill();
}, 15);
`, {mode: 0o700});
  return {file, marker, release};
}

async function waitFor<T>(read: () => Promise<T>) {
  const deadline = Date.now() + 5000;
  do {
    const value = await read();
    if (value) return value;
    await delay(10);
  } while (Date.now() < deadline);
  throw new Error('Fixture did not reach the expected state');
}

async function encoderPids(marker: string): Promise<number[][]> {
  const lines = await waitFor(() => readFile(marker, 'utf8').catch(() => ''));
  return lines.trim().split('\n').map(line => JSON.parse(line));
}

async function assertStopped(pids: number[]) {
  await waitFor(async () => pids.every(pid => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }));
}

test('mobile preview coalesces one conversion, rejects a changed SDK revision mid-encode, and refreshes after registry update', async t => {
  const f = await fixture(t);
  const input = join(f.dir, 'fixture.mp4');
  encode(input);
  const old = await f.register(input);
  const fake = await controlledEncoder(f.dir);
  const runner = f.runner({ffmpeg: fake.file});
  const both = Promise.allSettled([runner(old), runner(old)]);
  const pids = await encoderPids(fake.marker);
  assert.equal((await readdir(f.cacheDir)).length, 1);
  assert.ok((await readdir(f.cacheDir))[0].endsWith('.tmp'));
  await writeFile(input, 'replacement');
  await writeFile(fake.release, '');
  for (const outcome of await both) {
    assert.equal(outcome.status, 'rejected');
    if (outcome.status === 'rejected') assert.equal(outcome.reason.message, 'SOURCE_CHANGED');
  }
  assert.deepEqual(await encoderPids(fake.marker), pids);
  await assertStopped(pids.flat());
  assert.deepEqual(await readdir(f.cacheDir), []);

  encode(input, 'testsrc2=s=224x112:d=0.3');
  const newer = await f.register(input);
  assert.equal(newer.object_key, old.object_key);
  assert.notEqual(newer.etag, old.etag);
  const actual = f.runner();
  await assert.rejects(actual(old), /SOURCE_CHANGED/);
  const good: Result = await actual(newer);
  const output = await cacheFile(f.cacheDir);
  assert.equal(probe(output)[0].width, 224);
  assert.deepEqual(await actual(newer), good);
  encode(input, 'testsrc2=s=256x144:d=0.3');
  const latest = await f.register(input);
  const after: Result = await actual(latest);
  assert.notEqual(after.etag, good.etag);
  assert.equal((await readdir(f.cacheDir)).length, 2);
  await assert.rejects(actual({...newer, kind: 'range', preview_etag: good.etag, range_start: 0, range_end: 1}), /SOURCE_CHANGED/);
});

test('mobile preview deadline, cancellation and process exit reap the FFmpeg group and remove incomplete files', async t => {
  for (const mode of ['deadline', 'cancel', 'exit', 'parent-exit']) {
    await t.test(mode, async t => {
      const f = await fixture(t);
      const input = join(f.dir, 'fixture.mp4');
      encode(input);
      const job = await f.register(input);
      const fake = await controlledEncoder(f.dir);
      if (mode === 'parent-exit') {
        const module = new URL('../../scripts/mobile-briefing/media-preview.mjs', import.meta.url);
        const options = {registry: join(f.dir, 'registry.json'), cacheDir: f.cacheDir, ffmpeg: fake.file, ffprobe};
        const parent = spawn(process.execPath, ['--input-type=module', '-e',
          `import {createPreviewRunner} from ${JSON.stringify(module.href)};
          await createPreviewRunner(${JSON.stringify(options)})(${JSON.stringify(job)});`,
        ], {stdio: 'ignore'});
        t.after(() => parent.kill('SIGKILL'));
        const [pids] = await encoderPids(fake.marker);
        parent.kill('SIGKILL');
        await assertStopped(pids);
        assert.deepEqual(await readdir(f.cacheDir), []);
        return;
      }
      const controller = new AbortController();
      const run = f.runner({ffmpeg: fake.file});
      const expectFailure = assert.rejects(
        run({...job, expires_at: expiry(mode === 'deadline' ? 1700 : 150_000)}, {signal: controller.signal}),
        mode === 'deadline' ? /PREVIEW_TIMEOUT/ : /PREVIEW_FAILED/,
      );
      const [pids] = await encoderPids(fake.marker);
      if (mode === 'cancel') controller.abort(new Error('PREVIEW_FAILED'));
      if (mode === 'exit') {
        // Simulate a failed encode after temporary output was started.
        process.kill(pids[1], 'SIGKILL');
        process.kill(pids[0], 'SIGKILL');
      }
      await expectFailure;
      await assertStopped(pids);
      assert.deepEqual(await readdir(f.cacheDir), []);
    });
  }
});

test('mobile preview rejects invalid registry objects and failed encodes without exposing a file', async t => {
  const f = await fixture(t);
  const input = join(f.dir, 'video.mp4');
  await writeFile(input, 'not a valid movie');
  const job = await f.register(input);
  const run = f.runner();
  await assert.rejects(run(job), /PREVIEW_FAILED/);
  await assert.rejects(run({...job, object_key: 'unregistered'}), /NOT_LOCAL/);
  await assert.rejects(run({...job, preset: 'unknown'}), /PREVIEW_FAILED/);
  await assert.rejects(run({...job, expires_at: expiry(-10)}), /PREVIEW_TIMEOUT/);

  const image = join(f.dir, 'still.png');
  await writeFile(image, 'image');
  await assert.rejects(run(await f.register(image)), /SOURCE_UNAVAILABLE/);
  await rm(input);
  await assert.rejects(run(job), /SOURCE_UNAVAILABLE/);
  assert.deepEqual(await readdir(f.cacheDir), []);
});

test('preview and original queues use independent heartbeat flags; disconnect retries, errors and result types follow the wire', async () => {
  const route = '/api/bridge/preview-jobs';
  const calls: {path: string; options: {method?: string; headers?: Record<string, string>; body?: string | Buffer}}[] = [];
  const payload = [{id: 'one', kind: 'prepare'}, {id: 'two', kind: 'range'}, {id: 'three', kind: 'range'}];
  let disconnected = false;
  let originalPolls = 0;
  let abandoned = false;
  let finishPrepare: (value: Result) => void = () => {};
  const poller = createMediaJobPoller({
    request: async (path: string, options = {}) => {
      calls.push({path, options});
      if (disconnected) throw new Error('disconnected');
      return {json: async () => ({jobs: payload.splice(0)})};
    },
    runPreview: async (job: {id: string}, {signal}: {signal: AbortSignal}) => {
      if (job.id === 'one') return new Promise(resolve => { finishPrepare = resolve; });
      if (job.id === 'three') throw new Error('NOT_LOCAL');
      if (job.id === 'four') {
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), {once: true}));
        abandoned = true;
        throw new Error('PREVIEW_FAILED');
      }
      return Buffer.from('preview');
    },
    pollOriginal: async () => { originalPolls++; },
    log: () => {},
  });
  await poller.poll();
  assert.equal(calls.length, 0);
  poller.updateHeartbeat({mediaEnabled: true});
  await poller.poll();
  assert.equal(originalPolls, 1);
  assert.equal(calls.length, 0);

  poller.updateHeartbeat({previewsEnabled: true});
  await poller.poll();
  await poller.poll();
  assert.equal(originalPolls, 1);
  assert.equal(calls.filter(call => call.path === route).length, 2);
  assert.equal(calls.some(call => call.path === route + '/one'), false);
  disconnected = true;
  await assert.rejects(poller.poll(), /disconnected/);
  disconnected = false;
  finishPrepare({bytes: 7, etag: '"preview"'});
  await waitFor(async () => calls.some(call => call.path === route + '/one'));
  const transmitted = Object.fromEntries(calls.filter(call => call.options.method === 'PUT').map(call => [call.path, call.options]));
  assert.deepEqual(transmitted[route + '/one'].headers, {'Content-Type': 'application/json'});
  assert.deepEqual(JSON.parse(transmitted[route + '/one'].body as string), {bytes: 7, etag: '"preview"'});
  assert.deepEqual(transmitted[route + '/two'].headers, {'Content-Type': 'application/octet-stream'});
  assert.deepEqual(transmitted[route + '/two'].body, Buffer.from('preview'));
  assert.deepEqual(transmitted[route + '/three'].headers, {'X-Reels-Source-Error': 'NOT_LOCAL'});
  assert.equal(transmitted[route + '/three'].body, undefined);

  payload.push({id: 'four', kind: 'prepare'});
  await poller.poll();
  await poller.stop();
  assert.equal(abandoned, true);
  assert.equal(calls.some(call => call.path === route + '/four'), false);
  poller.updateHeartbeat({previewsEnabled: true, mediaEnabled: true});
  await poller.poll();
  assert.equal(originalPolls, 2);
  await poller.stop();
});
