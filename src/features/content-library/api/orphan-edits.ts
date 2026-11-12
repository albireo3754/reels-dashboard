import path from "node:path";
import type { Dashboard } from "../../../shared/contracts";

const nfc = (value: string) => path.resolve(value.normalize("NFC"));
const within = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};
/** First folder under the clip root (e.g. `Naver Clip/2026-10-25_공원-산책`), or undefined. */
const shootFolder = (file: string, clipRoot?: string) => {
  if (!clipRoot || !within(file, clipRoot)) return undefined;
  const [first] = path.relative(clipRoot, file).split(path.sep);
  return first ? path.join(clipRoot, first) : undefined;
};
export interface OrphanEditCandidate {
  id: string;
  title: string;
  stage: string;
  /** Footage sits inside one of its folders or in the same shoot folder under the clip root. */
  folderMatch: boolean;
  /** A linked document names every footage file. */
  documentMention: boolean;
}
export interface OrphanEditCard {
  id: string;
  title: string;
  stage: string;
  date: string;
  footage: string[];
  candidates: OrphanEditCandidate[];
  /** The only candidate with both signals; absent when none or several qualify. */
  suggestedTargetId?: string;
}
/**
 * Read-only scan for cards the video editor created on its own: one video edit with the
 * card's own id, title still the footage file name, not published. Each lists the projects
 * that might own it. A shoot folder is often reused for a new reel, so a folder match alone
 * is never a suggestion; the owner's documents must also name the footage.
 * `documents` maps a project id to the text of its linked documents.
 */
export function scanOrphanEdits(
  dashboard: Dashboard,
  clipRoot: string | undefined,
  documents: ReadonlyMap<string, string>,
): OrphanEditCard[] {
  const root = clipRoot ? nfc(clipRoot) : undefined;
  const cards: OrphanEditCard[] = [];
  for (const source of dashboard.projects) {
    const edits = source.production?.edits ?? [];
    const footage = (source.resources ?? []).filter((r) => r.role === "footage");
    if (
      edits.length !== 1 ||
      edits[0].kind !== "video" ||
      edits[0].id !== source.id ||
      source.stage === "published" ||
      source.publicURL ||
      source.publications?.length ||
      !footage.length ||
      source.title.normalize("NFC") !==
        path.basename(footage[0].path).normalize("NFC")
    )
      continue;
    const files = footage.map((r) => nfc(r.path));
    const candidates: OrphanEditCandidate[] = [];
    for (const target of dashboard.projects) {
      if (target.id === source.id) continue;
      const text = (documents.get(target.id) ?? "").normalize("NFC");
      const documentMention = files.every((file) => text.includes(path.basename(file)));
      const folders = (target.resources ?? [])
        .filter((r) => r.role === "folder")
        .map((r) => nfc(r.path));
      const folderMatch = files.every((file) =>
        folders.some((folder) => {
          const shoot = shootFolder(folder, root);
          return within(file, folder) || (shoot !== undefined && shoot === shootFolder(file, root));
        }),
      );
      if (folderMatch || documentMention)
        candidates.push({ id: target.id, title: target.title, stage: target.stage, folderMatch, documentMention });
    }
    const both = candidates.filter((c) => c.folderMatch && c.documentMention);
    cards.push({
      id: source.id,
      title: source.title,
      stage: source.stage,
      date: source.date,
      footage: footage.map((r) => r.path),
      candidates,
      ...(both.length === 1 ? { suggestedTargetId: both[0].id } : {}),
    });
  }
  return cards;
}
