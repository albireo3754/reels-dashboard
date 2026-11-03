import { BrowserWindow, session } from "electron";
import { formIdInput } from "../shared/input-forms";
import { workflowRequest } from "../app/workflow/client";
export class InputFormWindows {
  private windows = new Map<string, BrowserWindow>();
  private opening = new Map<string, Promise<{ formId: string; url: string }>>();
  constructor(private background: boolean) {}
  async open(raw: unknown) {
    const { formId } = formIdInput.parse(raw);
    const pending = this.opening.get(formId);
    if (pending) return pending;
    const promise = this.openOnce(formId).finally(() =>
      this.opening.delete(formId),
    );
    this.opening.set(formId, promise);
    return promise;
  }
  private async openOnce(formId: string) {
    await workflowRequest("form-get", { formId });
    const base = new URL(
      process.env.REELS_WORKFLOW_URL ?? "http://127.0.0.1:4318",
    );
    const url = new URL(
      `/?workflow=1&form=${encodeURIComponent(formId)}`,
      base,
    ).toString();
    const existing = this.windows.get(formId);
    if (existing && !existing.isDestroyed()) {
      if (!this.background) {
        existing.show();
        existing.focus();
      }
      return { formId, url };
    }
    const partition = "input-forms";
    const ses = session.fromPartition(partition);
    ses.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false),
    );
    ses.setPermissionCheckHandler(() => false);
    const win = new BrowserWindow({
      width: 1250,
      height: 900,
      show: !this.background,
      focusable: !this.background,
      title: "입력폼 · Reels Dashboard",
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, to) => {
      if (new URL(to).origin !== base.origin) event.preventDefault();
    });
    this.windows.set(formId, win);
    win.on("closed", () => {
      if (this.windows.get(formId) === win) this.windows.delete(formId);
    });
    try {
      await win.loadURL(url);
    } catch (e) {
      win.destroy();
      throw e;
    }
    return { formId, url };
  }
}
