import { open, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { Project } from "../shared/contracts";
import { parseRouteMap, ROUTE_MAP_FILENAME, type LocalRouteMap } from "../shared/route-map";

export interface RouteLibraryAccess {
  get(id: string): Promise<{ project: Project }>;
  resolveMedia(id: string, candidate: string): Promise<unknown>;
}
/** Read one registered document; paths contained in it do not grant file access. */
export class RouteLibrary {
  constructor(private access: RouteLibraryAccess) {}
  async load(projectId: string): Promise<LocalRouteMap | null> {
    if (typeof projectId !== "string" || !projectId || projectId.length > 300) throw new Error("콘텐츠 ID를 확인해주세요.");
    const { project } = await this.access.get(projectId);
    const documents = project.resources?.filter((r) => r.role === "document" && path.basename(r.path) === ROUTE_MAP_FILENAME) ?? [];
    if (!documents.length) return null;
    if (documents.length > 1) throw new Error("촬영 지도 문서를 하나만 연결해주세요.");
    const file = documents[0].path;
    if (!path.isAbsolute(file) || path.resolve(file) !== file || await realpath(file) !== file || (await lstat(file)).isSymbolicLink()) throw new Error("지도 문서 경로가 변경됐어요. 다시 연결해주세요.");
    const handle = await open(file, "r");
    let raw: unknown;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error("지도 문서는 8MB 이하의 JSON 파일이어야 해요.");
      raw = JSON.parse(await handle.readFile("utf8"));
    } finally { await handle.close(); }
    const data = parseRouteMap(raw);
    const original = raw as { assets?: Array<{ name?: string; source?: unknown }> };
    const mediaByName: Record<string, string> = Object.create(null);
    for (const a of data.assets) {
      const source = original.assets?.find((r) => r.name === a.name)?.source;
      const candidates = [
        ...(typeof source === "string" ? [source] : []),
        ...(project.resources ?? []).flatMap((r) => r.role === "folder" ? [path.join(r.path, a.name)] : path.basename(r.path) === a.name ? [r.path] : []),
      ];
      for (const candidate of new Set(candidates)) {
        if (path.basename(candidate) !== a.name) continue;
        try { await this.access.resolveMedia(projectId, candidate); mediaByName[a.name] = candidate; break; } catch { /* unavailable or unregistered media stays explicit */ }
      }
    }
    return { data, mediaByName };
  }
}
