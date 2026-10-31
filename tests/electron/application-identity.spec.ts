import { expect, test } from "@playwright/test";
import { cleanProfile, closeApp, launchApp, makeProfile } from "./helpers";

test("bundled brand assets load at both tray scales and activation restores the window", async () => {
  test.skip(process.env.REELS_ELECTRON_HEADED !== "1", "Window activation requires explicit headed QA.");
  const profile = await makeProfile();
  const instance = await launchApp(profile);
  try {
    await instance.firstWindow();
    const assets = await instance.evaluate(({ app, nativeImage }) => {
      const root = `${app.getAppPath()}/resources/branding`;
      const tray = nativeImage.createFromPath(`${root}/trayTemplate.png`);
      const icon = nativeImage.createFromPath(`${root}/app.png`);
      return {
        name: app.getName(),
        icon: icon.getSize(),
        tray: tray.getSize(),
        scales: tray.getScaleFactors(),
      };
    });
    expect(assets.name).toBe("Reels Dashboard");
    expect(assets.icon).toEqual({ width: 1024, height: 1024 });
    expect(assets.tray).toEqual({ width: 18, height: 18 });
    expect(assets.scales).toEqual([1, 2]);

    await instance.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.hide(),
    );
    await expect
      .poll(() =>
        instance.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.isVisible(),
        ),
      )
      .toBe(false);
    await instance.evaluate(({ app }) => app.emit("activate"));
    await expect
      .poll(() =>
        instance.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.isVisible(),
        ),
      )
      .toBe(true);
    await instance.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.minimize(),
    );
    await expect
      .poll(() =>
        instance.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.isMinimized(),
        ),
      )
      .toBe(true);
    await instance.evaluate(({ app }) =>
      app.emit("second-instance", {}, [], ""),
    );
    await expect
      .poll(() =>
        instance.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.isMinimized(),
        ),
      )
      .toBe(false);
  } finally {
    await closeApp(instance);
    await cleanProfile(profile);
  }
});
