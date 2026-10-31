import { chromium } from "@playwright/test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

// The SVG paths are the source of truth; Chromium preserves transparent edges.
const root = path.resolve("resources/branding");
const iconset = path.join(root, "app.iconset");
await mkdir(iconset, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const render = async (source, size, output) => {
    await page.setViewportSize({ width: size, height: size });
    const svg = await readFile(path.join(root, source), "utf8");
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`,
    );
    await page.screenshot({ path: output, omitBackground: true });
  };
  for (const size of [16, 32, 128, 256, 512]) {
    await render(
      "app-icon.svg",
      size,
      path.join(iconset, `icon_${size}x${size}.png`),
    );
    await render(
      "app-icon.svg",
      size * 2,
      path.join(iconset, `icon_${size}x${size}@2x.png`),
    );
  }
  await render("app-icon.svg", 1024, path.join(root, "app.png"));
  await render("tray-icon.svg", 18, path.join(root, "trayTemplate.png"));
  await render("tray-icon.svg", 36, path.join(root, "trayTemplate@2x.png"));
  execFileSync("iconutil", [
    "-c",
    "icns",
    iconset,
    "-o",
    path.join(root, "app.icns"),
  ]);
} finally {
  await browser.close();
  await rm(iconset, { recursive: true, force: true });
}
console.log("App ICNS/PNG and 1×/2× template tray icons generated.");
