import { rebuild } from "@electron/rebuild";

/**
 * Electron uses PTY directly. The embedded workflow server uses node:sqlite, so
 * better-sqlite3 (bundled JS only, never instantiated) needs no Electron rebuild.
 */
export default async function prepareDesktopDependencies(context) {
  console.info("Preparing node-pty for Electron; keeping headless SQLite on Node.");
  await rebuild({
    buildPath: context.appDir,
    electronVersion: context.electronVersion,
    platform: context.platform.nodeName,
    arch: context.arch,
    onlyModules: ["node-pty"],
    force: true,
  });
  // The required desktop dependency was rebuilt above. Prevent the builder from
  // rebuilding every production dependency against Electron's different V8 ABI.
  return false;
}
