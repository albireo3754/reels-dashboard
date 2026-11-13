import { DatabaseSync } from "node:sqlite";
import { readdir, lstat, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { AXSnapshot } from "../../../shared/edits";

export type EditsClip = {
  id: string;
  kind: string;
  start: number;
  duration: number;
  sourceIn: number;
  sourceOut: number;
  sourceDuration: number;
  volume: number;
  muted: boolean;
  includeAudio: boolean;
  title?: string;
  artist?: string;
  audioAssetId?: string;
  text?: string;
};
export type EditsProject = {
  id: string;
  clips: EditsClip[];
  source: "read-only Timeline.db";
};
export type EditsMedia = {
  aliasId: string;
  assetId: string;
  name: string;
  sourcePath: string;
  bytes: number;
  managed: boolean;
};
export type MediaProof = {
  method: "canonical-path+size" | "managed-copy-sha256";
  bytes: number;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const seconds = (v: any) =>
  typeof v?.value === "number" && v.timescale > 0 ? v.value / v.timescale : 0;
export function decodeEditsComposition(data: unknown): EditsClip[] {
  const j = typeof data === "string" ? JSON.parse(data) : data;
  if (!j || !Array.isArray((j as any).tracks))
    throw new Error("EDITS_PROJECT_FORMAT: missing tracks");
  return (j as any).tracks.flatMap((track: any) =>
    (track.elements ?? []).map((e: any) => {
      if (!uuid.test(e.id) || !e.content)
        throw new Error("EDITS_PROJECT_FORMAT: invalid element");
      const kind = Object.keys(e.content)[0],
        content = e.content[kind]?._0 ?? {};
      return {
        id: e.id,
        kind,
        start: seconds(e.startTime),
        duration: seconds(e.duration),
        sourceIn: seconds(e.inPoint),
        sourceOut: seconds(e.outPoint),
        sourceDuration: seconds(e.fullDuration),
        volume: e.volume ?? 1,
        muted: e.isMuted === true,
        includeAudio: content.includeAudio !== false,
        ...(kind === "text" && typeof content.text === "string"
          ? { text: content.text }
          : {}),
        ...(kind === "music"
          ? {
              title: content.title,
              artist: content.artistName,
              audioAssetId: content.audioAssetId,
            }
          : {}),
      };
    }),
  );
}

/** Internal observed schema, read in-place (including WAL), never copied or written. */
export async function readEditsProject(
  snapshot: AXSnapshot,
  requestedId?: string,
  root = path.join(os.homedir(), "Movies/Edits/Libraries"),
): Promise<EditsProject | null> {
  if (requestedId && !uuid.test(requestedId))
    throw new Error("EDITS_PROJECT_ID");
  const visible = new Set(
    snapshot.nodes.map((n) => n.identifier).filter((id) => uuid.test(id)),
  );
  if (!visible.size) return null;
  const matches: EditsProject[] = [];
  let libraries;
  try {
    libraries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const library of libraries.filter(
    (e) => e.isDirectory() && e.name.endsWith(".bsledits"),
  )) {
    const projects = path.join(root, library.name, "Projects");
    // A requested ID is a condition to verify, not permission to ignore a
    // second project containing the same visible object IDs.
    const ids = await readdir(projects).catch(() => []);
    for (const id of ids.filter((id) => uuid.test(id))) {
      const file = path.join(projects, id, "Timeline.db");
      const stat = await lstat(file).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const info = db
          .prepare(
            "SELECT schema_version, length(composition_data) AS bytes FROM timelines LIMIT 2",
          )
          .all();
        if (
          info.length !== 1 ||
          info[0].schema_version !== 1 ||
          Number(info[0].bytes) > 20 * 1024 * 1024
        )
          throw new Error("EDITS_PROJECT_FORMAT: unknown schema or size");
        const row = db
          .prepare(
            "SELECT CAST(composition_data AS TEXT) AS data FROM timelines LIMIT 1",
          )
          .get();
        const clips = decodeEditsComposition(row?.data);
        if (clips.some((c) => visible.has(c.id)))
          matches.push({ id, clips, source: "read-only Timeline.db" });
      } finally {
        db.close();
      }
    }
  }
  const knownVisible = new Set(
    matches.flatMap((p) =>
      p.clips.filter((c) => visible.has(c.id)).map((c) => c.id),
    ),
  );
  const exact = matches.filter((p) =>
    [...knownVisible].every((id) => p.clips.some((c) => c.id === id)),
  );
  if (exact.length > 1)
    throw new Error("EDITS_PROJECT_AMBIGUOUS: UI clips match several projects");
  const active = exact[0] ?? null;
  return requestedId && active?.id !== requestedId ? null : active;
}

/** Only the current project's aliases and linked public asset metadata; no bookmarks/credentials. */
export async function readEditsMedia(
  projectId: string,
  root = path.join(os.homedir(), "Movies/Edits/Libraries"),
): Promise<EditsMedia[]> {
  if (!uuid.test(projectId)) throw new Error("EDITS_PROJECT_ID");
  const libraries = (await readdir(root, { withFileTypes: true })).filter(
    (e) => e.isDirectory() && e.name.endsWith(".bsledits"),
  );
  const matches: EditsMedia[][] = [];
  for (const entry of libraries) {
    const library = path.join(root, entry.name),
      index = path.join(library, "Projects", projectId, "MediaIndex.db");
    if (!(await lstat(index).catch(() => null))?.isFile()) continue;
    const aliasesDB = new DatabaseSync(index, { readOnly: true });
    let aliases;
    try {
      aliases = aliasesDB
        .prepare(
          "SELECT id,asset_id,display_name FROM media_aliases LIMIT 5001",
        )
        .all();
    } finally {
      aliasesDB.close();
    }
    if (aliases.length > 5000) throw new Error("EDITS_MEDIA_INDEX_LIMIT");
    const mediaDB = new DatabaseSync(path.join(library, "Media.db"), {
      readOnly: true,
    });
    try {
      const query = mediaDB.prepare(
        "SELECT name,storage_mode,source_path,file_size FROM media_assets WHERE id=? AND is_available=1",
      );
      const media: EditsMedia[] = [];
      for (const alias of aliases) {
        const row = query.get(alias.asset_id as string);
        if (!row || typeof row.source_path !== "string") continue;
        const managed = row.storage_mode === "managed";
        if (!managed && row.storage_mode !== "external") continue;
        const sourcePath = managed
          ? path.resolve(library, "Media", row.source_path)
          : row.source_path;
        if (managed) {
          const base = await realpath(path.join(library, "Media")),
            resolved = await realpath(sourcePath).catch(() => null);
          if (!resolved || !resolved.startsWith(base + path.sep)) continue;
        } else if (!path.isAbsolute(sourcePath)) continue;
        media.push({
          aliasId: String(alias.id),
          assetId: String(alias.asset_id),
          name: String(alias.display_name ?? row.name),
          sourcePath,
          bytes: Number(row.file_size),
          managed,
        });
      }
      matches.push(media);
    } finally {
      mediaDB.close();
    }
  }
  if (matches.length !== 1)
    throw new Error(
      "EDITS_MEDIA_INDEX_UNAVAILABLE: current project library is missing or ambiguous",
    );
  return matches[0];
}

export async function verifyEditsMediaSource(
  media: EditsMedia,
  input: string,
): Promise<MediaProof | null> {
  const [source, imported] = await Promise.all([
    realpath(input),
    realpath(media.sourcePath),
  ]);
  const [sourceInfo, importInfo] = await Promise.all([
    stat(source),
    stat(imported),
  ]);
  if (
    !sourceInfo.isFile() ||
    !importInfo.isFile() ||
    sourceInfo.size !== media.bytes ||
    importInfo.size !== media.bytes
  )
    return null;
  if (source === imported)
    return { method: "canonical-path+size", bytes: media.bytes };
  if (!media.managed) return null;
  const digest = async (file: string) => {
    const hash = createHash("sha256");
    for await (const data of createReadStream(file)) hash.update(data);
    return hash.digest("hex");
  };
  const [a, b] = await Promise.all([digest(source), digest(imported)]);
  if (a !== b) return null;
  const after = await stat(source);
  if (after.size !== sourceInfo.size || after.mtimeMs !== sourceInfo.mtimeMs)
    return null;
  return { method: "managed-copy-sha256", bytes: media.bytes };
}
