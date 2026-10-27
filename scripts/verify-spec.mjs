import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
const inventory = JSON.parse(
  readFileSync("docs/photosindex-test-inventory.json", "utf8"),
);
let count = 0;
for (const item of inventory.files) {
  const bytes = readFileSync(item.sourcePath);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    item.sha256,
    `${item.sourcePath} changed from specified baseline`,
  );
  const methods = bytes.toString("utf8").match(/func\s+test\w+\s*\(/g) || [];
  assert.equal(methods.length, item.testCount);
  count += methods.length;
}
assert.equal(inventory.files.length, 26);
assert.equal(count, 75);
assert.equal(count, inventory.testCount);
console.log(
  `Specification preservation passed: ${inventory.files.length} original test files and ${count} original methods byte-identical.`,
);
