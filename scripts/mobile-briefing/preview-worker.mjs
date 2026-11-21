import {spawn} from 'node:child_process';
import {constants, rmSync} from 'node:fs';
import {open, readFile, rename} from 'node:fs/promises';
import {basename} from 'node:path';
import {LocalObjectStore, hash} from '../../packages/icloud-object-sdk/index.mjs';
import {MAX_RANGE_BYTES, previewError} from './media-preview.mjs';

const [registry, destination, staging, ffmpeg, ffprobe, payload] = process.argv.slice(2);
const job = JSON.parse(payload);
const {object_key: key, etag, range_start: start, range_end: end, preview_etag: previewETag} = job;
process.umask(0o077);

let mediaChild;
function onParentExit() {
  mediaChild?.kill('SIGKILL');
  try {
    if (staging) rmSync(staging, {force: true});
  } finally {
    process.kill(-process.pid, 'SIGKILL');
  }
}

async function sourceOperation(operation) {
  try {
    return await operation();
  } catch (error) {
    throw new Error(['NOT_LOCAL', 'SOURCE_CHANGED'].includes(error.message) ? error.message : 'SOURCE_UNAVAILABLE');
  }
}

async function registeredVideo() {
  return sourceOperation(async () => {
    const {objects} = JSON.parse(await readFile(registry, 'utf8'));
    const store = new LocalObjectStore(objects);
    const metadata = await store.headObject(key);
    if (metadata.etag !== etag) throw new Error('SOURCE_CHANGED');
    if (metadata.isDirectory || !metadata.contentType.startsWith('video/')) throw new Error('SOURCE_UNAVAILABLE');
    return store;
  });
}

async function runMediaTool(store, binary, inputOptions, outputOptions = []) {
  const {file} = await sourceOperation(() => store.openObject({key, ifMatch: etag}));
  try {
    return await new Promise((resolve, reject) => {
      // Give each tool a fresh, seekable descriptor. FFmpeg never gets the
      // source path and cannot open external media referenced by the container.
      mediaChild = spawn(binary, [
        '-v', 'error', ...inputOptions, '-protocol_whitelist', 'fd', '-fd', '3', '-i', 'fd:', ...outputOptions,
      ], {stdio: ['ignore', 'pipe', 'ignore', file.fd]});
      let output = '';
      mediaChild.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
      mediaChild.once('error', reject);
      mediaChild.once('close', code => {
        mediaChild = undefined;
        if (code === 0) resolve(output);
        else reject(new Error('PREVIEW_FAILED'));
      });
    });
  } finally {
    await file.close();
  }
}

const scale = "scale=w='min(iw,if(gte(dar,1),960,540))':h='min(ih,if(gte(dar,1),540,960))'" +
  ':force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1';
const hdrToSdr = [
  'zscale=t=linear:npl=100', 'format=gbrpf32le', 'tonemap=tonemap=hable:desat=0',
  'zscale=p=bt709:t=bt709:m=bt709:r=limited',
  'sidedata=mode=delete:type=MASTERING_DISPLAY_METADATA',
  'sidedata=mode=delete:type=CONTENT_LIGHT_LEVEL', 'sidedata=mode=delete:type=DYNAMIC_HDR_PLUS',
];

async function convert(store) {
  const probe = JSON.parse(await runMediaTool(store, ffprobe, [
    '-select_streams', 'V:0', '-show_entries', 'stream=color_transfer', '-of', 'json',
  ]));
  const video = probe.streams?.[0];
  if (!video) throw new Error('PREVIEW_FAILED');
  const hdr = ['arib-std-b67', 'smpte2084'].includes(video.color_transfer);
  const filters = [scale, ...(hdr ? hdrToSdr : []), 'format=yuv420p'];
  await runMediaTool(store, ffmpeg, ['-nostdin', '-y'], [
    '-map', '0:V:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1',
    '-vf', filters.join(','), ...(hdr ? ['-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-colorspace', 'bt709', '-color_range', 'tv'] : []),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', '1500k', '-bufsize', '3000k',
    '-fpsmax', '30', '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-movflags', '+faststart', '-f', 'mp4', staging,
  ]);
}

async function openCached(filePath) {
  let file;
  try {
    file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size <= 0 || (info.mode & 0o077) !== 0) throw new Error('PREVIEW_FAILED');
    return {
      file,
      bytes: info.size,
      etag: '"' + hash(JSON.stringify([basename(destination), info.size, info.mtimeMs, info.ino])) + '"',
    };
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function prepare(store) {
  let cached = await openCached(destination);
  if (!cached) {
    try {
      await convert(store);
    } finally {
      // Distinguish a failed conversion from a replaced or unavailable original.
      await registeredVideo();
    }
    cached = await openCached(staging);
    if (!cached) throw new Error('PREVIEW_FAILED');
    try {
      await rename(staging, destination);
    } catch (error) {
      await cached.file.close();
      throw error;
    }
  }
  await cached.file.close();
  await registeredVideo();
  return {bytes: cached.bytes, etag: cached.etag};
}

async function readRange() {
  const cached = await openCached(destination);
  if (!cached) throw new Error('SOURCE_UNAVAILABLE');
  try {
    if (cached.etag !== previewETag) throw new Error('SOURCE_CHANGED');
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 ||
        end < start || end >= cached.bytes || end - start + 1 > MAX_RANGE_BYTES) {
      throw new Error('PREVIEW_FAILED');
    }
    const body = Buffer.alloc(end - start + 1);
    let received = 0;
    while (received < body.length) {
      const {bytesRead} = await cached.file.read(body, received, body.length - received, start + received);
      if (bytesRead === 0) throw new Error('SOURCE_CHANGED');
      received += bytesRead;
    }
    await registeredVideo();
    return body;
  } finally {
    await cached.file.close();
  }
}

process.once('disconnect', onParentExit);
let message;
try {
  const store = await registeredVideo();
  message = {value: job.kind === 'prepare' ? await prepare(store) : await readRange()};
} catch (error) {
  message = {error: previewError(error)};
}
process.send(message, () => {
  process.removeListener('disconnect', onParentExit);
  if (process.connected) process.disconnect();
});
