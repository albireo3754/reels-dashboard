/**
 * Quit ordering for the desktop main process.
 *
 * `before-quit` may fire again while the async cleanup runs (for example when
 * disposing the last canonical-editor window triggers `window-all-closed` ->
 * `app.quit()`). Every such quit must be held until cleanup has finished, and only
 * the final quit issued after cleanup may proceed.
 */
export class ShutdownSequence {
  private phase: "idle" | "running" | "done" = "idle";
  private operations = 0;

  get busy() {
    return this.operations > 0;
  }

  /** Hold close/restart for the whole request, including gaps between children. */
  async track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.started)
      throw new Error("Dashboard is shutting down; request was not started");
    this.operations++;
    try {
      return await operation();
    } finally {
      this.operations--;
    }
  }

  /** Cleanup has started (or finished); windows may close without guards. */
  get started() {
    return this.phase !== "idle";
  }

  /** `before-quit`: true lets the quit proceed; false means call preventDefault. */
  mayQuit() {
    return this.phase === "done";
  }

  /**
   * Runs `cleanup` once when no tracked request is active, then calls `quit`
   * after it settles (even on failure). A busy attempt leaves the sequence idle.
   * Returns the cleanup promise so tests can await it.
   */
  run(cleanup: () => Promise<unknown>, quit: () => void): Promise<void> {
    if (this.phase !== "idle" || this.busy) return Promise.resolve();
    this.phase = "running";
    return Promise.resolve()
      .then(cleanup)
      .then(
        () => undefined,
        (error) => console.error("Shutdown cleanup failed:", error),
      )
      .finally(() => {
        this.phase = "done";
        quit();
      });
  }
}

/** A parent for modal dialogs, or undefined when the window is gone. */
export function liveWindow<T extends { isDestroyed(): boolean }>(
  window: T | undefined,
): T | undefined {
  return window && !window.isDestroyed() ? window : undefined;
}
