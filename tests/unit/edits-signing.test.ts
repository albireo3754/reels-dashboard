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

test("Edits signing shares CI-only ad-hoc mode while local and default CI require Developer ID", async () => {
  const { signingIdentity } = await import(
    new URL("../../scripts/build-edits-native.mjs", import.meta.url).href
  );
  let lookups = 0;
  const missing = () => { lookups++; return "0 valid identities found"; };
  assert.equal(signingIdentity({ CI: "true", PHOTOSINDEX_SIGNING_MODE: "ci-adhoc" }, missing), "-");
  assert.equal(lookups, 0, "certificate-free CI must not query the keychain");
  for (const CI of [undefined, "false", "1", "TRUE"])
    assert.throws(() => signingIdentity({ CI, PHOTOSINDEX_SIGNING_MODE: "ci-adhoc" }, missing), /CI=true/);
  assert.equal(lookups, 0);
  for (const env of [{}, { CI: "true" }, { PHOTOSINDEX_SIGNING_MODE: "developer-id" }])
    assert.throws(() => signingIdentity(env, missing), /found 0.*No ad-hoc/);
  assert.throws(() => signingIdentity({ CI: "true", PHOTOSINDEX_SIGNING_MODE: "adhoc" }, missing), /Unsupported/);
  const identity = "A".repeat(40);
  const identities = () => `1) ${identity} "Developer ID Application: Example (EXAMPLE)"`;
  assert.equal(signingIdentity({}, identities), identity);
  assert.equal(signingIdentity({ PHOTOSINDEX_SIGNING_IDENTITY: "Developer ID Application: Example (EXAMPLE)" }, identities), identity);
  assert.throws(() => signingIdentity({ EDITSAX_SIGNING_IDENTITY: "-" }, identities), /found 0/);
});
