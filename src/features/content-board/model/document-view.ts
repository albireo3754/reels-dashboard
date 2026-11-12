/** How a linked text document is shown in the media explorer. */
export type DocumentViewMode = "blog" | "markdown" | "text";

export const documentViewLabels: Record<DocumentViewMode, string> = {
  blog: "블로그",
  markdown: "Markdown",
  text: "텍스트",
};

const extension = (file: string) =>
  file.split("/").at(-1)?.split(".").at(-1)?.toLowerCase() ?? "";

/** Blog markup v1 opens with `markup: 1` frontmatter or has `<Bundle …>` lines. */
export function isBlogMarkup(text: string): boolean {
  const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (header && /^markup:\s*1\s*$/m.test(header[1])) return true;
  return /^<Bundle(?:\s[^\n]*)?>\s*$/m.test(text);
}

/**
 * Markdown files get all three views; every other text format stays plain text
 * (HTML is shown as source and never rendered). Blog markup opens in the blog view.
 */
export function documentViewModes(file: string): DocumentViewMode[] {
  return extension(file) === "md" ? ["blog", "markdown", "text"] : ["text"];
}

export function defaultDocumentView(
  file: string,
  text: string,
): DocumentViewMode {
  if (extension(file) !== "md") return "text";
  return isBlogMarkup(text) ? "blog" : "markdown";
}

/** Splits YAML frontmatter from a Markdown body so it is not rendered as a heading. */
export function splitFrontmatter(text: string): {
  frontmatter: string;
  body: string;
} {
  const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return header
    ? { frontmatter: header[1], body: text.slice(header[0].length) }
    : { frontmatter: "", body: text };
}

/** Resolves a blog asset name against the document folder and an optional `media` folder. */
export function blogAssetPath(
  documentPath: string,
  media: string,
  file: string,
): string | undefined {
  if (!file || /^[a-z][\w+.-]*:/i.test(file) || file.startsWith("//"))
    return undefined;
  const folder = documentPath.split("/").slice(0, -1).join("/");
  const joined = file.startsWith("/")
    ? file
    : media.startsWith("/")
      ? `${media}/${file}`
      : `${folder}/${media ? `${media}/` : ""}${file}`;
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return "/" + parts.join("/");
}
