import { rangeFor } from './contracts';

const preset = 'h264-540-v1';
const chunkSize = 2 * 1024 * 1024;
const firstChunkSize = 256 * 1024;
const prepareMs = 150_000;
const resultMs = 15 * 60_000;
const rangeLeaseMs = 30_000;
const rangeWaitMs = 16_000;
const uploadGraceMs = 60_000;
const relayPrefix = 'preview-relay/';
const sourceErrors = ['SOURCE_CHANGED', 'SOURCE_UNAVAILABLE', 'NOT_LOCAL', 'PREVIEW_FAILED', 'PREVIEW_TIMEOUT'] as const;
type SourceError = typeof sourceErrors[number];

export type PreviewStatus =
  | { status: 'idle' | 'offline' | 'pending' }
  | { status: 'error'; error: SourceError }
  | { status: 'ready'; bytes: number; etag: string; version: string };

type AssetRevision = { object_key: string; etag: string };
type PreviewAsset = AssetRevision & { available: number; heartbeat_at: string };
type Preparation = AssetRevision & {
  id: string; status: 'pending' | 'ready' | 'error'; expires_at: string;
  bytes: number | null; preview_etag: string | null; error: SourceError | null;
};
type RangeJob = AssetRevision & {
  id: string; status: 'pending' | 'uploading' | 'complete' | 'error'; expires_at: string;
  preview_id: string; range_start: number; range_end: number; error: SourceError | null;
};
type PreviewBindings = { db: D1Database; bucket: R2Bucket };

const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();
const cacheControl = 'private, no-store';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': cacheControl } });
const failure = (error: string, status: number) => json({ error }, status);
const expired = () => failure('EXPIRED', 409);
const isOnline = (asset: PreviewAsset) => Date.now() - Date.parse(asset.heartbeat_at) < 45_000;
const isSourceError = (error: string): error is SourceError => sourceErrors.some(value => value === error);
const httpEtag = (etag: string) => etag.startsWith('"') ? etag : `"${etag}"`;

// A job can only refer to a video in the current snapshot, even if an old job is still retained.
const currentRevision = (table: 'preview_preparations' | 'preview_ranges') => `
  EXISTS (SELECT 1 FROM sources s JOIN assets a ON a.run_id = s.latest_run_id
          WHERE s.id = 'primary-mac' AND a.object_key = ${table}.object_key AND a.etag = ${table}.etag
            AND a.available = 1 AND a.is_directory = 0 AND a.mime_type LIKE 'video/%')`;
const currentPreparation = `EXISTS (SELECT 1 FROM preview_preparations p
  WHERE p.id = preview_ranges.preview_id AND p.status = 'ready' AND p.expires_at > ?)`;

function findAsset(db: D1Database, id: string) {
  return db.prepare(`
    SELECT a.object_key, a.etag, a.available, s.heartbeat_at
    FROM sources s JOIN assets a ON a.run_id = s.latest_run_id
    WHERE s.id = 'primary-mac' AND a.id = ? AND a.is_directory = 0 AND a.mime_type LIKE 'video/%'
  `).bind(id).first<PreviewAsset>();
}

function findPreparation(db: D1Database, asset: AssetRevision) {
  return db.prepare('SELECT * FROM preview_preparations WHERE object_key = ? AND etag = ? AND preset = ?')
    .bind(asset.object_key, asset.etag, preset).first<Preparation>();
}

function statusFor(job: Preparation | null, time: string): PreviewStatus {
  if (!job) return { status: 'idle' };
  if (job.expires_at <= time) {
    return job.status === 'pending' ? { status: 'error', error: 'PREVIEW_TIMEOUT' } : { status: 'idle' };
  }
  if (job.status === 'ready' && job.preview_etag && job.bytes) {
    return { status: 'ready', bytes: job.bytes, etag: httpEtag(job.preview_etag), version: job.id };
  }
  if (job.status === 'error') return { status: 'error', error: job.error ?? 'PREVIEW_FAILED' };
  return { status: 'pending' };
}

export async function previewStatus(req: Request, id: string, { db }: PreviewBindings) {
  const asset = await findAsset(db, id);
  if (!asset) return failure('NOT_FOUND', 404);
  if (!asset.available) return json({ status: 'error', error: 'SOURCE_UNAVAILABLE' } satisfies PreviewStatus);
  if (!isOnline(asset)) return json({ status: 'offline' } satisfies PreviewStatus);

  const time = iso();
  if (req.method === 'POST') {
    await db.prepare(`
      INSERT INTO preview_preparations (id, object_key, etag, preset, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT (object_key, etag, preset) DO UPDATE SET id = excluded.id, status = 'pending',
        created_at = excluded.created_at, expires_at = excluded.expires_at,
        bytes = NULL, preview_etag = NULL, error = NULL
      WHERE preview_preparations.status = 'error' OR preview_preparations.expires_at <= excluded.created_at
    `).bind(crypto.randomUUID(), asset.object_key, asset.etag, preset, time, iso(prepareMs)).run();
  }
  return json(statusFor(await findPreparation(db, asset), iso()));
}

export async function reapExpiredPreviews({ db, bucket }: PreviewBindings) {
  const time = iso();
  await db.prepare(`
    DELETE FROM preview_preparations WHERE id IN (
      SELECT id FROM preview_preparations
      WHERE expires_at <= ? AND (status <> 'pending' OR expires_at <= ?)
      ORDER BY expires_at LIMIT 50
    )
  `).bind(time, iso(-resultMs)).run();

  // Keep an in-flight uploader's row long enough to roll back its own object after cancellation.
  const rows = await db.prepare(`
    SELECT id FROM preview_ranges WHERE expires_at <= ? AND (status <> 'uploading' OR expires_at <= ?)
    ORDER BY expires_at LIMIT 50
  `).bind(time, iso(-uploadGraceMs)).all<{ id: string }>();
  if (rows.results.length) {
    const ids = rows.results.map(row => row.id);
    await bucket.delete(ids.map(id => relayPrefix + id));
    await db.prepare(`DELETE FROM preview_ranges WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
  }
}

export async function listPreviewJobs(bindings: PreviewBindings, enabled: boolean) {
  if (!enabled) return json({ jobs: [] });

  const time = iso();
  const { db } = bindings;
  const [prepare, range] = await db.batch([
    db.prepare(`
      SELECT id, 'prepare' AS kind, object_key, etag, preset, expires_at FROM preview_preparations
      WHERE status = 'pending' AND expires_at > ? AND ${currentRevision('preview_preparations')}
      ORDER BY created_at LIMIT 4
    `).bind(time),
    db.prepare(`
      SELECT id, 'range' AS kind, object_key, etag, preset, expires_at, range_start, range_end, preview_etag
      FROM preview_ranges WHERE status = 'pending' AND expires_at > ?
        AND ${currentRevision('preview_ranges')} AND ${currentPreparation}
      ORDER BY created_at LIMIT 4
    `).bind(time, time),
  ]);
  return json({ jobs: [...range.results, ...prepare.results] });
}

async function readBounded(req: Request, capacity: number) {
  if (Number(req.headers.get('content-length')) > capacity) return null;
  const reader = req.body?.getReader();
  const bytes = new Uint8Array(capacity);
  if (!reader) return bytes.subarray(0, 0);

  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return bytes.subarray(0, size);
      if (size + value.byteLength > capacity) {
        await reader.cancel();
        return null;
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

async function preparationResult(req: Request, db: D1Database, id: string, error: SourceError | null) {
  let result: { bytes: number; etag: string } | null = null;
  if (!error) {
    const bytes = await readBounded(req, 1024);
    try {
      const value = JSON.parse(new TextDecoder().decode(bytes ?? undefined));
      if (Number.isSafeInteger(value?.bytes) && value.bytes > 0 && typeof value.etag === 'string'
        && /^(?:"[!#-~]{1,100}"|[!#-~]{1,100})$/.test(value.etag)) {
        result = { bytes: value.bytes, etag: value.etag };
      }
    } catch {
      return failure('INVALID_PREVIEW', 400);
    }
    if (!result) return failure('INVALID_PREVIEW', 400);
  }

  const update = await db.prepare(`
    UPDATE preview_preparations SET status = ?, bytes = ?, preview_etag = ?, error = ?, expires_at = ?
    WHERE id = ? AND status = 'pending' AND expires_at > ? AND ${currentRevision('preview_preparations')}
  `).bind(error ? 'error' : 'ready', result?.bytes ?? null, result?.etag ?? null, error, iso(resultMs), id, iso()).run();
  return update.meta.changes ? json({ ok: true }) : expired();
}

async function rangeResult(req: Request, { db, bucket }: PreviewBindings, job: RangeJob, error: SourceError | null) {
  const time = iso();
  const liveRange = `id = ? AND status = 'pending' AND expires_at > ?
    AND ${currentRevision('preview_ranges')} AND ${currentPreparation}`;
  if (error) {
    // Report the failure and invalidate its ready record in the same transaction.
    const [update] = await db.batch([
      db.prepare(`UPDATE preview_ranges SET status = 'error', error = ? WHERE ${liveRange}`)
        .bind(error, job.id, time, time),
      db.prepare(`UPDATE preview_preparations SET status = 'error', error = ?, expires_at = ?
        WHERE id = ? AND status = 'ready'
          AND EXISTS (SELECT 1 FROM preview_ranges WHERE id = ? AND status = 'error' AND error = ?)`)
        .bind(error, iso(resultMs), job.preview_id, job.id, error),
    ]);
    return update.meta.changes ? json({ ok: true }) : expired();
  }

  const length = job.range_end - job.range_start + 1;
  const bytes = await readBounded(req, length);
  if (bytes?.byteLength !== length) return failure('INVALID_CHUNK', 400);

  const claimedAt = iso();
  const claim = await db.prepare(`UPDATE preview_ranges SET status = 'uploading' WHERE ${liveRange}`)
    .bind(job.id, claimedAt, claimedAt).run();
  if (!claim.meta.changes) return expired();
  const key = relayPrefix + job.id;
  try {
    await bucket.put(key, bytes);
    const completedAt = iso();
    const completed = await db.prepare(`
      UPDATE preview_ranges SET status = 'complete'
      WHERE id = ? AND status = 'uploading' AND expires_at > ?
        AND ${currentRevision('preview_ranges')} AND ${currentPreparation}
    `).bind(job.id, completedAt, completedAt).run();
    if (completed.meta.changes) return json({ ok: true });
  } catch {
    await bucket.delete(key);
    await db.prepare(`
      UPDATE preview_ranges SET status = 'error', error = 'PREVIEW_FAILED' WHERE id = ? AND status = 'uploading'
    `).bind(job.id).run();
    return failure('RELAY_UNAVAILABLE', 503);
  }
  await bucket.delete(key);
  await db.prepare('DELETE FROM preview_ranges WHERE id = ?').bind(job.id).run();
  return expired();
}

export async function acceptPreviewResult(req: Request, id: string, bindings: PreviewBindings) {
  const { db } = bindings;
  const time = iso();
  const [prepare, range] = await db.batch([
    db.prepare(`
      SELECT id FROM preview_preparations WHERE id = ? AND status = 'pending' AND expires_at > ?
        AND ${currentRevision('preview_preparations')}
    `).bind(id, time),
    db.prepare(`
      SELECT * FROM preview_ranges WHERE id = ? AND status = 'pending' AND expires_at > ?
        AND ${currentRevision('preview_ranges')} AND ${currentPreparation}
    `).bind(id, time, time),
  ]);
  const rangeJob = range.results[0] as RangeJob | undefined;
  if (!prepare.results.length && !rangeJob) return expired();

  const error = req.headers.get('x-reels-source-error');
  if (error !== null) {
    if (!isSourceError(error) || (await readBounded(req, 0)) === null) return failure('INVALID_SOURCE_ERROR', 400);
  } else {
    const expected = rangeJob ? 'application/octet-stream' : 'application/json';
    if (req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== expected) {
      return failure('INVALID_CONTENT_TYPE', 415);
    }
  }
  return rangeJob ? rangeResult(req, bindings, rangeJob, error) : preparationResult(req, db, id, error);
}

function pause(signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, 350);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}

async function readChunk({ db, bucket }: PreviewBindings, job: Preparation, start: number, end: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const id = crypto.randomUUID();
  const key = relayPrefix + id;
  const deadline = Date.now() + rangeWaitMs;
  await db.prepare(`
    INSERT INTO preview_ranges (id, preview_id, object_key, etag, preset, preview_etag,
                                range_start, range_end, status, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).bind(id, job.id, job.object_key, job.etag, preset, job.preview_etag, start, end, iso(), iso(rangeLeaseMs)).run();
  try {
    while (Date.now() < deadline) {
      await pause(signal);
      signal.throwIfAborted();
      const row = await db.prepare('SELECT status, error FROM preview_ranges WHERE id = ?')
        .bind(id).first<Pick<RangeJob, 'status' | 'error'>>();
      if (!row || row.status === 'error') throw new Error(row?.error ?? 'PREVIEW_FAILED');
      if (row.status === 'complete') {
        const object = await bucket.get(key);
        if (!object || object.size !== end - start + 1) throw new Error('PREVIEW_FAILED');
        return new Uint8Array(await object.arrayBuffer());
      }
    }
    throw new Error('PREVIEW_TIMEOUT');
  } finally {
    // Expiring the row first prevents a new upload from claiming it during teardown.
    const row = await db.prepare('UPDATE preview_ranges SET expires_at = MIN(expires_at, ?) WHERE id = ? RETURNING status')
      .bind(iso(), id).first<Pick<RangeJob, 'status'>>();
    if (row && row.status !== 'uploading') {
      if (row.status === 'complete') await bucket.delete(key);
      await db.prepare('DELETE FROM preview_ranges WHERE id = ?').bind(id).run();
    }
  }
}

export async function previewMedia(req: Request, url: URL, id: string, bindings: PreviewBindings) {
  const asset = await findAsset(bindings.db, id);
  if (!asset || !asset.available) return failure('NOT_FOUND', 404);
  if (!isOnline(asset)) return failure('LOCAL_OFFLINE', 503);
  const job = await findPreparation(bindings.db, asset);
  if (!job || job.status !== 'ready' || job.expires_at <= iso() || !job.bytes || !job.preview_etag) {
    return failure('PREVIEW_NOT_READY', 409);
  }
  const version = url.searchParams.get('v');
  if (version !== null && version !== job.id) return failure('SOURCE_CHANGED', 409);

  const etag = httpEtag(job.preview_etag);
  const ifRange = req.headers.get('if-range');
  let range;
  try {
    range = rangeFor(ifRange && ifRange !== etag ? null : req.headers.get('range'), job.bytes, Infinity);
  } catch {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${job.bytes}`, 'Accept-Ranges': 'bytes', 'Cache-Control': cacheControl, ETag: etag },
    });
  }
  const headers = new Headers({
    'Content-Type': 'video/mp4', 'Content-Length': String(range.end - range.start + 1),
    'Accept-Ranges': 'bytes', 'Cache-Control': cacheControl, ETag: etag, 'X-Content-Type-Options': 'nosniff',
  });
  if (range.partial) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${job.bytes}`);
  const status = range.partial ? 206 : 200;
  if (req.method === 'HEAD') return new Response(null, { headers, status });

  const streamAbort = new AbortController();
  const signal = AbortSignal.any([req.signal, streamAbort.signal]);
  let offset = range.start;
  const nextChunk = async (limit: number) => {
    const bytes = await readChunk(bindings, job, offset, Math.min(range.end, offset + limit - 1), signal);
    offset += bytes.byteLength;
    return bytes;
  };

  try {
    const first = await nextChunk(firstChunkSize);
    const fixed = new FixedLengthStream(range.end - range.start + 1);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(first);
        if (offset > range.end) controller.close();
      },
      async pull(controller) {
        const bytes = await nextChunk(chunkSize);
        if (signal.aborted) return;
        controller.enqueue(bytes);
        if (offset > range.end) controller.close();
      },
      cancel() {
        streamAbort.abort();
      },
    }, { highWaterMark: 0 });
    // Workers derive Content-Length from the response body.
    void stream.pipeTo(fixed.writable, { signal }).catch(() => {});
    return new Response(fixed.readable, { headers, status });
  } catch (error) {
    const code = error instanceof Error && isSourceError(error.message) ? error.message : 'PREVIEW_FAILED';
    return failure(code, 503);
  }
}
