// Pure IPC sender trust rule for main.ts. Electron objects are compared by
// identity only, so tests can pass plain tokens.

/** A window whose main frame may call IPC: its webContents and that mainFrame. */
export interface TrustedFrame {
  sender: unknown;
  frame: unknown;
}

export interface IpcSenderCheck {
  sender: unknown;
  /** event.senderFrame; null when the frame navigated or was destroyed. */
  frame: unknown;
  /** The live dashboard window; undefined once it is destroyed. */
  dashboard: TrustedFrame | undefined;
}

/**
 * Only the live dashboard window's main frame is trusted. Its subframes (the blog
 * tab's embedded editors and their manuscript frames, the preview iframe) get no
 * preload, and any call that still arrives from one, from another window or from
 * a destroyed frame is rejected.
 */
export function trustedIpcSender(check: IpcSenderCheck): boolean {
  const { dashboard } = check;
  return (
    !!dashboard &&
    !!check.sender &&
    !!check.frame &&
    check.sender === dashboard.sender &&
    check.frame === dashboard.frame
  );
}
