import { readFileSync } from "node:fs";

/**
 * The text of skills/reels-cli/SKILL.md. scripts/build-desktop.mjs replaces this
 * name with the file's contents when it builds dist-cli/reels.mjs, so the bundle
 * needs no repository; from source it is undefined and the file is read instead.
 */
declare const __REELS_AGENT_GUIDE__: string | undefined;

/** Repository path of the guide, relative to the root; the build reads the same file. */
export const agentGuidePath = "skills/reels-cli/SKILL.md";

/** The agent guide that matches this CLI, and its skill name from the frontmatter. */
export function agentGuide(): { name: string; guide: string } {
  const guide =
    typeof __REELS_AGENT_GUIDE__ === "string"
      ? __REELS_AGENT_GUIDE__
      : readFileSync(
          new URL(`../../../${agentGuidePath}`, import.meta.url),
          "utf8",
        );
  const name = /^---\n(?:.*\n)*?name: *(\S+)/.exec(guide)?.[1] ?? "reels-cli";
  return { name, guide };
}
