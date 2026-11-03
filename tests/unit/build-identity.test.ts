import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_NAME, appDisplayName } from "../../src/desktop/build-identity";

test("source builds are labelled Dev, packaged builds keep the product name", () => {
  assert.equal(appDisplayName(true), APP_NAME);
  assert.equal(appDisplayName(false), "Reels Dashboard Dev");
});
