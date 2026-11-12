import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { launchApp, closeApp, makeProfile, cleanProfile } from "./helpers";

test("private calendar imports travel through MCP, preload and UI without sharing them", async ({}, info) => {
  test.setTimeout(90_000);
  const profile = await makeProfile();
  const app = await launchApp(profile, false);
  const page = await app.firstWindow();
  const client = new Client({ name: "calendar-qa", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("dist-mcp/server.mjs")], env: { ...(process.env as Record<string, string>), REELS_USER_DATA: profile } });
  const call = async (name: string, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent as any;
  };
  try {
    await expect.poll(() => access(path.join(profile, "agent/connection.json")).then(() => true, () => false)).toBe(true);
    await client.connect(transport);
    const state = await call("reels_get_planning");
    expect(state.calendar).toBeNull();
    const updated = await call("reels_sync_planning", { expectedUpdatedAt: state.updatedAt, weeklyTarget: 3, calendar: { url: "https://calendar.google.com/calendar/u/0/r/week", syncedAt: new Date().toISOString(), window: { from: "2026-01-01", to: "2027-01-01" }, events: [{ id: "fixture-event", title: "Private calendar fixture", url: "https://calendar.google.com/calendar/event?eid=fixture", start: "2026-11-20T15:56:00+09:00", projectId: "fixture-project", channel: "naver-clip", cancelled: false }] } });
    expect(await page.evaluate(() => window.reels!.planning!.get())).toEqual(updated);
    await page.getByRole("navigation", { name: "주요 메뉴" }).getByRole("button", { name: "캘린더", exact: true }).click();
    await expect(page.getByText(/에 가져옴/)).toBeVisible();
    await expect(page.getByRole("link", { name: "Google Calendar 열기 ↗" })).toHaveAttribute("href", "https://calendar.google.com/calendar/u/0/r/week");
    await expect(page.getByText("Linear 연결 대기 중이에요.").first()).toBeVisible();
    await page.screenshot({ path: info.outputPath("calendar-desktop.png") });
    const dashboard = await page.evaluate(() => window.reels!.loadDashboard());
    expect(JSON.stringify(dashboard)).not.toContain("fixture-event");
    expect(JSON.parse(await readFile(path.join(profile, "planning.json"), "utf8")).calendar.events[0].id).toBe("fixture-event");
  } finally {
    await client.close();
    await closeApp(app);
    await cleanProfile(profile);
  }
});
