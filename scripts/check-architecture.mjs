import ts from "typescript";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve("src");
const site = path.resolve("apps/mobile-briefing");
const briefing = path.resolve("packages/briefing");
const inside = (dir, file) => file === dir || file.startsWith(dir + path.sep);
const testsRoot = path.resolve("tests");
const rank = {
  app: 3,
  desktop: 3,
  renderer: 3,
  features: 2,
  entities: 1,
  shared: 0,
};
const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === "node_modules"
        ? []
        : files(path.join(dir, e.name))
      : /\.(?:[mc]?ts|tsx|[mc]?js|jsx)$/.test(e.name)
        ? [path.join(dir, e.name)]
        : [],
  );
const failures = [];
const scan = (file, isTest) => {
  const from = path.relative(root, file).split(path.sep);
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const check = (specifier) => {
    const mobile = inside(site, file);
    const common = inside(briefing, file);
    let target;
    if (specifier.startsWith("."))
      target = path.resolve(path.dirname(file), specifier);
    else if (specifier.startsWith("@briefing/"))
      target = path.resolve(briefing, specifier.slice(10));
    else if (mobile && specifier.startsWith("@/"))
      target = path.resolve(site, specifier.slice(2));
    const fail = (reason) =>
      failures.push(
        `${path.relative(process.cwd(), file)}: ${reason} (${specifier})`,
      );

    if (common) {
      if (
        target
          ? !inside(briefing, target)
          : !["react", "zod"].includes(specifier)
      )
        fail("shared briefing code depends on an app or platform module");
      return;
    }
    if (!target) return;
    if (inside(briefing, target)) {
      if (!/^(model|ui)(\.ts)?$/.test(path.relative(briefing, target)))
        fail("use the briefing model or ui public API");
      return;
    }
    if (mobile) {
      if (!inside(site, target)) {
        fail("mobile code imports outside the app");
        return;
      }
      const [layer, slice] = path.relative(site, file).split(path.sep);
      const [other, otherSlice, ...rest] = path
        .relative(site, target)
        .split(path.sep);
      if (
        ["lib", "db", "hooks", "features"].includes(layer) &&
        ["app", "components", "worker"].includes(other)
      )
        fail("mobile model or feature depends on composition");
      if (other === "features" && (layer !== other || slice !== otherSlice)) {
        if (["lib", "db", "hooks", "features"].includes(layer))
          fail("mobile lower layer or peer imports a feature");
        else if (rest.length && !/^index(\.ts)?$/.test(rest.join("/")))
          fail("use the mobile feature public API");
      }
      return;
    }
    if (inside(site, target) && inside(root, file)) {
      fail("desktop code imports the mobile app");
      return;
    }
    const to = path.relative(root, target).split(path.sep);
    if (!(to[0] in rank)) return;
    if (isTest) {
      // Tests sit outside src, so the layer rank does not apply. They may use
      // a feature/entity slice only through its index or a model/** module.
      if (
        ["features", "entities"].includes(to[0]) &&
        to.length > 2 &&
        !(to.length === 3 && /^index(\.tsx?)?$/.test(to[2])) &&
        to[2] !== "model"
      )
        failures.push(
          `${path.relative(process.cwd(), file)}: test bypasses public API ${specifier}`,
        );
      return;
    }
    const sameSlice = from[0] === to[0] && from[1] === to[1];
    if (
      rank[from[0]] < rank[to[0]] ||
      (from[0] === to[0] &&
        ["features", "entities"].includes(from[0]) &&
        !sameSlice)
    )
      failures.push(
        `${path.relative(root, file)}: forbidden dependency ${specifier}`,
      );
    if (
      ["features", "entities"].includes(to[0]) &&
      !sameSlice &&
      to.length > 2 &&
      to[2] !== "index"
    )
      failures.push(
        `${path.relative(root, file)}: bypasses public API ${specifier}`,
      );
  };
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      check(node.moduleSpecifier.text);
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      check(node.argument.literal.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(source) === "require") &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      check(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(source);
};
for (const file of files(root)) scan(file, false);
for (const dir of [
  "app",
  "components",
  "db",
  "features",
  "hooks",
  "lib",
  "worker",
])
  for (const file of files(path.join(site, dir))) scan(file, false);
for (const file of files(briefing)) scan(file, false);
const testFiles = files(testsRoot);
for (const file of testFiles) scan(file, true);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(
  "Desktop and mobile FSD boundaries and shared briefing entry points passed.",
);
console.log(
  `Tests use feature/entity slices only through index or model/** (${testFiles.length} test files scanned).`,
);
