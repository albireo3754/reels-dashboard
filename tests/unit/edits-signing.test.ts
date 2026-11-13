import test from "node:test";
import assert from "node:assert/strict";

test("Edits helper signing requires one stable Developer ID and no ad-hoc selection", async () => {
  const { developerIdentity } = await import(
    new URL("../../scripts/build-edits-native.mjs", import.meta.url).href
  );
  const a = "A".repeat(40),
    b = "B".repeat(40);
  const one = `1) ${a} "Developer ID Application: Example (EXAMPLE)"`;
  assert.equal(developerIdentity(one), a);
  assert.equal(developerIdentity(`${one}\n${one}`), a);
  assert.throws(
    () => developerIdentity("0 valid identities found"),
    /No ad-hoc/,
  );
  assert.throws(
    () =>
      developerIdentity(
        `${one}\n2) ${b} "Developer ID Application: Another (ANOTHER)"`,
      ),
    /found 2/,
  );
  assert.equal(
    developerIdentity(
      `${one}\n2) ${b} "Developer ID Application: Another (ANOTHER)"`,
      "Developer ID Application: Another (ANOTHER)",
    ),
    b,
  );
  assert.throws(() => developerIdentity(one, "-"), /found 0/);
});
