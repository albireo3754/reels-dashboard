/**
 * Serializes tool calls that contend for one app-wide resource.
 *
 * Several MCP sessions share one app now, so two of them can call the same tool at the
 * same moment. Only tools that would otherwise interleave a check with the write that
 * depends on it, or fail with a "busy" error that is only an artifact of racing, are
 * locked. Everything already protected by an `updatedAt` revision, a fail-fast guard
 * the caller is meant to see (EDITS_BUSY, BLOG_EXTRACT_BUSY, ANALYSIS_BUSY) or a store
 * queue is left alone, and so are all reads.
 */
export class KeyedLock {
  private tails = new Map<string, Promise<void>>();

  /** Runs `fn` after every earlier call with the same key has settled (FIFO). */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => (release = resolve));
    const chained = previous.then(() => tail);
    this.tails.set(key, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === chained) this.tails.delete(key);
    }
  }
}

/**
 * editor: the editor service runs one project operation at a time (`exclusive`) and
 * refuses the rest with EDITOR_BUSY. Each of these tools also loads a project, compares
 * its `updatedAt`, then saves, so two sessions would interleave the load and the save.
 * Queuing them gives the loser a real STALE_PROJECT instead of a misleading EDITOR_BUSY.
 *
 * analysis: one analysis run owns the app-wide provider and `active.pid` lock. Starting
 * and the selection runner both claim it; queuing makes the second caller see the first
 * run's ANALYSIS_BUSY only after the first has actually claimed it.
 *
 * photos-index: `reels_photos_index` rebuilds the native Photos index, a single shared
 * database that two concurrent syncs would both write.
 */
const lockByTool: Record<string, string> = {
  reels_import_video: "editor",
  reels_update_project: "editor",
  reels_start_render: "editor",
  reels_open_project: "editor",
  reels_cancel_render: "editor",
  reels_merge_projects: "editor",
  reels_link_project_edit: "editor",
  reels_import_photos_bundle: "editor",
  reels_start_analysis: "analysis",
  reels_run_analysis_selection: "analysis",
  reels_photos_index: "photos-index",
};

export const lockedTools = Object.keys(lockByTool);
export const toolLockKey = (name: string): string | undefined =>
  Object.hasOwn(lockByTool, name) ? lockByTool[name] : undefined;
