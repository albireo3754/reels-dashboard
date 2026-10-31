import { test } from "node:test";
import assert from "node:assert/strict";
import { developmentModeEnabled } from "../../src/desktop/development-mode";

test("development workspace requires an explicit exact environment opt-in", () => {
  assert.equal(developmentModeEnabled({ REELS_DEV_MODE: "1" }), true);
  for (const value of [undefined, "", "0", "true", "yes", " 1", "1 "]) {
    assert.equal(developmentModeEnabled({ REELS_DEV_MODE: value }), false);
  }
  assert.equal(
    developmentModeEnabled({ NODE_ENV: "development", REELS_DEMO: "1" }),
    false,
  );
});
