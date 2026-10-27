import type { DashboardBridge, Snapshot } from "./contracts";
import { fromSnapshot } from "./data";
export function parseSnapshot(value: unknown): Snapshot {
  const dashboard = fromSnapshot(value);
  return {
    schemaVersion: 1,
    generatedAt: dashboard.updatedAt,
    projects: dashboard.projects.map(({ shared, ...project }) => project),
  };
}
export function createWebBridge(): DashboardBridge {
  const desktopOnly = async (): Promise<never> => {
    throw new Error("이 작업은 데스크톱 앱에서 사용할 수 있어요.");
  };
  return {
    mode: "web",
    editor: {
      runtime: async () => ({
        available: false,
        message: "영상 편집은 데스크톱 앱에서 사용할 수 있어요.",
      }),
      chooseVideo: desktopOnly,
      fromPhotos: desktopOnly,
      list: desktopOnly,
      load: desktopOnly,
      save: desktopOnly,
      preview: desktopOnly,
      export: desktopOnly,
      job: desktopOnly,
      cancel: desktopOnly,
      reveal: desktopOnly,
    },
    request: desktopOnly,
    saveDocument: desktopOnly,
    openDocument: desktopOnly,
    chooseDestination: desktopOnly,
    imageURL: desktopOnly,
    saveDashboard: desktopOnly,
    exportSnapshot: desktopOnly,
    syncSnapshot: desktopOnly,
    async loadDashboard() {
      const response = await fetch("./snapshot.json", { cache: "no-store" });
      if (!response.ok)
        throw new Error(
          "공유된 현황을 불러오지 못했어요. 데스크톱에서 내보낸 snapshot.json을 연결해주세요.",
        );
      return fromSnapshot(await response.json());
    },
  };
}
