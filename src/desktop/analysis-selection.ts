import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { execFile } from "node:child_process";
import { readFile, mkdir, unlink, writeFile } from "node:fs/promises";
import { sha256Hex } from "../shared/lib/hash";
import { readJsonFile } from "../shared/lib/fs";
import { LocalStore } from "../shared/lib/storage";
import { selectionQuery, selectionExecute, selectionUpdate, type SelectionDocument } from "../shared/analysis-selection";
import type { AnalysisView } from "../shared/media-analysis";
/** Selection is explicit, deterministic and independent of model analysis. */
export class AnalysisSelection {
  constructor(private store: LocalStore, private analysis: { search(value: unknown): Promise<AnalysisView> }, private ffmpeg?: string) {}
  private file(id: string) { return path.join(this.store.root, "media-selection", sha256Hex(id) + ".json"); }
  private async load(projectId: string): Promise<SelectionDocument> {
    await this.analysis.search({ projectId });
    return readJsonFile<SelectionDocument>(this.file(projectId), v => {
      const d = v as SelectionDocument;
      if (d.schemaVersion !== 1 || d.projectId !== projectId) throw Error("SELECTION_FORMAT");
      return d;
    }, () => ({ schemaVersion: 1, projectId, revision: 0, candidates: [], groups: [], usage: [] }));
  }
  async search(value: unknown) { return this.load(selectionQuery.parse(value).projectId); }
  private async change(projectId: string, revision: number, operation: (d: SelectionDocument) => Promise<void>) {
    const root = path.dirname(this.file(projectId));
    await mkdir(root, { recursive: true, mode: 0o700 });
    const lock = path.join(root, "active.lock");
    await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    try {
      const d = await this.load(projectId);
      if (d.revision !== revision) throw Error("STALE_SELECTION: 다시 조회해주세요.");
      await operation(d); d.revision++;
      await this.store.atomic(this.file(projectId), d);
      return d;
    } finally { await unlink(lock); }
  }
  private async fingerprint(file: string) {
    if (!this.ffmpeg) return { hash: sha256Hex(await readFile(file)), perceptual: false, mean: 0, quality: 0 };
    const pixels = await new Promise<Buffer>((resolve, reject) => execFile(this.ffmpeg!, ["-nostdin", "-v", "error", "-i", file, "-vf", "scale=9:8,format=gray", "-frames:v", "1", "-f", "rawvideo", "pipe:1"], { encoding: "buffer", timeout: 30000, maxBuffer: 4096 }, (e, out) => e ? reject(e) : resolve(out)));
    if (pixels.length !== 72) throw Error("SELECTION_FINGERPRINT");
    let bits = "";
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += pixels[y * 9 + x] > pixels[y * 9 + x + 1] ? "1" : "0";
    const mean = [...pixels].reduce((a, b) => a + b, 0) / pixels.length;
    const quality = [...pixels].reduce((a, b) => a + (b - mean) ** 2, 0) / pixels.length;
    return { hash: bits, perceptual: true, mean, quality };
  }
  async execute(value: unknown) {
    const i = selectionExecute.parse(value);
    return this.change(i.projectId, i.expectedRevision, async d => {
      const view = await this.analysis.search({ projectId: i.projectId });
      const old = new Map(d.candidates.map(c => [c.sampleId, c]));
      d.candidates = view.matches.map(r => old.get(r.sample.id)?.human ? old.get(r.sample.id)! : {
        sampleId: r.sample.id, usable: r.effective.usability?.usable ?? true, human: false,
        reason: r.effective.usability?.reason ?? `이전 분석: 사용성 미판정, 후보 보존. 분석 성공: ${r.effective.description}. 자동 품질 배제 없이 후보로 보존; 불확실성: ${r.effective.uncertainties.join("; ") || "없음"}`,
      });
      const buckets = new Map<string, string[]>();
      const fingerprints = new Map<string, { hash: string; mean: number; quality: number }>();
      const qualities = new Map<string, number>();
      for (const c of d.candidates.filter(c => c.usable)) {
        const r = view.matches.find(r => r.sample.id === c.sampleId)!;
        // Perceptual grouping uses rendered content, never source filenames.
        const fingerprint = await this.fingerprint(r.sample.imagePath);
        const near = fingerprint.perceptual ? [...buckets.keys()].find(key => Math.abs(fingerprints.get(key)!.mean - fingerprint.mean) <= 12 && [...fingerprints.get(key)!.hash].filter((bit, index) => bit !== fingerprint.hash[index]).length <= 4) : undefined;
        const digest = near ?? sha256Hex(JSON.stringify([fingerprint.hash, Math.round(fingerprint.mean)]));
        fingerprints.set(digest, fingerprint); qualities.set(c.sampleId, fingerprint.quality);
        buckets.set(digest, [...(buckets.get(digest) ?? []), c.sampleId]);
      }
      const previous = new Map(d.groups.map(g => [g.id, g]));
      d.groups = [...buckets].map(([id, sampleIds]) => {
        sampleIds.sort((a, b) => (qualities.get(b)! - qualities.get(a)!) || a.localeCompare(b)); const prior = previous.get(id) ?? d.groups.find(g => g.human && sampleIds.includes(g.representative));
        if (prior?.human && sampleIds.includes(prior.representative)) return { ...prior, sampleIds };
        return { id, sampleIds, representative: sampleIds[0], reason: "지각 해시 차이 4비트 이내(미설정 테스트는 동일 JPEG). 저해상도 명암 분산이 큰 프레임을 우선, 동점은 sample ID 순. 노출·초점의 완전한 품질 평가가 아니므로 사람 검토 필요.", human: false };
      });
      d.usage = d.usage.filter(u => u.source !== "linked-edit");
      const dashboard = await this.store.load();
      const project = dashboard.projects.find(p => p.id === i.projectId);
      const digestCache = new Map<string, string>();
      const digest = async (file: string) => {
        if (!digestCache.has(file)) {
          const hash = createHash("sha256");
          for await (const chunk of createReadStream(file)) hash.update(chunk);
          digestCache.set(file, hash.digest("hex"));
        }
        return digestCache.get(file)!;
      };
      for (const edit of project?.production?.edits ?? []) {
        if (!/^[0-9a-f-]{36}$/i.test(edit.id)) continue;
        const sources: string[] = [];
        try {
          if (edit.kind === "video") {
            const record = JSON.parse(await readFile(path.join(this.store.root, "editor", edit.id, "project.json"), "utf8"));
            if (record.project?.id === edit.id && typeof record.sourcePath === "string") sources.push(record.sourcePath);
          } else {
            const plan = JSON.parse(await readFile(path.join(this.store.root, "card-news", "plans", edit.id + ".json"), "utf8"));
            for (const assetId of new Set<string>(plan.cards.flatMap((c: { imageId?: string; overlayId?: string }) => [c.imageId, c.overlayId]).filter(Boolean))) {
              if (!/^[0-9a-f-]{36}$/i.test(assetId)) continue;
              const asset = JSON.parse(await readFile(path.join(this.store.root, "card-news", "assets", assetId + ".json"), "utf8"));
              if (asset.id === assetId && path.basename(asset.file) === asset.file) sources.push(path.join(this.store.root, "card-news", "assets", asset.file));
            }
          }
          for (const source of sources) for (const r of view.matches) {
            if (await digest(source) !== await digest(r.sample.sourcePath)) continue;
            const entry = { sampleId: r.sample.id, contentId: i.projectId, editId: edit.id, source: "linked-edit" as const };
            if (!d.usage.some(u => u.sampleId === entry.sampleId && u.contentId === entry.contentId && u.editId === entry.editId)) d.usage.push(entry);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      d.analysisRevision = view.revision;
    });
  }
  async update(value: unknown) {
    const i = selectionUpdate.parse(value);
    return this.change(i.projectId, i.expectedRevision, async d => {
      if (i.candidate) {
        const c = d.candidates.find(c => c.sampleId === i.candidate!.sampleId);
        if (!c) throw Error("CANDIDATE_NOT_FOUND"); Object.assign(c, i.candidate, { human: true });
        if (!c.usable) {
          d.groups = d.groups.map(g => {
            const sampleIds = g.sampleIds.filter(id => id !== c.sampleId);
            return { ...g, sampleIds, representative: sampleIds.includes(g.representative) ? g.representative : sampleIds[0], reason: g.representative === c.sampleId ? "기존 대표 사용 불가: 남은 첫 후보 선택" : g.reason };
          }).filter(g => g.sampleIds.length);
        }
      }
      if (i.representative) {
        const g = d.groups.find(g => g.id === i.representative!.groupId);
        if (!g || !g.sampleIds.includes(i.representative.sampleId)) throw Error("GROUP_MEMBER_REQUIRED");
        g.representative = i.representative.sampleId; g.reason = i.representative.reason; g.human = true;
      }
      if (i.usage) {
        if (!d.candidates.some(c => c.sampleId === i.usage!.sampleId)) throw Error("CANDIDATE_NOT_FOUND");
        const { used, ...entry } = i.usage;
        d.usage = d.usage.filter(u => !(u.sampleId === entry.sampleId && u.contentId === entry.contentId && u.editId === entry.editId));
        if (used) d.usage.push(entry);
      }
    });
  }
}
