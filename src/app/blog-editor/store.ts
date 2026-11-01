import {
  readFile,
  stat,
  writeFile,
  realpath,
  mkdir,
  rename,
  unlink,
  open,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  readInline,
  inlineHtml,
  escapeHtml,
  type CanonicalDocument,
  type CanonicalFinding,
  type CanonicalReview,
} from "../../shared/canonical-blog";
export interface EditorConfig {
  format?: "markup";
  review?: string;
  requests?: string;
  canon: string;
  layers: string;
  layout: string;
  media: string;
  port?: number;
  assetFiles?: string[];
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const key = (g: any) =>
  g.photo
    ? "photo:" + g.photo
    : g.group
      ? "group:" + g.photos[0][0]
      : g.heading
        ? "heading:" + g.heading
        : g.divider
          ? "divider"
          : g.x
            ? "x:" + g.x
            : g.text;
function sourceParts(raw: string) {
  const marker = "### 본문\n",
    endMarker = "### 비공개";
  const start = raw.indexOf(marker) + marker.length,
    end = raw.indexOf(endMarker, start);
  if (start < marker.length || end < 0)
    throw new Error("정본의 본문·비공개 경계를 찾을 수 없어요.");
  const body = raw.slice(start, end);
  const paragraphs: {
    id: string;
    source: string;
    start: number;
    end: number;
  }[] = [];
  for (const m of body.matchAll(/[^\n]+(?:\n(?!\s*\n)[^\n]+)*/g)) {
    const s = m[0].trim();
    if (
      s.startsWith("〔") ||
      s.startsWith("####") ||
      s === "---" ||
      s.startsWith("#")
    )
      continue;
    paragraphs.push({
      id: `T${paragraphs.length + 1}`,
      source: m[0],
      start: start + m.index!,
      end: start + m.index! + m[0].length,
    });
  }
  const titleMatch = /### 제목\n\s*\n([^\n]+)/.exec(raw);
  if (!titleMatch) throw new Error("정본 제목을 찾을 수 없어요.");
  return {
    paragraphs,
    title: titleMatch[1],
    titleStart: titleMatch.index + titleMatch[0].lastIndexOf(titleMatch[1]),
    body,
    start,
    end,
  };
}
const patchSchema = z.strictObject({
  revision: z.string(),
  edits: z
    .array(
      z.strictObject({ id: z.string(), source: z.string().min(1).max(20000) }),
    )
    .max(100),
  title: z.string().min(1).max(200).optional(),
});
export class CanonicalStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly config: EditorConfig) {}
  async inputs() {
    for (const file of [
      this.config.canon,
      this.config.layout,
      path.join(this.config.layers, "grouping-layer.json"),
      path.join(this.config.layers, "bundle-layer.json"),
      path.join(this.config.layers, "emphasis-layer.json"),
    ])
      if ((await realpath(file)) !== path.resolve(file))
        throw new Error("연결 파일의 경로가 바뀌었어요.");
    const [raw, layout, grouping, bundle, emphasis] = await Promise.all(
      [
        this.config.canon,
        this.config.layout,
        path.join(this.config.layers, "grouping-layer.json"),
        path.join(this.config.layers, "bundle-layer.json"),
        path.join(this.config.layers, "emphasis-layer.json"),
      ].map((p) => readFile(p, "utf8")),
    );
    const parts = sourceParts(raw),
      G = JSON.parse(grouping).layout,
      B = JSON.parse(bundle).bundles;
    const ids = new Set(parts.paragraphs.map((p) => p.id));
    const used = G.flatMap((g: any) =>
      g.text ? (Array.isArray(g.text) ? g.text : [g.text]) : [],
    );
    if (
      used.length !== ids.size ||
      new Set(used).size !== ids.size ||
      used.some((id: string) => !ids.has(id))
    )
      throw new Error(
        "정본 문단과 묶음 레이어가 맞지 않아요. 엔진에서 동기화한 뒤 열어주세요.",
      );
    const keys = G.map(key);
    let next = 0;
    const bundles = B.map((b: any) => {
      const start = keys.indexOf(b.from),
        end = keys.indexOf(b.to);
      if (start !== next || end < start)
        throw new Error("묶음 경계가 겹치거나 빠졌어요.");
      next = end + 1;
      return {
        id: b.id,
        name: b.name,
        question: b.question,
        start,
        end,
        paragraphIds: G.slice(start, end + 1).flatMap((g: any) =>
          g.text ? (Array.isArray(g.text) ? g.text : [g.text]) : [],
        ),
      };
    });
    if (next !== G.length) throw new Error("묶음에 속하지 않은 블록이 있어요.");
    return {
      raw,
      layout,
      grouping,
      bundle,
      emphasis,
      parts,
      G,
      bundles,
      revision: hash([raw, grouping, bundle, emphasis].join("\0")),
    };
  }
  async load(): Promise<CanonicalDocument> {
    const x = await this.inputs();
    let reviews: CanonicalReview[] = [];
    try {
      const R = JSON.parse(
        await readFile(
          path.join(this.config.layers, "bundle-review.json"),
          "utf8",
        ),
      );
      reviews = (R.reviews ?? []).map((r: any) => {
        const b = x.bundles.find((b: any) => b.id === r.bundleId);
        // Same text receipt as the existing Python composer; full visual freshness is not claimed.
        const pieces =
          b?.paragraphIds.map((id: string) => [
            id,
            readInline(x.parts.paragraphs.find((p) => p.id === id)!.source)
              .map((r) => r.text)
              .join("")
              .split("\n"),
          ]) ?? [];
        const pythonJson = (v: any): string =>
          Array.isArray(v)
            ? "[" + v.map(pythonJson).join(", ") + "]"
            : JSON.stringify(v);
        return {
          bundleId: r.bundleId,
          summary: r.summary,
          verdict: r.verdict,
          freshText:
            hash(pythonJson(pieces)).slice(0, 16) === r.basedOn?.textHash,
          findings: (r.findings ?? []).map((f: CanonicalFinding) => ({
            ...f,
            status: R.corrections?.[f.id]?.status ?? f.status ?? "proposed",
          })),
        };
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return {
      savedAt:(await stat(this.config.canon)).mtime.toISOString(),
      title: x.parts.title,
      path: this.config.canon,
      revision: x.revision,
      frameVersion: hash(x.layout),
      fontCss: [...x.layout.matchAll(/@font-face\s*\{[^}]*\}/g)]
        .map((m) => m[0])
        .join("\n")
        .replace(
          /url\(([^)]+)\)/g,
          (_, v) =>
            `url('/api/blog/asset?kind=font&name=${encodeURIComponent(path.basename(v.replace(/["']/g, "")))}')`,
        ),
      paragraphs: x.parts.paragraphs.map(({ id, source }) => ({ id, source })),
      bundles: x.bundles.map(({ start, end, ...b }: any) => b),
      reviews,
    };
  }
  async asset(kind: string, name: string) {
    if (name !== path.basename(name)) throw new Error("잘못된 자산 이름");
    const x = await this.inputs();
    let file: string;
    if (kind === "photo") {
      const names = x.G.flatMap((g: any) =>
        g.photo ? [g.photo] : (g.photos?.map((p: string[]) => p[0]) ?? []),
      );
      if (!names.includes(name)) throw new Error("연결되지 않은 사진");
      file = path.join(this.config.media, name);
    } else if (kind === "font") {
      const urls = [...x.layout.matchAll(/url\(([^)]+)\)/g)].map((m) =>
        m[1].replace(/["']/g, ""),
      );
      const ref = urls.find(
        (p) => path.basename(p) === name && p.endsWith(".woff2"),
      );
      if (!ref) throw new Error("연결되지 않은 글꼴");
      file = path.resolve(path.dirname(this.config.layout), ref);
    } else throw new Error("잘못된 자산 종류");
    const resolved = await realpath(file);
    if (
      resolved !== path.resolve(file) &&
      !(this.config.assetFiles ?? []).some((p) => path.resolve(p) === resolved)
    )
      throw new Error("자산 경로가 바뀌었어요.");
    return resolved;
  }
  async frame() {
    const x = await this.inputs();
    const texts = new Map(x.parts.paragraphs.map((p) => [p.id, p.source]));
    const p = (tid: string, cls = "paragraph") =>
      `<p class="${cls}" contenteditable="true" spellcheck="false" data-tid="${tid}" role="textbox" aria-label="${tid} 문단">${inlineHtml(texts.get(tid)!)}</p>`;
    const image = (name: string, alt = "") =>
      `<img src="/api/blog/asset?kind=photo&name=${encodeURIComponent(name)}" alt="${escapeHtml(alt)}" loading="lazy">`;
    const html = x.bundles
      .map(
        (b: any) =>
          `<section class="editor-bundle" data-bundle="${escapeHtml(b.id)}"><div class="editor-bundle-label">${escapeHtml(b.name)}</div>` +
          x.G.slice(b.start, b.end + 1)
            .map((g: any) => {
              if (g.photo) return `<figure>${image(g.photo, g.alt)}</figure>`;
              if (g.group)
                return `<figure class="photo-grid4 even">${g.photos.map(([f, a]: string[]) => "<div>" + image(f, a) + "</div>").join("")}</figure>`;
              if (g.heading)
                return `<blockquote class="section-heading"><h2>${escapeHtml(g.heading)}</h2></blockquote>`;
              if (g.divider) return '<hr class="scene-divider">';
              if (g.x === "price-box")
                return `<blockquote class="price-box">${p(g.text)}</blockquote>`;
              if (g.x === "visit-info")
                return `<section class="visit-card">${g.text.map((id: string) => p(id, "info")).join("")}</section>`;
              if (g.x === "question-card")
                return '<aside class="native-card">From, 블로그씨 · 야장 열풍</aside>';
              if (g.x === "naver-map")
                return '<aside class="native-card">네이버 장소 지도 · 기존 자리</aside>';
              if (g.x === "tags")
                return (
                  '<p class="tags">' +
                  escapeHtml(
                    x.parts.body
                      .split("\n")
                      .find(
                        (l) => l.startsWith("#") && !l.startsWith("####"),
                      ) ?? "",
                  ) +
                  "</p>"
                );
              return g.text ? p(g.text) : "";
            })
            .join("") +
          "</section>",
      )
      .join("");
    const styles = [...x.layout.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
      .map((m) => m[1])
      .join("\n")
      .replace(
        /url\(([^)]+)\)/g,
        (_, v) =>
          `url('/api/blog/asset?kind=font&name=${encodeURIComponent(path.basename(v.replace(/["']/g, "")))}')`,
      );
    return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}\nbody{background:white}main,main.mobile{width:100%;margin:0 auto;padding:24px 20px;box-sizing:border-box}header{margin-bottom:32px}[contenteditable]{outline:none;cursor:text;min-height:1em}[contenteditable]:focus{outline:2px solid #91b8a6;outline-offset:8px;border-radius:2px}.editor-bundle{position:relative;padding-top:12px}.editor-bundle-label{font:11px sans-serif;color:#83988b;text-align:left;margin:10px 0 18px}.editor-bundle.active{box-shadow:inset 3px 0 #5b8875}img{max-width:100%}</style><main><header><small>블로그 정본</small><h1 contenteditable="true" spellcheck="false" data-tid="$title" role="textbox" aria-label="글 제목">${escapeHtml(x.parts.title)}</h1></header><article>${html}</article></main><script type="module" src="/editor-frame.js"></script></html>`;
  }
  async save(value: unknown) {
    const patch = patchSchema.parse(value);
    const task = this.queue.then(async () => {
      const lockPath = path.join(this.config.layers, ".editor-save.lock");
      const lock = await open(lockPath, "wx");
      try {
        const x = await this.inputs();
        if (x.revision !== patch.revision)
          throw new Error(
            "다른 세션에서 정본을 수정했어요. 변경을 복사한 뒤 최신 정본을 다시 불러와주세요.",
          );
        if (new Set(patch.edits.map((p) => p.id)).size !== patch.edits.length)
          throw new Error("중복 문단 수정");
        const edits = new Map(patch.edits.map((e) => [e.id, e.source]));
        for (const [id, source] of edits) {
          if (!x.parts.paragraphs.some((p) => p.id === id))
            throw new Error("없는 문단");
          if (/\n\s*\n|^〔|^####|^---$|^#/m.test(source))
            throw new Error(
              "문단 안에서는 Shift+Enter로 줄을 바꿔주세요. 새 블록 표시는 넣을 수 없어요.",
            );
          if (readInline(source).some((run) => /[<>]/.test(run.text)))
            throw new Error("지원하지 않는 HTML");
        }
        let raw = x.raw;
        for (const part of [...x.parts.paragraphs].reverse()) {
          const after = edits.get(part.id);
          if (after !== undefined)
            raw = raw.slice(0, part.start) + after + raw.slice(part.end);
        }
        if (patch.title !== undefined) {
          if (/[<>\n]/.test(patch.title))
            throw new Error("제목은 한 줄로 입력해주세요.");
          raw =
            raw.slice(0, x.parts.titleStart) +
            patch.title +
            raw.slice(x.parts.titleStart + x.parts.title.length);
        }
        const E = JSON.parse(x.emphasis);
        for (const [id, source] of edits) {
          const old = E.emphasis.filter((e: any) => e.id === id);
          E.emphasis = E.emphasis.filter((e: any) => e.id !== id);
          for (const run of readInline(source)) {
            if (!Object.keys(run.style).length) continue;
            for (const phrase of run.text.split("\n")) {
              if (!phrase.trim()) continue;
              const previous = old.find((e: any) => e.phrase === phrase);
              const { background, ...style } = run.style;
              E.emphasis.push({
                ...previous,
                id,
                phrase,
                occurrence: 1,
                style: { ...style, ...(background ? { bg: background } : {}) },
                role: previous?.role ?? "사용자 직접 강조",
                reason: "정본 스마트 에디터에서 직접 편집",
              });
            }
          }
        }
        const backup = path.join(
          this.config.layers,
          "editor-backups",
          `${Date.now()}-${randomUUID()}`,
        );
        await mkdir(backup, { recursive: true });
        await Promise.all([
          writeFile(path.join(backup, "canonical.md"), x.raw),
          writeFile(path.join(backup, "emphasis-layer.json"), x.emphasis),
          writeFile(path.join(backup, "layout.html"), x.layout),
        ]);
        if ((await this.inputs()).revision !== x.revision)
          throw new Error("저장 중 외부 변경이 감지됐어요. 다시 불러와주세요.");
        const emphasis = JSON.stringify(E, null, 2) + "\n";
        // Replace only affected editable paragraphs in the generated layout; retain all photos and layout.
        const originals = x.G.flatMap((g: any) =>
          g.text ? (Array.isArray(g.text) ? g.text : [g.text]) : [],
        );
        let index = 0;
        let layout = x.layout.replace(
          /<p\b([^>]*)>([\s\S]*?)<\/p>/g,
          (all, attrs, body) => {
            if (!/class="(?:paragraph|info|source)"/.test(attrs)) {
              // The price-box paragraph has no class in compose.py.
              if (attrs.trim() !== "") return all;
            }
            const tid = originals[index++];
            return edits.has(tid)
              ? `<p${attrs}>${inlineHtml(edits.get(tid)!)}</p>`
              : all;
          },
        );
        if (edits.size && index !== originals.length)
          throw new Error(
            "미리보기 문단 매핑이 바뀌었어요. 저장하지 않았습니다.",
          );
        if (patch.title !== undefined)
          layout = layout.replace(
            /<h1[^>]*>[\s\S]*?<\/h1>/,
            `<h1>${escapeHtml(patch.title)}</h1>`,
          );
        const writes: [[string, string], [string, string], [string, string]] = [
          [this.config.canon, raw],
          [path.join(this.config.layers, "emphasis-layer.json"), emphasis],
          [this.config.layout, layout],
        ];
        for (const [file, content] of writes)
          await writeFile(file + ".editor-tmp", content);
        const previous = new Map([
          [this.config.canon, x.raw],
          [path.join(this.config.layers, "emphasis-layer.json"), x.emphasis],
          [this.config.layout, x.layout],
        ]);
        const committed: string[] = [];
        try {
          for (const [file] of writes) {
            if ((await readFile(file, "utf8")) !== previous.get(file))
              throw new Error("저장 중 다른 세션의 변경이 감지됐어요.");
            await rename(file + ".editor-tmp", file);
            committed.push(file);
          }
        } catch (e) {
          for (const file of committed) {
            if (
              (await readFile(file, "utf8")) ===
              writes.find(([p]) => p === file)![1]
            )
              await writeFile(file, previous.get(file)!);
          }
          throw e;
        }
        return { document: await this.load(), backup };
      } finally {
        await lock.close();
        await unlink(lockPath);
      }
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async request(value: unknown) {
    const input = z
      .strictObject({
        revision: z.string(),
        bundleIds: z.array(z.string()).min(1).max(100),
      })
      .parse(value);
    const d = await this.load();
    if (input.revision !== d.revision)
      throw new Error("정본이 바뀌었어요. 다시 불러와주세요.");
    if (input.bundleIds.some((id) => !d.bundles.some((b) => b.id === id)))
      throw new Error("없는 묶음");
    const dir = path.join(this.config.layers, "editor-requests");
    await mkdir(dir, { recursive: true });
    const request = {
      id: randomUUID(),
      kind: "blog.editor.review-request",
      status: "pending",
      trigger: "user",
      createdAt: new Date().toISOString(),
      basedOn: d.revision,
      bundleIds: input.bundleIds,
      canon: this.config.canon,
      layers: this.config.layers,
    };
    await writeFile(
      path.join(dir, request.id + ".json"),
      JSON.stringify(request, null, 2),
    );
    return request;
  }
}
