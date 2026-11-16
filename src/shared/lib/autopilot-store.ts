import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  autopilotConfigFileSchema, autopilotConfigSchema, autopilotStateSchema, defaultAutopilotConfig, emptyAutopilotState,
  type AutopilotConfig, type AutopilotState,
} from "../autopilot";
import { isMissing, readJsonFile, writeFileAtomic, writeJsonAtomic } from "./fs";

export const processAlive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};
/** The process start time as `ps` prints it, or undefined when it cannot be read. Used to tell a reused pid apart. */
export function processStartTime(pid: number): string | undefined {
  try {
    const text = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return text || undefined;
  } catch { return undefined; }
}

/** A lock file or a reclaim guard that nobody has written into for this long is a leftover, not a holder. */
const unreadableMs = 10_000;
/** Contenders keep trying this long while another contender is mid-reclaim. */
const contendAttempts = 40;

export interface LockHeld { pid: number; at: string | null; ageMs: number | null; }
export interface AutopilotStoreOptions {
  now?: () => Date;
  isAlive?: (pid: number) => boolean;
  /** Start time of a pid; recorded in the lock and compared, so a reused pid does not keep a dead lock alive. */
  processStart?: (pid: number) => string | undefined;
  /** Test seam: runs after a contender judged a lock dead and before it tries to take it back. */
  beforeReclaim?: (token: string) => Promise<void>;
}

/**
 * `<userData>/autopilot/`: one small state file, an optional config and a lock.
 * It is not another queue database; Linear and the Dashboard stay the source of truth.
 */
export class AutopilotStore {
  readonly dir: string;
  private now: () => Date;
  private isAlive: (pid: number) => boolean;
  private processStart: (pid: number) => string | undefined;
  private beforeReclaim?: (token: string) => Promise<void>;
  constructor(root: string, options: AutopilotStoreOptions = {}) {
    this.dir = path.join(root, "autopilot");
    this.now = options.now ?? (() => new Date());
    this.isAlive = options.isAlive ?? processAlive;
    this.processStart = options.processStart ?? processStartTime;
    this.beforeReclaim = options.beforeReclaim;
  }
  get statePath() { return path.join(this.dir, "state.json"); }
  get configPath() { return path.join(this.dir, "config.json"); }
  get lockPath() { return path.join(this.dir, "lock"); }
  get todayPath() { return path.join(this.dir, "today.md"); }
  runDir(runId: string) { return path.join(this.dir, "runs", runId); }
  /** Never creates the file: a missing config means the documented defaults. */
  async readConfig(): Promise<AutopilotConfig> {
    const given = await readJsonFile(this.configPath, value => autopilotConfigFileSchema.parse(value), () => ({}));
    return autopilotConfigSchema.parse({ ...defaultAutopilotConfig(), ...given });
  }
  readState(): Promise<AutopilotState> {
    return readJsonFile(this.statePath, value => autopilotStateSchema.parse(value), emptyAutopilotState);
  }
  async ensureDir(dir = this.dir) { await mkdir(dir, { recursive: true, mode: 0o700 }); }
  /** Only callers that hold the lock may write. */
  async writeState(state: AutopilotState) {
    await this.ensureDir();
    await writeJsonAtomic(this.statePath, autopilotStateSchema.parse(state), { mode: 0o600 });
  }
  async writeToday(text: string) {
    await this.ensureDir();
    await writeFileAtomic(this.todayPath, text, { mode: 0o600 });
  }
  get reclaimGuardPath() { return `${this.lockPath}.reclaim`; }
  private async tryCreate(token: string) {
    const handle = await open(this.lockPath, "wx", 0o600);
    const startedAt = this.processStart(process.pid);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, at: this.now().toISOString(), token, ...(startedAt ? { startedAt } : {}) })); }
    finally { await handle.close(); }
  }
  private parseHolder(raw: string): { pid: number; at: string | null; token: string | null; startedAt: string | null } | undefined {
    try {
      const value = JSON.parse(raw) as Record<string, unknown>;
      if (typeof value.pid !== "number") return undefined;
      return {
        pid: value.pid, at: typeof value.at === "string" ? value.at : null,
        token: typeof value.token === "string" ? value.token : null, startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
      };
    } catch { return undefined; }
  }
  /** The holder's process exists and, when both start times are known, is the one that took the lock. */
  private holderAlive(holder: { pid: number; startedAt: string | null }) {
    if (!this.isAlive(holder.pid)) return false;
    if (!holder.startedAt) return true;
    const current = this.processStart(holder.pid);
    return current === undefined || current === holder.startedAt;
  }
  private heldOf(holder: { pid: number; at: string | null }): LockHeld {
    const at = holder.at ? Date.parse(holder.at) : NaN;
    return { pid: holder.pid, at: holder.at, ageMs: Number.isFinite(at) ? Math.max(0, this.now().getTime() - at) : null };
  }
  /** Read-only view of the current lock holder for `status`. */
  async peekLock(): Promise<(LockHeld & { alive: boolean }) | null> {
    const raw = await readFile(this.lockPath, "utf8").catch(() => undefined);
    const holder = raw === undefined ? undefined : this.parseHolder(raw);
    return holder ? { ...this.heldOf(holder), alive: this.holderAlive(holder) } : null;
  }
  /**
   * Takes back a lock judged dead, and only that exact lock. Reclaimers queue on a guard file; under it
   * the lock file cannot change (nobody but a live holder may delete it, and a creator only succeeds when
   * it is missing), so "still the lock I judged" and "move it aside" cannot be split by another taker.
   * Returns false when another contender is reclaiming right now.
   */
  private async reclaim(raw: string, token: string): Promise<boolean> {
    try { await (await open(this.reclaimGuardPath, "wx", 0o600)).close(); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A guard left by a crashed reclaimer: it is only held for an instant.
      const age = Date.now() - ((await stat(this.reclaimGuardPath).catch(() => undefined))?.mtimeMs ?? Date.now());
      if (age > unreadableMs) await unlink(this.reclaimGuardPath).catch(() => {});
      return false;
    }
    try {
      const current = await readFile(this.lockPath, "utf8").catch(() => undefined);
      // Replaced or already gone: someone else reclaimed first. What is there now is not ours to remove.
      if (current !== raw) return true;
      const aside = `${this.lockPath}.stale-${token}`;
      await rename(this.lockPath, aside);
      await unlink(aside).catch(() => {});
      return true;
    } finally { await unlink(this.reclaimGuardPath).catch(() => {}); }
  }
  /**
   * `acquired` when the lock was free or taken back from a dead holder. A live holder is never displaced,
   * however long it has held the lock: `held` says who and for how long so the caller can report it.
   */
  private async acquire(token: string): Promise<{ acquired: true } | { acquired: false; held?: LockHeld }> {
    await this.ensureDir();
    for (let attempt = 0; attempt < contendAttempts; attempt++) {
      try { await this.tryCreate(token); return { acquired: true }; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      let raw: string;
      try { raw = await readFile(this.lockPath, "utf8"); } catch (error) { if (isMissing(error)) continue; throw error; }
      const holder = this.parseHolder(raw);
      if (holder) {
        if (this.holderAlive(holder)) return { acquired: false, held: this.heldOf(holder) };
      } else {
        // Not valid JSON: a holder may still be writing it.
        const age = Date.now() - ((await stat(this.lockPath).catch(() => undefined))?.mtimeMs ?? Date.now());
        if (age < unreadableMs) return { acquired: false };
      }
      await this.beforeReclaim?.(token);
      if (!(await this.reclaim(raw, token))) await delay(25);
    }
    return { acquired: false };
  }
  /** Deletes the lock only when it is still this contender's own. */
  private async release(token: string) {
    const raw = await readFile(this.lockPath, "utf8").catch(() => "");
    if (this.parseHolder(raw)?.token === token) await unlink(this.lockPath).catch(() => {});
  }
  /**
   * Runs `work` with the exclusive lock held; `waitMs` 0 returns `{busy:true}` at once when another
   * process holds it (`held` names a live holder). `work` re-reads state itself, so it decides from what is on disk now.
   */
  async withLock<T>(work: () => Promise<T>, waitMs = 0): Promise<{ busy: true; held?: LockHeld } | { busy: false; value: T }> {
    const token = randomUUID();
    const started = Date.now();
    let outcome = await this.acquire(token);
    while (!outcome.acquired) {
      if (Date.now() - started >= waitMs) return { busy: true, ...(outcome.held ? { held: outcome.held } : {}) };
      await delay(50);
      outcome = await this.acquire(token);
    }
    try { return { busy: false, value: await work() }; } finally { await this.release(token); }
  }
}
