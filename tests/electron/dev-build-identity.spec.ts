import { expect, test } from "@playwright/test";
import { cleanProfile, closeApp, launchApp, makeProfile } from "./helpers";

test("an unpackaged build is labelled Dev without moving its app data", async () => {
  const profile = await makeProfile();
  const app = await launchApp(profile, true);
  try {
    const page = await app.firstWindow();
    const info = await app.evaluate(({ app, BrowserWindow }) => ({
      packaged: app.isPackaged,
      name: app.getName(),
      userData: app.getPath("userData"),
      title: BrowserWindow.getAllWindows()[0]!.getTitle(),
    }));
    test.skip(info.packaged, "Packaged executables keep the plain product name.");
    expect(info.name).toBe("Reels Dashboard Dev");
    // REELS_USER_DATA (the QA profile) still wins over the renamed app.
    expect(info.userData).toBe(profile);
    const badge = page.locator(".dev-build-badge");
    await expect(badge).toHaveText("DEV");
    await expect(page).toHaveTitle(/ Dev$/);
    expect(info.title).toMatch(/Reels Dashboard/);
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});
