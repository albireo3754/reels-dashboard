import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const origin = new URL(process.argv[2] ?? "http://127.0.0.1:5227").origin;
assert.ok(["127.0.0.1", "localhost"].includes(new URL(origin).hostname));
const key = process.env.BRIEFING_QA_KEY ?? /^BRIDGE_SECRET=(.*)$/m.exec(await readFile(".dev.vars", "utf8"))?.[1]?.replace(/^["']|["']$/g, "");
assert.ok(key);
const headers = { "x-reels-bridge-key": key, "content-type": "application/json" };
const at = "2026-01-01T04:30:00.000Z";
const content = { id: "content:example", title: "촬영 카드", date: "2026-01-01", dateBasis: "capture", stage: "review", nextAction: "촬영분 확인", publicURL: "" };
const week = { from: "2026-01-01", to: "2026-01-08", totals: { target: 0, done: 0, remaining: 0 }, channels: [] };
const monitor = { generatedAt: at, thisWeek: week, nextWeek: week, queue: { until: week.to, channels: [] }, autopilot: { enabled: false, paused: false, notice: null, status: "", today: null } };
const refs = [1,2,3].map(n => ({ account: "@example" + n, url: "https://www.instagram.com/reel/Example" + n + "/", metric: "조회 100 · 평소 30", hook: "첫 장면에서 보이는 풍경", ourVersion: "물결이 다가오는 장면으로 시작해요." }));
const unit = { id: "U01", title: "해변 산책", rank: 1, status: "draft", footage: { summary: "바닷가의 아침 풍경", score: 4.3, scenes: [{ id: "D1-02", day: 1, time: "09:30", title: "아침 산책" }] }, refs };
const board = { title: "여행 소스 보드", basis: "촬영 점수와 레퍼런스 반응순", updatedAt: at, units: [unit, { ...unit, id: "U02", title: "언덕길", rank: 2, status: "none", refs: [] }] };
async function put(value, status = 200) {
  const snapshot = { sourceId: "primary-mac", sourceLabel: "로컬 검증", sourceRevision: crypto.randomUUID(), sourceUpdatedAt: at, contents: [content], assets: [],
    monitor: { ...monitor, ...(value ? { sourceBoards: [{ projectId: content.id, board: value }] } : {}) } };
  const response = await fetch(origin + "/api/bridge/snapshot", { method: "PUT", headers, body: JSON.stringify(snapshot) });
  assert.equal(response.status, status, await response.text());
}
async function read() { return (await (await fetch(origin + "/api/briefing", { headers })).json()).monitor.sourceBoards; }
await put(board);
for (const bad of [
  { ...board, basis: "IMG_1234.MOV" },
  { ...board, units: [{ ...unit, refs: [...refs, refs[0]] }] },
  { ...board, units: [{ ...unit, refs: [{ ...refs[0], url: "https://example.invalid/p/test/" }] }] },
  { ...board, units: [{ ...unit, footage: { ...unit.footage, path: "private" } }] },
]) await put(bad, 400);
assert.deepEqual(await read(), [{ projectId: content.id, board }]);

const browser = await chromium.launch({ headless: true });
try {
  await mkdir("artifacts/source-board", { recursive: true });
  for (const width of [390, 1280]) {
    const page = await browser.newPage({ serviceWorkers: "block", viewport: { width, height: 844 } });
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route(origin + "/**", route => route.continue({ headers: { ...route.request().headers(), "oai-authenticated-user-id": "local-qa", "oai-authenticated-user-email": "qa@example.invalid" } }));
    await page.goto(origin);
    await page.getByRole("button", { name: /여행 소스 보드/ }).click();
    const panel = page.getByRole("dialog").getByRole("region", { name: "소스 보드" });
    const summaries = panel.locator("summary");
    assert.deepEqual(await summaries.locator(".board-rank").allTextContents(), ["1", "2"]);
    await summaries.first().focus();
    await page.keyboard.press("Enter");
    await panel.getByRole("list", { name: "촬영 상황" }).getByText(/D1-02 · 1일차/).waitFor();
    const links = panel.getByRole("link");
    assert.deepEqual(await links.evaluateAll(nodes => nodes.map(n => [n.href,n.target])), refs.map(r => [r.url,"_blank"]));
    assert.equal(await panel.getByText(refs[0].ourVersion, { exact: false }).count(), 3);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await panel.evaluate(el => el.scrollWidth <= el.clientWidth));
    await page.screenshot({ path: "artifacts/source-board/" + width + ".png" });
    await page.goto(origin + "/?content=" + encodeURIComponent(content.id));
    await panel.getByRole("heading", { name: board.title }).waitFor();
    assert.deepEqual(errors, []);
    await page.close();
  }
  await put(undefined);
  assert.equal(await read(), undefined);
  console.log("PASS: board D1 read/replace/delete, strict rejection, home and direct detail, keyboard disclosure, three Instagram links, 390/1280px.");
} finally { await browser.close(); }
