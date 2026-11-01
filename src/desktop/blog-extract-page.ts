// Page-side scripts for the Naver reference extractor. Each function is serialized with
// toString() and executed in an isolated, sandboxed BrowserWindow (or Playwright page), so it must
// be self-contained: no imports, no closures over module scope.
/* eslint-disable */
// @ts-nocheck -- runs in the target page's DOM, not in this module's type environment.

/** Read-only extraction of `.se-main-container`. See docs/blog-workspace.md for the data contract. */
export const extractPost = (root: any, opts: any) => {
  if (typeof root === 'string') root = document.querySelector(root); // selector form for executeJavaScript
  if (!root) throw new Error('.se-main-container not found');
  opts = opts || {};
  const doc = root.ownerDocument, win = doc.defaultView;
  const TREE_PROPS = ['display','position','box-sizing','width','height','min-width','max-width','min-height','max-height','margin-top','margin-right','margin-bottom','margin-left','padding-top','padding-right','padding-bottom','padding-left','border-top','border-right','border-bottom','border-left','border-radius','box-shadow','background-color','color','font-family','font-size','font-weight','font-style','line-height','letter-spacing','word-spacing','text-align','text-indent','text-decoration','white-space','word-break','overflow-wrap','vertical-align','opacity','overflow','object-fit','object-position','gap','flex-direction','flex-wrap','align-items','justify-content','grid-template-columns','top','right','bottom','left'];
  const STRUCT_PROPS = ['font-family','font-size','font-weight','font-style','font-stretch','line-height','letter-spacing','word-spacing','color','background-color','text-decoration','text-align','text-indent','white-space','word-break','overflow-wrap','vertical-align','display','width','height','max-width','margin-top','margin-right','margin-bottom','margin-left','padding-top','padding-right','padding-bottom','padding-left','border-top','border-right','border-bottom','border-left','border-radius','box-shadow','opacity','object-fit','object-position','gap','grid-template-columns'];
  const SKIP = new Set(['script','style','noscript','template','link','meta']);
  // Zero-width chars (SmartEditor's empty-line U+200B) stay invisible; masking them would add visible text.
  const KEEP = /[\s\u200B-\u200D\u2060\uFEFF.,!?~…ㅋㅎ'"“”‘’()\[\]{}<>\-–—:;·^/*+=%#@&|]/;
  const INVISIBLE = /^[\s\u200B-\u200D\u2060\uFEFF]*$/;
  const css = (e, props, pseudo) => { const s = win.getComputedStyle(e, pseudo); return Object.fromEntries(props.map(k => [k, s.getPropertyValue(k)])); };
  const rect = e => { const r = e.getBoundingClientRect(); return {x: r.x, y: r.y, width: r.width, height: r.height}; };
  const mask = t => Array.from(t).map(c => KEEP.test(c) ? c : '가').join('');
  const punct = t => (t.match(/[.,!?~…ㅋㅎ]/g) || []).join('');
  const imgState = img => ({
    naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
    // Naver lazy images start as `?type=w80_blur`; that thumbnail is not the loaded photo.
    loaded: img.complete && img.naturalWidth > 0 && !/_blur\b|type=w80_blur/.test(img.currentSrc || img.src),
  });
  // Only Naver's image CDN; anything else (data:, tracking pixels, other hosts) is dropped.
  const source = img => {
    try { const u = new URL(img.currentSrc || img.src); return u.protocol === 'https:' && /(^|\.)pstatic\.net$/.test(u.hostname) && !/_blur\b|type=w80_blur/.test(u.search) ? {src: u.href} : {}; } catch { return {}; }
  };
  const original = img => {
    try {
      const raw = img.closest('[data-linkdata]')?.getAttribute('data-linkdata');
      const v = raw ? JSON.parse(raw) : null;
      const w = Number(v?.originalWidth), h = Number(v?.originalHeight);
      return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? {originalWidth: w, originalHeight: h} : {};
    } catch { return {}; }
  };

  let bi = 0, nc = 0, tc = 0, ic = 0;
  const walk = node => {
    if (node.nodeType === 3) {
      const t = node.textContent;
      if (!t) return null;
      const blank = INVISIBLE.test(t);
      return {type: 'text-slot', id: `b${bi}-text-${tc++}`, characters: t.length, blank, sample: blank ? t : mask(t), ...(blank ? {} : {text: t})};
    }
    if (node.nodeType !== 1) return null;
    const tag = node.tagName.toLowerCase();
    if (SKIP.has(tag)) return null;
    if (tag === 'img') return {type: 'image-slot', id: `b${bi}-image-${ic++}`, css: css(node, TREE_PROPS), ...imgState(node), ...original(node), ...source(node)};
    const out = {type: 'element', tag, className: node.getAttribute('class') || '', id: `b${bi}-node-${nc++}`, css: css(node, TREE_PROPS)};
    if (tag === 'a' && node.hasAttribute('href')) out.link = true; // href itself is not recorded
    const pseudo = [];
    for (const p of ['::before', '::after']) {
      const content = win.getComputedStyle(node, p).getPropertyValue('content');
      if (content && content !== 'none' && content !== 'normal') pseudo.push({type: p, content: /^["']/.test(content) ? content.replace(/^(["'])([\s\S]*)\1$/, (_, q, body) => q + mask(body) + q) : content, css: css(node, TREE_PROPS, p)});
    }
    if (pseudo.length) out.pseudo = pseudo;
    if (tag === 'iframe' || tag === 'svg' || tag === 'video') { out.embed = tag; return out; }
    out.children = Array.from(node.childNodes).map(walk).filter(Boolean);
    return out;
  };

  const runs = p => {
    const out = [], walker = doc.createTreeWalker(p, 4);
    let n;
    while ((n = walker.nextNode())) { if (INVISIBLE.test(n.textContent)) continue; out.push({characters: n.textContent.length, text: n.textContent, punctuation: punct(n.textContent), css: css(n.parentElement, STRUCT_PROPS)}); }
    return out;
  };

  const children = Array.from(root.children);
  const templateBlocks = [], structureBlocks = [];
  children.forEach((b, i) => {
    bi = i; nc = 0; tc = 0; ic = 0;
    const anchorId = b.id || b.querySelector('[id]')?.id || null;
    templateBlocks.push({id: `block-${i}`, order: i, sourceAnchor: anchorId, sourceClass: b.getAttribute('class') || '', rect: rect(b), tree: walk(b)});
    structureBlocks.push({
      order: i, id: b.id || '', anchorId, className: b.getAttribute('class') || '', rect: rect(b), css: css(b, STRUCT_PROPS),
      paragraphs: Array.from(b.querySelectorAll('.se-text-paragraph')).map(p => ({id: p.id || undefined, characters: p.textContent.length, rect: rect(p), css: css(p, STRUCT_PROPS), runs: runs(p)})),
      images: Array.from(b.querySelectorAll('img')).map(n => ({rect: rect(n), ...imgState(n), css: css(n, STRUCT_PROPS)})),
    });
  });

  const titleEl = doc.querySelector('.se-documentTitle .se-title-text, .se-title-text');
  const title = titleEl ? {characters: titleEl.textContent.trim().length, text: titleEl.textContent.trim(), sample: mask(titleEl.textContent.trim()), css: css(titleEl, STRUCT_PROPS)} : null;
  const stylesheets = Array.from(doc.styleSheets).map((s: any) => s.href).filter((h: any) => typeof h === 'string' && /^https:\/\/[\w.-]*pstatic\.net\//.test(h));
  const fontsLoaded = Array.from((doc as any).fonts || []).filter((f: any) => f.status === 'loaded').map(f => ({family: f.family.replace(/^["']|["']$/g, ''), weight: f.weight, style: f.style}));
  const width = root.getBoundingClientRect().width;
  const name = opts.name || doc.title, url = opts.url || doc.URL;
  return {
    capturedAt: new Date().toISOString(),
    viewport: {width: win.innerWidth, height: win.innerHeight},
    title, fontsLoaded, stylesheets,
    template: {schemaVersion: 1, id: opts.id || 'reference', name, sourceUrl: doc.URL, referenceWidth: width, note: '실측 중첩트리/서식. text-slot.text=원문, sample=마스킹. image-slot.src=원본 CDN URL(파일 미저장).', blocks: templateBlocks},
    structure: {name, url, pageUrl: doc.URL, width, capturedAt: new Date().toISOString(), viewport: {width: win.innerWidth, height: win.innerHeight}, blocks: structureBlocks},
  };
};

/** Scrolls the post and nudges every lazy image until loaded; returns how many remain unloaded. */
export const loadImages = async (pass) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  if (pass === 0) {
    for (let y = 0; y < document.documentElement.scrollHeight; y += Math.round(innerHeight * 0.7)) {
      scrollTo(0, y);
      await sleep(250);
    }
  }
  const bad = [...document.querySelectorAll('.se-main-container img')].filter((i) => !(i.complete && i.naturalWidth > 0 && !/_blur\b|type=w80_blur/.test(i.currentSrc || i.src)));
  for (const i of bad) {
    i.scrollIntoView({ block: 'center' });
    await sleep(500);
  }
  return bad.length;
};

/** Measures each restored block in the restore viewer. */
export const measureRestore = async () => {
  await document.fonts.ready;
  await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
  const images = [...document.querySelectorAll('[data-restore-surface] img')];
  return {
    blocks: [...document.querySelectorAll('[data-restore-block]')].map((e) => ({ height: e.getBoundingClientRect().height, characters: e.textContent.length })),
    images: { total: images.length, loaded: images.filter((i) => i.complete && i.naturalWidth > 0).length },
    fonts: [...new Set([...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family))],
  };
};

/** Builds a script string; the `__name` shim covers bundlers that keep function names. */
export function pageScript(fn: (...args: any[]) => unknown, ...args: unknown[]) {
  return `(() => { var __name = globalThis.__name || ((f) => f); return (${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(",")}); })()`;
}
