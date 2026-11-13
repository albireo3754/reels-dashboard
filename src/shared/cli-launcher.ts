/**
 * The `reels` launcher the app writes, shared by the writer (`src/desktop/cli-install.ts`)
 * and the read-only `reels doctor`, so both agree on what "managed" means.
 */

/** Marks a `reels` launcher this app wrote, so it may be refreshed but a user's own file is never replaced. */
export const CLI_LAUNCHER_MARKER = "# reels-dashboard-managed-cli";

const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const execPrefix = "ELECTRON_RUN_AS_NODE=1 exec ";

/**
 * The launcher runs the bundled CLI with the app's own Electron binary as Node,
 * so the command works without a separate Node install and tracks the app version.
 */
export function cliLauncher(executable: string, bundle: string): string {
  return [
    "#!/bin/sh",
    CLI_LAUNCHER_MARKER,
    "# Written by Reels Dashboard on launch. Remove the marker line above to keep your own edits.",
    `${execPrefix}${quote(executable)} ${quote(bundle)} "$@"`,
    "",
  ].join("\n");
}

/** Splits the words `cliLauncher` quoted; undefined for anything it would not have written. */
function shellWords(text: string): string[] | undefined {
  const words: string[] = [];
  let word: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === " ") {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else if (char === "'") {
      const end = text.indexOf("'", i + 1);
      if (end < 0) return undefined;
      word = (word ?? "") + text.slice(i + 1, end);
      i = end;
    } else if (char === "\\" && i + 1 < text.length) {
      word = (word ?? "") + text[++i];
    } else if (char === '"' && text.startsWith('"$@"', i)) {
      if (word !== undefined) words.push(word);
      word = undefined;
      i += 3;
      words.push("$@");
    } else {
      word = (word ?? "") + char;
    }
  }
  if (word !== undefined) words.push(word);
  return words;
}

/** The executable and bundle a managed launcher runs, read back from its `exec` line. */
export function readCliLauncher(
  content: string,
): { executable: string; bundle: string } | undefined {
  if (!content.includes(CLI_LAUNCHER_MARKER)) return undefined;
  const line = content.split("\n").find((text) => text.startsWith(execPrefix));
  const words = line && shellWords(line.slice(execPrefix.length));
  if (!words || words.length !== 3 || words[2] !== "$@") return undefined;
  return { executable: words[0], bundle: words[1] };
}
