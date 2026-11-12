import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DashboardBridge } from "../../../shared/contracts";
import { errorMessage } from "../../../shared/lib/errors";
import type {
  ContentDocumentText,
  ContentMediaItem,
} from "../../../shared/content-media";
import { parse, type MarkupDoc } from "../../../shared/blog-markup";
import {
  MARKUP_STYLE_CSS,
  renderHtml,
} from "../../../shared/blog-markup-render";
import { MarkdownView } from "../../../shared/ui/MarkdownView";
import {
  blogAssetPath,
  defaultDocumentView,
  documentViewLabels,
  documentViewModes,
  isBlogMarkup,
  splitFrontmatter,
  type DocumentViewMode,
} from "../model/document-view";

/** Photos fetched for one blog preview; the rest stay as labelled placeholders. */
const BLOG_PHOTO_LIMIT = 40;

/**
 * Reader for a linked text document: rendered Markdown, plain text, or the blog
 * markup laid out like the SmartEditor post. Nothing in the file runs: Markdown
 * goes through react-markdown without raw HTML, and the blog view is the
 * escaped `renderHtml` output (the blog editor's own renderer) inside a shadow
 * root, so its styles stay isolated and markup assigned via innerHTML never runs.
 */
export function DocumentViewer({
  item,
  doc,
  projectId,
  bridge,
}: {
  item: ContentMediaItem;
  doc: ContentDocumentText;
  projectId: string;
  bridge: DashboardBridge;
}) {
  const modes = documentViewModes(item.path);
  const [mode, setMode] = useState<DocumentViewMode>(() =>
    defaultDocumentView(item.path, doc.text),
  );
  return (
    <div className="board-document">
      {modes.length > 1 && (
        <div
          className="board-document-modes"
          role="group"
          aria-label="문서 보기 방식"
        >
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              className="small"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {documentViewLabels[m]}
            </button>
          ))}
        </div>
      )}
      {!doc.text.trim() ? (
        <p className="board-document-empty">내용이 비어 있어요.</p>
      ) : mode === "blog" ? (
        <BlogView
          item={item}
          text={doc.text}
          projectId={projectId}
          bridge={bridge}
        />
      ) : mode === "markdown" ? (
        <MarkdownDocument item={item} text={doc.text} />
      ) : (
        <pre
          className="board-document-text"
          tabIndex={0}
          aria-label={`${item.label} 본문`}
        >
          {doc.text}
        </pre>
      )}
    </div>
  );
}

function MarkdownDocument({
  item,
  text,
}: {
  item: ContentMediaItem;
  text: string;
}) {
  const { frontmatter, body } = splitFrontmatter(text);
  return (
    <article
      className="board-document-markdown"
      tabIndex={0}
      aria-label={`${item.label} 본문`}
    >
      {frontmatter && (
        <details className="board-document-frontmatter">
          <summary>문서 속성</summary>
          <pre>{frontmatter}</pre>
        </details>
      )}
      <MarkdownView>{body}</MarkdownView>
    </article>
  );
}

function BlogView({
  item,
  text,
  projectId,
  bridge,
}: {
  item: ContentMediaItem;
  text: string;
  projectId: string;
  bridge: DashboardBridge;
}) {
  const markup = isBlogMarkup(text);
  const parsed = useMemo((): { doc?: MarkupDoc; error?: string } => {
    if (!markup) return {};
    try {
      return { doc: parse(text) };
    } catch (e) {
      return { error: errorMessage(e) };
    }
  }, [markup, text]);
  const [photos, setPhotos] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!parsed.doc) return;
    let live = true;
    const media = String(parsed.doc.metadata?.media ?? "");
    const names = new Set<string>();
    for (const bundle of parsed.doc.bundles)
      for (const node of bundle.nodes)
        if (node.kind === "component") {
          if (node.tag === "Photo") names.add(String(node.attrs.file ?? ""));
          if (node.tag === "Collage")
            for (const f of String(node.attrs.files ?? "").split(" · "))
              names.add(f);
          if (node.tag === "Video" && node.attrs.poster)
            names.add(String(node.attrs.poster));
        }
    for (const name of [...names].filter(Boolean).slice(0, BLOG_PHOTO_LIMIT)) {
      const file = blogAssetPath(item.path, media, name);
      if (!file) continue;
      void bridge
        .contentMedia!.thumbnail(projectId, file)
        .then((url) => {
          if (live) setPhotos((p) => ({ ...p, [name]: url }));
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
  }, [parsed.doc, item.path, projectId, bridge]);
  const html = useMemo(() => {
    let article: string;
    if (parsed.doc) {
      const doc = parsed.doc;
      const title = String(doc.metadata?.title ?? "");
      const hasTitle = doc.bundles.some((b) =>
        b.nodes.some((n) => n.kind === "component" && n.tag === "Title"),
      );
      article =
        (title && !hasTitle ?`<header><h1>${escapeText(title)}</h1></header>` : "") +
        renderHtml(doc, {
          // Only photos the app could resolve inside the linked folders load;
          // every other asset, and every video, stays a placeholder.
          assetUrl: (file, kind) =>
            (kind === "photo" && photos[file]) || "",
        });
    } else return "";
    return blogShadow(article);
  }, [parsed.doc, photos]);
  return (
    <div className="board-document-blog">
      {parsed.error && (
        <p className="board-document-notice" role="status">
          블로그 마크업을 해석하지 못해 Markdown으로 보여드려요. {parsed.error}
        </p>
      )}
      {parsed.doc ? (
        <BlogShadow html={html} label={`${item.label} 블로그 미리보기`} />
      ) : (
        <article
          className="board-document-se"
          tabIndex={0}
          aria-label={`${item.label} 블로그 미리보기`}
        >
          <MarkdownView>{splitFrontmatter(text).body}</MarkdownView>
        </article>
      )}
    </div>
  );
}

const escapeText = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function BlogShadow({ html, label }: { html: string; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    (el.shadowRoot ?? el.attachShadow({ mode: "open" })).innerHTML = html;
  }, [html]);
  return (
    <div
      ref={host}
      className="board-document-post"
      role="document"
      tabIndex={0}
      aria-label={label}
    />
  );
}

/**
 * A neutral SmartEditor-like column: the post's own layout shell and webfonts live
 * with the content, so this only approximates width, spacing and the Naver fonts
 * (the `se-*` families are mapped to local fonts in content-board.css).
 */
function blogShadow(article: string): string {
  return `<style>
:host{display:block;background:#fff;color:#333;color-scheme:light;font-family:se-nanumgothic,"Apple SD Gothic Neo",sans-serif;-webkit-font-smoothing:antialiased;text-align:left}
main{max-width:693px;margin:0 auto;padding:36px 20px 72px}
header h1{margin:0 0 28px;padding-bottom:20px;border-bottom:1px solid #eee;font-size:28px;line-height:1.4;font-weight:400;text-align:left}
article p{margin:0;min-height:1.8em}
article figure{margin:30px 0}
article img{display:block;max-width:100%;height:auto;margin:0 auto;background:#f2f2f2}
article img:not([src]),article img[src=""]{width:100%;aspect-ratio:4/3}
article .photo-grid4{display:grid;grid-template-columns:1fr 1fr;gap:8px}
article .photo-grid4 img{width:100%;height:100%;object-fit:cover}
article .section-heading{margin:40px 0 20px;padding:0;border:0}
article .section-heading h2{margin:0}
article .price-box,article .visit-card,article .native-card{margin:24px 0;padding:16px 18px;border:1px solid #e5e5e5;border-radius:4px;background:#fafafa;text-align:left}
article .card-label{margin-bottom:6px;font-weight:700}
article .source,article .tags{font-size:13px;color:#888}
article .scene-divider{width:60px;margin:40px auto;border:0;border-top:1px solid #ccc}
article .native-card small{display:block;color:#999;font-size:12px}
article a{color:#0068c3}
</style>${MARKUP_STYLE_CSS}<main>${article}</main>`;
}
