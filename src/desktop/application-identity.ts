import { app, Menu, nativeImage, Tray } from "electron";
import path from "node:path";

// Keep a reference for the lifetime of the application.
let tray: Tray | undefined;

export function installApplicationIdentity(showWindow: () => void) {
  const assets = path.join(app.getAppPath(), "resources/branding");
  const icon = path.join(assets, "app.png");
  const description =
    "촬영본을 고르고, 영상과 표지를 편집하며, 게시까지의 진행을 관리해요.";
  app.setAboutPanelOptions({
    applicationName: "Reels Dashboard",
    applicationVersion: app.getVersion(),
    iconPath: icon,
    copyright: description,
    credits:
      "Apple Photos·로컬 촬영본 탐색\n자막·장소 안내·표지 편집과 내보내기\n콘텐츠별 제작 진행과 자료 관리",
  });
  if (process.platform === "darwin") app.dock?.setIcon(icon);

  const image = nativeImage.createFromPath(
    path.join(assets, "trayTemplate.png"),
  );
  image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip(
    "Reels Dashboard — 촬영본 탐색부터 영상 편집과 제작 진행 관리까지",
  );
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Reels Dashboard", enabled: false },
      { label: "촬영본 탐색 · 영상 편집 · 제작 진행", enabled: false },
      { type: "separator" },
      { label: "대시보드 열기", click: showWindow },
      { label: "Reels Dashboard 정보", click: () => app.showAboutPanel() },
      { type: "separator" },
      { label: "Reels Dashboard 종료", click: () => app.quit() },
    ]),
  );
  tray.on("double-click", showWindow);
  app.once("will-quit", () => {
    tray?.destroy();
    tray = undefined;
  });
}
