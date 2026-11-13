import path from "node:path";
import type { Dashboard, LocalResource } from "../../../shared/contracts";
import { attachEdit, editOwner } from "../../../shared/production-project";

/**
 * Photos bundle import: every photo and video of one capture group (or a chosen
 * subset) is copied into app storage and attached to one existing content card.
 * Photos originals are only read; copies come from the native checked
 * materialization. A ledger keyed by the stable public asset ID keeps repeated
 * imports from copying the same original again.
 */
export type BundleMediaKind = "photo" | "video";
export interface BundleAsset {
  id: string;
  mediaKind: BundleMediaKind;
  publicFilename?: string | null;
}
export interface MaterializedMedia {
  assetID: string;
  mediaKind: BundleMediaKind;
  sourcePath: string;
  pairedVideoPath?: string | null;
  originalFilename?: string | null;
}
export interface PhotosImportEntry {
  assetId: string;
  mediaKind: BundleMediaKind;
  sourcePath: string;
  /** Live Photo motion video copied next to the still. */
  pairedVideoPath?: string;
  /** Edit project created for a video. */
  editId?: string;
  name: string;
  importedAt: string;
}
export interface PhotosImportLedger {
  schemaVersion: 1;
  assets: Record<string, PhotosImportEntry>;
}
export const emptyPhotosImportLedger = (): PhotosImportLedger => ({
  schemaVersion: 1,
  assets: {},
});

export interface PhotosBundleInput {
  projectId: string;
  groupId: string;
  indexRunId: string;
  /** Subset of the group; omitted imports every asset in the group. */
  assetIds?: string[];
}
export type PhotosBundleStatus =
  | "imported"
  | "already-imported"
  | "linked-elsewhere"
  | "failed";
export interface PhotosBundleItem {
  assetId: string;
  mediaKind: BundleMediaKind;
  status: PhotosBundleStatus;
  name?: string;
  path?: string;
  pairedVideoPath?: string;
  editId?: string;
  /** Card that already owns this video's edit project (status linked-elsewhere). */
  ownerId?: string;
  error?: string;
}
export interface PhotosBundleResult {
  projectId: string;
  groupId: string;
  indexRunId: string;
  items: PhotosBundleItem[];
  counts: Record<PhotosBundleStatus, number> & {
    photos: number;
    videos: number;
    livePhotos: number;
  };
  dashboardUpdatedAt: string;
}

export interface PhotosBundleDeps {
  /** Current group membership from the read-only `groups.show`. */
  groupAssets(): Promise<BundleAsset[]>;
  /** Resource paths of the target card; undefined when the card does not exist. */
  target(projectId: string): Promise<{ resourcePaths: string[] } | undefined>;
  /** Card that owns a video edit project, if any. */
  editOwner(editId: string): Promise<string | undefined>;
  loadLedger(): Promise<PhotosImportLedger>;
  saveLedger(ledger: PhotosImportLedger): Promise<void>;
  isFile(file: string): Promise<boolean>;
  editExists(id: string): Promise<boolean>;
  /** Native `media.materialize`: copy only, never a Photos write. */
  materialize(assetId: string): Promise<MaterializedMedia>;
  /** Edit project for a copied video, created without a card of its own. */
  createEdit(sourcePath: string): Promise<{ id: string }>;
  /** One dashboard write that attaches everything to the target card. */
  attach(
    mutate: (dashboard: Dashboard) => {
      dashboard: Dashboard;
      owners: Map<string, string>;
    },
  ): Promise<{ dashboard: Dashboard; owners: Map<string, string> }>;
  now(): Date;
}

const failure = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const maxCardResources = 500;

/** A previous copy is reusable while every file it names still exists. */
async function copyExists(
  entry: PhotosImportEntry | undefined,
  deps: PhotosBundleDeps,
) {
  if (!entry || !(await deps.isFile(entry.sourcePath))) return false;
  return !entry.pairedVideoPath || (await deps.isFile(entry.pairedVideoPath));
}

export async function importPhotosBundle(
  input: PhotosBundleInput,
  deps: PhotosBundleDeps,
): Promise<PhotosBundleResult> {
  const target = await deps.target(input.projectId);
  if (!target)
    throw new Error("CONTENT_NOT_FOUND: 가져올 대상 콘텐츠 카드를 확인해주세요.");
  const group = await deps.groupAssets();
  let selected = group;
  if (input.assetIds) {
    const wanted = new Set(input.assetIds);
    const missing = [...wanted].filter((id) => !group.some((a) => a.id === id));
    if (missing.length)
      throw new Error(
        `PHOTOS_ASSET_NOT_IN_GROUP: 현재 그룹에 없는 자산이에요 (${missing.join(", ")}).`,
      );
    selected = group.filter((a) => wanted.has(a.id));
  }
  if (!selected.length)
    throw new Error("PHOTOS_GROUP_EMPTY: 가져올 사진·영상이 없어요.");

  const ledger = await deps.loadLedger();
  // Fail before copying when the card clearly cannot hold the new resources.
  const onCard = new Set(target.resourcePaths);
  const adding = selected.filter((a) => {
    const entry = ledger.assets[a.id];
    return !entry || !onCard.has(entry.sourcePath);
  }).length;
  if (target.resourcePaths.length + adding > maxCardResources)
    throw new Error(
      `TOO_MANY_RESOURCES: 카드 자료는 ${maxCardResources}개까지예요(지금 ${target.resourcePaths.length}개, 추가 ${adding}개). assetIds로 이 카드에 넣을 자산을 줄여주세요.`,
    );

  const items: PhotosBundleItem[] = [];
  const entries: PhotosImportEntry[] = [];
  const stale: PhotosImportEntry[] = [];
  for (const asset of selected) {
    const previous = ledger.assets[asset.id];
    try {
      // A video already linked to another card stays there: no copy, no new edit.
      const owner = previous?.editId
        ? await deps.editOwner(previous.editId)
        : undefined;
      if (owner && owner !== input.projectId) {
        items.push({
          assetId: asset.id,
          mediaKind: asset.mediaKind,
          status: "linked-elsewhere",
          ownerId: owner,
          name: previous!.name,
          path: previous!.sourcePath,
          editId: previous!.editId,
        });
        continue;
      }
      const reuseCopy = await copyExists(previous, deps);
      const editAlive =
        !!previous?.editId && (await deps.editExists(previous.editId));
      if (reuseCopy && (asset.mediaKind === "photo" || editAlive)) {
        entries.push(previous!);
        items.push({ assetId: asset.id, mediaKind: asset.mediaKind, status: "already-imported" });
        continue;
      }
      let entry: PhotosImportEntry;
      if (reuseCopy) {
        // The copy survived but its edit did not: only the edit is made again.
        const { editId: _gone, ...kept } = previous!;
        entry = kept;
      } else {
        const copied = await deps.materialize(asset.id);
        if (copied.assetID !== asset.id || copied.mediaKind !== asset.mediaKind)
          throw new Error("Photos 복사 결과가 선택한 자산과 달라요.");
        entry = {
          assetId: asset.id,
          mediaKind: asset.mediaKind,
          sourcePath: copied.sourcePath,
          ...(copied.pairedVideoPath ? { pairedVideoPath: copied.pairedVideoPath } : {}),
          name:
            copied.originalFilename ||
            asset.publicFilename ||
            path.basename(copied.sourcePath),
          importedAt: deps.now().toISOString(),
        };
        // Record the copy before anything else can fail, so a rerun never copies it again.
        ledger.assets[asset.id] = entry;
        await deps.saveLedger(ledger);
      }
      if (previous && (!reuseCopy || previous.editId)) stale.push(previous);
      if (asset.mediaKind === "video") {
        entry = { ...entry, editId: (await deps.createEdit(entry.sourcePath)).id };
        ledger.assets[asset.id] = entry;
        await deps.saveLedger(ledger);
      }
      entries.push(entry);
      items.push({ assetId: asset.id, mediaKind: asset.mediaKind, status: "imported" });
    } catch (error) {
      items.push({
        assetId: asset.id,
        mediaKind: asset.mediaKind,
        status: "failed",
        error: failure(error),
      });
    }
  }

  const { dashboard, owners } = await deps.attach((current) =>
    attachPhotosBundle(current, input.projectId, entries, stale),
  );
  for (const item of items) {
    const entry = entries.find((e) => e.assetId === item.assetId);
    if (!entry || item.status === "linked-elsewhere") continue;
    item.name = entry.name;
    item.path = entry.sourcePath;
    if (entry.pairedVideoPath) item.pairedVideoPath = entry.pairedVideoPath;
    if (entry.editId) item.editId = entry.editId;
    const owner = owners.get(entry.assetId);
    if (owner) {
      item.status = "linked-elsewhere";
      item.ownerId = owner;
    }
  }
  const count = (status: PhotosBundleStatus) =>
    items.filter((i) => i.status === status).length;
  return {
    projectId: input.projectId,
    groupId: input.groupId,
    indexRunId: input.indexRunId,
    items,
    counts: {
      imported: count("imported"),
      "already-imported": count("already-imported"),
      "linked-elsewhere": count("linked-elsewhere"),
      failed: count("failed"),
      photos: entries.filter((e) => e.mediaKind === "photo").length,
      videos: entries.filter((e) => e.mediaKind === "video").length,
      livePhotos: entries.filter((e) => e.pairedVideoPath).length,
    },
    dashboardUpdatedAt: dashboard.updatedAt,
  };
}

export const livePhotoLabel = (name: string) => `${name} (Live Photo 영상)`;

/**
 * Attach copied media to one card: photos (and Live Photo motion) as footage
 * resources, videos as linked edit projects plus their footage. A video whose
 * edit already belongs to another card stays there and is reported by owner.
 */
export function attachPhotosBundle(
  current: Dashboard,
  projectId: string,
  entries: PhotosImportEntry[],
  /** Earlier imports of re-copied assets: their missing files and dead edit leave the card. */
  stale: PhotosImportEntry[] = [],
): { dashboard: Dashboard; owners: Map<string, string> } {
  const target = current.projects.find((p) => p.id === projectId);
  if (!target)
    throw new Error("CONTENT_NOT_FOUND: 가져올 대상 콘텐츠 카드를 확인해주세요.");
  const owners = new Map<string, string>();
  const stalePaths = new Set(
    stale.flatMap((e) => [e.sourcePath, ...(e.pairedVideoPath ? [e.pairedVideoPath] : [])]),
  );
  const fresh = new Set(entries.flatMap((e) => [e.sourcePath, e.pairedVideoPath]));
  const resources: LocalResource[] = (target.resources ?? []).filter(
    (r) => !(r.role === "footage" && stalePaths.has(r.path) && !fresh.has(r.path)),
  );
  const add = (resource: LocalResource) => {
    if (!resources.some((r) => r.path === resource.path && r.role === resource.role))
      resources.push(resource);
  };
  let production = target.production;
  const staleEdits = new Set(stale.flatMap((e) => (e.editId ? [e.editId] : [])));
  if (production && staleEdits.size) {
    const exported = new Set(production.exports.map((x) => x.edit.id));
    production = {
      ...production,
      // An edit with recorded outputs stays: its export history must keep its edit.
      edits: production.edits.filter(
        (e) => !(e.kind === "video" && staleEdits.has(e.id) && !exported.has(e.id)),
      ),
    };
  }
  for (const entry of entries) {
    if (entry.mediaKind === "video" && entry.editId) {
      const edit = { kind: "video" as const, id: entry.editId };
      const owner = editOwner(current, edit);
      if (owner && owner.id !== target.id) {
        owners.set(entry.assetId, owner.id);
        continue;
      }
      production = attachEdit({ ...target, production }, edit);
    }
    add({ role: "footage", path: entry.sourcePath, label: entry.name });
    if (entry.pairedVideoPath)
      add({ role: "footage", path: entry.pairedVideoPath, label: livePhotoLabel(entry.name) });
  }
  if (resources.length > maxCardResources)
    throw new Error(
      `TOO_MANY_RESOURCES: 카드 자료는 ${maxCardResources}개까지예요. assetIds로 이 카드에 넣을 자산을 줄여주세요.`,
    );
  const next: Dashboard = {
    ...current,
    projects: current.projects.map((p) =>
      p.id === target.id
        ? { ...p, resources, ...(production ? { production } : {}) }
        : p,
    ),
  };
  return { dashboard: next, owners };
}
