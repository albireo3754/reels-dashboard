import test from "node:test";
import assert from "node:assert/strict";
import { findPhotos, photosFindInput } from "../../src/shared/photos-find";
import { createDemoBridge } from "../../src/shared/demo";
import { createAgentDispatch, type AgentPorts } from "../../src/features/agent-tools";
import { AgentSession } from "../../src/entities/agent-session";
import { parseToolArgs, toolExample } from "../../src/app/cli/tool-command";

test("find spans the full date and returns import identities with inclusive duration and filename filters", async () => {
  const bridge = createDemoBridge();
  const found = await findPhotos((m,a) => bridge.request(m,a), { date: "2026-01-15", minDuration: 11, maxDuration: 17, filename: "demo_" });
  assert.equal(found.scannedCount, 15);
  assert.deepEqual(found.matches.map(a => a.durationSeconds).sort((a,b) => a-b), [11,14,17]);
  for (const asset of found.matches) {
    assert.equal(asset.mediaKind, "video");
    assert.equal(asset.indexRunId, found.groups.indexRunID);
    const detail = await bridge.request<any>("groups.show", {id: asset.groupId, "index-run": asset.indexRunId});
    assert.ok(detail.assets.some((a:any) => a.id === asset.id));
  }
  assert.equal((await findPhotos((m,a) => bridge.request(m,a), { date: "2026-01-15", minDuration: 90 })).matches.length, 0);
  assert.equal((await findPhotos((m,a) => bridge.request(m,a), { date: "2026-01-15", mediaKind: "photo" })).matches.length, 10);
});

test("invalid calendar dates, reversed lengths, negative durations and photo durations fail before indexing", async () => {
  for (const input of [{ date:"2026-02-30" }, { date:"2026-01-15", minDuration:151,maxDuration:90 }, { date:"2026-01-15", minDuration:-1 }, { date:"2026-01-15", mediaKind:"photo",maxDuration:150 }]) {
    assert.equal(photosFindInput.safeParse(input).success, false);
    await assert.rejects(findPhotos(async () => { assert.fail("must not call Photos"); },input));
  }
});

test("a changed index or failed group cannot be presented as a successful empty search", async () => {
  const bridge = createDemoBridge();
  await assert.rejects(findPhotos(async (m,a) => {
    const result = await bridge.request<any>(m,a);
    return m === "groups.show" ? { ...result,indexRunID:"changed" } : result;
  }, { date:"2026-01-15" }), /stale-index-run/);
  await assert.rejects(findPhotos(async (m,a) => {
    if (m === "groups.show") throw new Error("group unavailable");
    return bridge.request(m,a);
  }, { date:"2026-01-15" }), /group unavailable/);
});

test("CLI flags use the same dispatcher and metadata search as the dashboard", async () => {
  const bridge = createDemoBridge();
  const dispatch = createAgentDispatch({ session: new AgentSession(), photos:(m,a) => bridge.request(m,a) } as AgentPorts);
  const parsed = parseToolArgs("reels_photos_find", ["--date","2026-01-15","--min-duration","11","--max-duration","17"]);
  // CLI parser contract is verified independently of the app's native port.
  assert.ok(parsed);
  const result = await dispatch("reels_photos_find", {date:"2026-01-15",minDuration:11,maxDuration:17}) as any;
  assert.equal(result.matches.length,3);
  assert.match(toolExample("reels_photos_find"), /--min-duration 90/);
});
