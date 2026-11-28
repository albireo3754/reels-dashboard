import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PowerMonitor } from "electron";

const heartbeatMs = 400;
const leaseMs = 2200;

/** Observes the desktop main's real power events. Renderer and agent requests cannot issue a lease. */
export class EditsShareSession {
  private generation = 0;
  private observedUnlock = false;
  private locked = false;
  private suspended = false;
  private inactive = false;
  private readonly watchers = new Set<() => void>();

  constructor(private readonly monitor: PowerMonitor) {
    monitor.on("lock-screen", () => { this.locked = true; this.invalidate(); });
    monitor.on("unlock-screen", () => {
      this.invalidate();
      this.locked = false;
      if (!this.suspended && !this.inactive) this.observedUnlock = true;
    });
    monitor.on("suspend", () => { this.suspended = true; this.invalidate(); });
    monitor.on("resume", () => { this.suspended = false; this.invalidate(); });
    monitor.on("user-did-resign-active", () => { this.inactive = true; this.invalidate(); });
    monitor.on("user-did-become-active", () => { this.inactive = false; this.invalidate(); });
  }

  get revision() { return this.generation; }
  get blocked() {
    if (this.locked || this.suspended || this.inactive) return true;
    if (this.monitor.getSystemIdleState(1) !== "locked") return false;
    this.invalidate();
    return true;
  }

  invalidate() {
    this.generation++;
    this.observedUnlock = false;
    for (const close of this.watchers) close();
  }

  watch(): { file: string; close(): void } {
    const dir = mkdtempSync(path.join(tmpdir(), "reels-share-session-"));
    const file = path.join(dir, "lease.json");
    const staged = path.join(dir, "next.json");
    let timer: ReturnType<typeof setInterval> | undefined;
    let last = performance.now();
    const close = () => {
      clearInterval(timer);
      this.watchers.delete(close);
      try { rmSync(dir, { recursive: true, force: true }); } catch {
        // The remaining lease expires within one heartbeat grace period even if cleanup fails.
      }
    };
    const refresh = () => {
      const now = performance.now();
      if (now - last >= leaseMs) {
        this.invalidate();
        return;
      }
      if (this.blocked) {
        close();
        return;
      }
      last = now;
      writeFileSync(staged, JSON.stringify({
        parentPid: process.pid,
        expiresAt: Date.now() + leaseMs,
        observedUnlock: this.observedUnlock,
      }), { mode: 0o600 });
      renameSync(staged, file);
    };
    this.watchers.add(close);
    try {
      refresh();
      if (this.watchers.has(close)) {
        timer = setInterval(() => {
          try { refresh(); } catch { this.invalidate(); }
        }, heartbeatMs);
        timer.unref();
      }
      return { file, close };
    } catch (error) {
      close();
      throw error;
    }
  }
}
