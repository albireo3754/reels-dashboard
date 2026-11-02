import path from "node:path";
import ts from "typescript";
import type { Plugin } from "vite";

/** Add only repository-relative locations to intrinsic JSX elements. */
export function annotateJsxSource(code: string, filename: string): string {
  if (
    !/^src\/[\w./-]+\.tsx$/.test(filename) ||
    filename.split("/").includes("..")
  )
    return code;
  const source = ts.createSourceFile(
    filename,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const inserts: { at: number; value: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if (
        /^[a-z][\w-]*$/.test(tag) &&
        !node.attributes.properties.some(
          (attribute) =>
            ts.isJsxAttribute(attribute) &&
            attribute.name.getText(source) === "data-reels-source",
        )
      ) {
        const { line, character } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        inserts.push({
          at: node.tagName.end,
          value: ` data-reels-source={${JSON.stringify(`${filename}:${line + 1}:${character + 1}`)}}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const insertion of inserts.sort((a, b) => b.at - a.at)) {
    code =
      code.slice(0, insertion.at) + insertion.value + code.slice(insertion.at);
  }
  return code;
}

export function jsxSource(): Plugin {
  let root = "";
  return {
    name: "reels-jsx-source",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
    },
    transform(code, id) {
      if (!id.endsWith(".tsx")) return;
      const filename = path.relative(root, id).split(path.sep).join("/");
      const transformed = annotateJsxSource(code, filename);
      if (transformed !== code) return { code: transformed, map: null };
    },
  };
}
