import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchApp, closeApp, makeProfile, cleanProfile } from "./helpers";

test("autopilot reads the private queue through IPC and shows one review without due dates", async ({}, info) => {
  test.setTimeout(90_000);
  const profile = await makeProfile();
  const now = new Date().toISOString();
  const issue = (n: number, title: string, state: string, stateName: string, priority = 3) => ({
    id: `fixture-${n}`, identifier: `QA-${n}`, title,
    url: `https://linear.app/example/issue/QA-${n}`,
    dueDate: null, state, stateName, priority,
  });
  const planning = {
    schemaVersion: 1, updatedAt: now, weeklyTarget: 3, calendar: null,
    linear: {
      url: "https://linear.app/example/team/QA", syncedAt: now,
      window: { from: "2020-01-01", to: "2099-01-01" },
      issues: [
        issue(1, "First review fixture", "triage", "Inbox", 1),
        issue(2, "Second review fixture", "unstarted", "Inbox"),
        issue(3, "Third review fixture", "backlog", "검토 대기"),
        issue(4, "Active fixture", "started", "In Progress"),
      ],
    },
  };
  const planningPath = path.join(profile, "planning.json");
  await writeFile(planningPath, JSON.stringify(planning), { mode: 0o600 });
  const app = await launchApp(profile, false);
  try {
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => Boolean(window.reels?.autopilot))).toBe(true);
    const overview = await page.evaluate(() => window.reels!.autopilot!.get());
    expect(overview.counts).toMatchObject({ review: 3, active: 1, occupancy: 3, autoSlots: 0 });
    expect(overview.today?.title).toBe("First review fixture");
    expect(overview.freshness.ok).toBe(true);
    const card = page.getByTestId("autopilot-today");
    await expect(card.getByRole("link", { name: /First review fixture/ })).toBeVisible();
    await expect(card.getByRole("heading", { level: 4 })).toHaveCount(1);
    await expect(page.getByText("Second review fixture", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Third review fixture", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("autopilot-desktop.png") });

    planning.linear.syncedAt = "2000-01-01T00:00:00.000Z";
    await writeFile(planningPath, JSON.stringify(planning), { mode: 0o600 });
    await page.reload();
    const stale = await page.evaluate(() => window.reels!.autopilot!.get());
    expect(stale.freshness.ok).toBe(false);
    await expect(card.getByRole("link", { name: /First review fixture/ })).toBeVisible();
    await expect(card.getByTestId("autopilot-blocked")).toContainText("오래됐어요");
    await page.screenshot({ path: info.outputPath("autopilot-stale-desktop.png") });

    // The getter and dashboard card must never rewrite a provider snapshot or start production.
    expect(JSON.parse(await readFile(planningPath, "utf8"))).toEqual(planning);
    const persisted = await readFile(path.join(profile, "autopilot/state.json"), "utf8")
      .then((value) => JSON.parse(value), () => null);
    expect(persisted?.reservations ?? []).toHaveLength(0);
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});
