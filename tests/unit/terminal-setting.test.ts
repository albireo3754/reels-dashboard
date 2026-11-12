import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  TerminalSettingStore,
  resolveTerminalSetting,
} from "../../src/desktop/terminal-setting";

test("terminal toggle defaults off and persists only an explicit boolean", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "terminal-setting-"));
  try {
    const store = new TerminalSettingStore(root);
    assert.equal(await store.get(), false);
    assert.equal(await store.set(true), true);
    assert.equal(await store.get(), true);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(root, "terminal-settings.json"), "utf8")),
      { enabled: true },
    );
    await assert.rejects(store.set("true"));
    assert.equal(await store.get(), true);
    await store.set(false);
    assert.equal(await store.get(), false);
    for (const raw of ["{", '{"enabled":"true"}', "null"]) {
      await writeFile(path.join(root, "terminal-settings.json"), raw);
      assert.equal(await store.get(), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("REELS_DEV_MODE=1 is reported as forcing the terminal on", () => {
  assert.deepEqual(resolveTerminalSetting({ REELS_DEV_MODE: "1" }, false, true), {
    enabled: false,
    forcedByEnvironment: true,
    active: true,
  });
  assert.deepEqual(resolveTerminalSetting({}, true, false), {
    enabled: true,
    forcedByEnvironment: false,
    active: false,
  });
});
