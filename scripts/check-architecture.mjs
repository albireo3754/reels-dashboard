import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve("src");
const rank = { app: 3, desktop: 3, renderer: 3, features: 2, entities: 1, shared: 0 };
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e =>
  e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []);
const failures = [];
for (const file of files(root)) {
  const from = path.relative(root, file).split(path.sep);
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const check = (specifier) => {
    if (!specifier.startsWith(".")) return;
    const target = path.resolve(path.dirname(file), specifier);
    const to = path.relative(root, target).split(path.sep);
    if (!(to[0] in rank)) return;
    const sameSlice = from[0] === to[0] && from[1] === to[1];
    if (rank[from[0]] < rank[to[0]] ||
        (from[0] === to[0] && ["features", "entities"].includes(from[0]) && !sameSlice))
      failures.push(`${path.relative(root, file)}: forbidden dependency ${specifier}`);
    if (["features", "entities"].includes(to[0]) && !sameSlice && to.length > 2 && to[2] !== "index")
      failures.push(`${path.relative(root, file)}: bypasses public API ${specifier}`);
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require") && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) check(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
}
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log("FSD layer direction and feature/entity public APIs passed.");
