/**
 * Line-end fragments: a markup line whose last on-screen row holds only one or two
 * characters (a lone `요.` or `다.`) at a given preview width. The browser measures the
 * characters (see LINE_END_COLLECTOR); this module groups them into rows and picks the
 * short tails, so the decision is testable without a browser.
 */
export interface LaidOutChar {
  ch: string;
  top: number;
  bottom: number;
  left: number;
}
/** One markup line (text between `<br>`s) of one body paragraph, as laid out. */
export interface LaidOutLine {
  bundle: string;
  /** 1-based body paragraph number within the bundle. */
  paragraph: number;
  /** 1-based markup line number within the paragraph. */
  line: number;
  chars: LaidOutChar[];
  /** The line's source text, including spaces the browser drops at a wrap. */
  text?: string;
}
export interface LineEndFragment {
  width: number;
  bundle: string;
  paragraph: number;
  line: number;
  text: string;
  /** The last on-screen row of that line, trimmed. */
  tail: string;
}

/** Split one laid-out line into on-screen rows: a char below the previous one or back to its left starts a row. */
export function rows(chars: LaidOutChar[]): string[] {
  const out: string[] = [];
  let prev: LaidOutChar | undefined;
  for (const c of chars) {
    if (!prev || c.top >= prev.bottom - 2 || c.left < prev.left - 1) out.push("");
    out[out.length - 1] += c.ch;
    prev = c;
  }
  return out;
}

export function lineEndFragments(
  lines: LaidOutLine[],
  width: number,
  maxChars = 2,
): LineEndFragment[] {
  const found: LineEndFragment[] = [];
  for (const l of lines) {
    const r = rows(l.chars);
    if (r.length < 2) continue;
    const tail = r[r.length - 1].trim();
    const visible = [...tail.replace(/\s+/g, "")].length;
    if (visible > 0 && visible <= maxChars)
      found.push({
        width,
        bundle: l.bundle,
        paragraph: l.paragraph,
        line: l.line,
        text: (l.text ?? l.chars.map((c) => c.ch).join("")).trim(),
        tail,
      });
  }
  return found;
}

/**
 * Browser-side collector, kept as source text so a bundler cannot inject helpers into it.
 * Evaluates to LaidOutLine[] for every `article p.paragraph` of the rendered preview.
 */
export const LINE_END_COLLECTOR = `(() => {
  const out = [];
  const seen = new Map();
  for (const p of document.querySelectorAll("article p.paragraph")) {
    const bundle = p.getAttribute("data-bundle") || "";
    const paragraph = (seen.get(bundle) || 0) + 1;
    seen.set(bundle, paragraph);
    let line = { bundle, paragraph, line: 1, chars: [], text: "" };
    const lines = [line];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeName === "BR") {
          line = { bundle, paragraph, line: line.line + 1, chars: [], text: "" };
          lines.push(line);
        } else if (child.nodeType === 3) {
          const text = child.data;
          line.text += text;
          for (let i = 0; i < text.length; ) {
            const cp = text.codePointAt(i);
            const size = cp > 0xffff ? 2 : 1;
            const range = document.createRange();
            range.setStart(child, i);
            range.setEnd(child, i + size);
            const rect = range.getClientRects()[0];
            if (rect && rect.width > 0)
              line.chars.push({ ch: text.slice(i, i + size), top: rect.top, bottom: rect.bottom, left: rect.left });
            i += size;
          }
        } else walk(child);
      }
    };
    walk(p);
    out.push(...lines.filter((l) => l.chars.length));
  }
  return out;
})()`;
