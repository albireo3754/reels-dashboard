import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Marks a `reels` launcher this app wrote, so it may be refreshed but a user's own file is never replaced. */
export const CLI_LAUNCHER_MARKER = "# reels-dashboard-managed-cli";

export type CliInstallResult =
  | { status: "installed" | "updated" | "unchanged"; target: string }
  | { status: "skipped"; target: string; reason: "foreign_file" | "missing_bundle" };

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The launcher runs the bundled CLI with the app's own Electron binary as Node,
 * so the command works without a separate Node install and tracks the app version.
 */
export function cliLauncher(executable: string, bundle: string): string {
  return [
    "#!/bin/sh",
    CLI_LAUNCHER_MARKER,
    "# Written by Reels Dashboard on launch. Remove the marker line above to keep your own edits.",
    `ELECTRON_RUN_AS_NODE=1 exec ${quote(executable)} ${quote(bundle)} "$@"`,
    "",
  ].join("\n");
}

/**
 * Installs or refreshes `<binDir>/reels`. A missing file or one carrying the marker is
 * (re)written; anything else (a symlink to a dev checkout, the user's own script) is left alone.
 */
export async function installCli(options: {
  executable: string;
  bundle: string;
  binDir: string;
}): Promise<CliInstallResult> {
  const target = path.join(options.binDir, "reels");
  const exists = await lstat(options.bundle).then(() => true, () => false);
  if (!exists) return { status: "skipped", target, reason: "missing_bundle" };
  const content = cliLauncher(options.executable, options.bundle);
  const stat = await lstat(target).catch(() => undefined);
  if (stat) {
    if (!stat.isFile()) return { status: "skipped", target, reason: "foreign_file" };
    const current = await readFile(target, "utf8");
    if (!current.includes(CLI_LAUNCHER_MARKER)) return { status: "skipped", target, reason: "foreign_file" };
    if (current === content) return { status: "unchanged", target };
  }
  await mkdir(options.binDir, { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, content, { mode: 0o755 });
  await rename(temp, target);
  return { status: stat ? "updated" : "installed", target };
}
