import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readMobileBriefingStatus } from "../../src/desktop/mobile-briefing";

test("briefing status expires while retaining last server save; credentials never cross IPC", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "briefing-status-"));
  try {
    assert.equal(
      (await readMobileBriefingStatus(root)).state,
      "not-configured",
    );
    await mkdir(path.join(root, "mobile-bridge"));
    const now = Date.now();
    const data = {
      siteUrl: "https://example.chatgpt.site",
      connected: true,
      checkedAt: new Date(now).toISOString(),
      syncedAt: "2026-10-28T00:00:00.000Z",
      contentCount: 2,
      assetCount: 3,
      token: "must-not-leave-main",
    };
    const file = path.join(root, "mobile-bridge/status.json");
    await writeFile(file, JSON.stringify(data));
    const current = await readMobileBriefingStatus(root, now);
    assert.equal(current.state, "connected");
    assert.equal("token" in current, false);
    const stale = await readMobileBriefingStatus(root, now + 45000);
    assert.equal(stale.state, "offline");
    assert.equal(stale.syncedAt, data.syncedAt);
    await writeFile(file, JSON.stringify({ ...data, connected: false }));
    assert.equal((await readMobileBriefingStatus(root, now)).state, "offline");
    for (const siteUrl of [
      "file:///etc/passwd",
      "https://example.org",
      "https://user:pass@example.chatgpt.site",
      "https://example.chatgpt.site/?token=secret",
    ]) {
      await writeFile(file, JSON.stringify({ ...data, siteUrl }));
      assert.equal((await readMobileBriefingStatus(root, now)).siteUrl, null);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
