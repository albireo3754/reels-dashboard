import { constants } from "node:fs";
import {
  access,
  lstat,
  readFile,
  readlink,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import {
  CLI_LAUNCHER_MARKER,
  readCliLauncher,
} from "../../shared/cli-launcher";

/**
 * Read-only setup checks for `reels doctor`. Nothing here writes, spawns or
 * launches anything: every check is a stat, a read or a comparison.
 * `ok: null` means the check could not decide.
 */
export type Check = {
  id: string;
  ok: boolean | null;
  detail: string;
  /** Advice for a person or agent. The CLI never applies it. */
  fix?: string;
};

export const openAppOnce =
  "Open the packaged Reels Dashboard once; it writes ~/.local/bin/reels on launch. This CLI never launches it.";

/** `>=22.12.0`-style engine range against a `major.minor.patch` version. */
export function runtimeCheck(
  versions: { node: string; electron?: string },
  engine: string | undefined,
): Check {
  const host = versions.electron
    ? `Electron ${versions.electron} as Node ${versions.node}`
    : `Node ${versions.node}`;
  const minimum = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(engine ?? "");
  const current = /^v?(\d+)\.(\d+)\.(\d+)/.exec(versions.node);
  if (!minimum || !current)
    return {
      id: "runtime",
      ok: null,
      detail: `${host}; could not compare it with ${engine ?? "the required version"}.`,
    };
  const [want, have] = [minimum, current].map((m) => m.slice(1, 4).map(Number));
  const index = want.findIndex((part, i) => part !== have[i]);
  const ok = index < 0 || have[index] > want[index];
  return {
    id: "runtime",
    ok,
    detail: `${host}; needs Node ${engine}.`,
    ...(ok
      ? {}
      : {
          fix: `Run the CLI with Node ${minimum.slice(1, 4).join(".")} or later, or through the app's launcher.`,
        }),
  };
}

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );
const real = (file: string) => realpath(file).catch(() => path.resolve(file));

export type LauncherInfo =
  | { path: string; state: "missing" }
  | { path: string; state: "managed"; bundle: string | null }
  | { path: string; state: "foreign" }
  | { path: string; state: "symlink"; target: string };

async function inspectLauncher(file: string): Promise<LauncherInfo> {
  const info = await lstat(file).catch(() => undefined);
  if (!info) return { path: file, state: "missing" };
  if (info.isSymbolicLink())
    return {
      path: file,
      state: "symlink",
      target: path.resolve(path.dirname(file), await readlink(file)),
    };
  if (!info.isFile()) return { path: file, state: "foreign" };
  const content = await readFile(file, "utf8").catch(() => "");
  // The same test `installCli` uses before it rewrites a launcher.
  if (!content.includes(CLI_LAUNCHER_MARKER))
    return { path: file, state: "foreign" };
  return {
    path: file,
    state: "managed",
    bundle: readCliLauncher(content)?.bundle ?? null,
  };
}

/** The first `reels` an exec-style PATH lookup would run. Empty entries (the working folder) are skipped. */
async function commandOnPath(pathEnv: string | undefined) {
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "reels");
    const info = await stat(candidate).catch(() => undefined);
    if (!info?.isFile()) continue;
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return candidate;
  }
  return undefined;
}

export type SetupFacts = {
  home: string;
  pathEnv: string | undefined;
  /** The bundle this process runs (process.argv[1]); undefined when unknown. */
  script: string | undefined;
};

export async function setupChecks({ home, pathEnv, script }: SetupFacts) {
  const binDir = path.join(home, ".local", "bin");
  const launcher = await inspectLauncher(path.join(binDir, "reels"));
  const found = await commandOnPath(pathEnv);
  const realBin = await real(binDir);
  const pathDirs = (pathEnv ?? "").split(path.delimiter).filter(Boolean);
  let onPath = false;
  for (const dir of pathDirs)
    if (path.isAbsolute(dir) && (await real(dir)) === realBin) onPath = true;
  const resolvesToLauncher =
    found !== undefined && (await real(path.dirname(found))) === realBin;
  const checks: Check[] = [];

  // What the launcher runs: a managed file's bundle, or a symlink's target.
  const runs =
    launcher.state === "managed"
      ? (launcher.bundle ?? undefined)
      : launcher.state === "symlink"
        ? launcher.target
        : undefined;
  const runsExists = runs !== undefined && (await exists(runs));

  if (launcher.state === "missing")
    checks.push({
      id: "launcher",
      ok: found ? null : false,
      detail: `${launcher.path} does not exist.${found ? ` reels on PATH is ${found} instead.` : ""}`,
      fix: openAppOnce,
    });
  else if (launcher.state === "foreign")
    checks.push({
      id: "launcher",
      ok: null,
      detail: `${launcher.path} was not written by the app (no managed marker), so the app leaves it alone.`,
      fix: "Remove it once to switch to the app's launcher; keep it if it is yours on purpose.",
    });
  else if (launcher.state === "symlink")
    checks.push({
      id: "launcher",
      ok: runsExists ? null : false,
      detail: `${launcher.path} is a symlink to ${launcher.target}${runsExists ? "" : ", which does not exist"}. The app never replaces a symlink.`,
      fix: "Remove the symlink once to switch to the app's launcher.",
    });
  else if (!launcher.bundle)
    checks.push({
      id: "launcher",
      ok: false,
      detail: `${launcher.path} is managed by the app but names no bundle.`,
      fix: openAppOnce,
    });
  else
    checks.push({
      id: "launcher",
      ok: runsExists,
      detail: `${launcher.path} is the app's launcher for ${launcher.bundle}${runsExists ? "" : ", which does not exist"}.`,
      ...(runsExists
        ? {}
        : {
            fix: "Open the packaged Reels Dashboard from its current location; it rewrites the launcher on launch.",
          }),
    });

  if (runs === undefined || !runsExists || script === undefined)
    checks.push({
      id: "launcher_bundle",
      ok: null,
      detail:
        script === undefined
          ? "The bundle this process runs is unknown."
          : "No launcher bundle to compare with.",
    });
  else {
    const same = (await real(runs)) === (await real(script));
    checks.push({
      id: "launcher_bundle",
      ok: same,
      detail: same
        ? `This run uses the launcher's bundle, ${runs}.`
        : `This run uses ${script}, but ${launcher.path} runs ${runs}; they may differ in version.`,
      ...(same
        ? {}
        : {
            fix: "Run reels doctor through PATH to check the copy agents use.",
          }),
    });
  }

  checks.push({
    id: "path_dir",
    ok: onPath,
    detail: onPath ? `${binDir} is on PATH.` : `${binDir} is not on PATH.`,
    ...(onPath ? {} : { fix: "Add ~/.local/bin to PATH." }),
  });

  if (!found)
    checks.push({
      id: "path_command",
      ok: false,
      detail: "No executable reels on PATH.",
      fix:
        launcher.state === "missing"
          ? openAppOnce
          : "Add ~/.local/bin to PATH.",
    });
  else if (resolvesToLauncher || launcher.state === "missing")
    checks.push({
      id: "path_command",
      ok: true,
      detail: `reels on PATH is ${found}.`,
    });
  else
    checks.push({
      id: "path_command",
      ok: false,
      detail: `reels on PATH is ${found}, which comes before ${launcher.path}.`,
      fix: `Put ~/.local/bin before ${path.dirname(found)} in PATH, or remove ${found}.`,
    });

  return {
    checks,
    launcher,
    command: { onPath: found ?? null, binDir, binDirOnPath: onPath },
  };
}
