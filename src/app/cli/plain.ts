import { toolDefinitions, type ToolName } from "../../features/agent-tools";
import { CliError } from "./outcome";
import {
  toolExample,
  toolFlags,
  toolOptionDocs,
  toolSlug,
  toolUsage,
  type ToolFlag,
} from "./tool-command";
import { toolGroupIds, toolGroupOf, toolGroups } from "./tool-groups";

/**
 * Text for people, only for `reels help --plain` and `reels tools --plain`.
 * Everything else, failures included, stays one JSON line.
 */
export const plainFlag = "--plain";

/** Removes `--plain` from a built-in's arguments; a repeat is a usage error like any option. */
export function takePlain(args: string[], usage?: string) {
  const rest = args.filter((arg) => arg !== plainFlag);
  if (args.length - rest.length > 1)
    throw new CliError("USAGE", `${plainFlag} was given more than once.`, {
      ...(usage ? { usage } : {}),
    });
  return { plain: rest.length !== args.length, rest };
}

const padded = (rows: string[][], indent = "  ") => {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );
  return rows.map((row) =>
    (
      indent +
      row
        .map((cell, column) =>
          column === row.length - 1 ? cell : cell.padEnd(widths[column]),
        )
        .join("  ")
    ).trimEnd(),
  );
};

type ListEntry = { name: ToolName; summary: string };
type BuiltinEntry = { command: string; summary: string };

/** `reels tools --plain [--group <id>]`: grouped by domain, one line per tool. */
export function plainToolList(
  entries: ListEntry[],
  builtins: BuiltinEntry[],
  group?: string,
) {
  const lines: string[] = [];
  lines.push(
    group
      ? `Reels Dashboard tools in group ${group} (${entries.length}).`
      : `Reels Dashboard tools (${entries.length}) by group.`,
    "Detail: reels tools --plain <slug>. Help: reels help --plain <slug>.",
  );
  if (!group) {
    lines.push("", "Built-in commands:");
    lines.push(...padded(builtins.map(({ command, summary }) => [command, summary])));
  }
  for (const id of toolGroupIds) {
    const members = entries.filter(({ name }) => toolGroupOf[name] === id);
    if (!members.length) continue;
    lines.push("", `${id}: ${toolGroups[id]} (${members.length})`);
    lines.push(
      ...padded(
        members.map(({ name, summary }) => [
          `reels ${toolSlug(name)}`,
          `${summary}${toolDefinitions[name].readOnly ? " (read-only)" : ""}`,
        ]),
      ),
    );
  }
  return lines.join("\n");
}

const flagType = (flag: ToolFlag) => {
  const parts = [
    flag.enum ? `one of ${flag.enum.join("|")}` : flag.type,
    ...(flag.format ? [flag.format] : []),
    ...(flag.pattern ? [`pattern ${flag.pattern}`] : []),
    flag.required ? "required" : "optional",
    ...(flag.default !== undefined
      ? [`default ${JSON.stringify(flag.default)}`]
      : []),
  ];
  return parts.join(", ");
};

/** `reels tools --plain <name>`: usage, flags with types and allowed values, example and group. */
export function plainToolDetail(name: ToolName) {
  const definition = toolDefinitions[name];
  const group = toolGroupOf[name];
  const flags = toolFlags(name);
  return [
    `reels ${toolSlug(name)}${definition.readOnly ? " (read-only)" : ""}`,
    `Tool: ${name}`,
    `Group: ${group} (reels tools --plain --group ${group})`,
    "",
    definition.description,
    "",
    `Usage: ${toolUsage(name)}`,
    `Example: ${toolExample(name)}`,
    "",
    "Flags:",
    ...(flags.length
      ? flags.flatMap((flag) => [
          `  ${flag.flag}  (${flagType(flag)})`,
          ...(flag.description ? [`      ${flag.description}`] : []),
        ])
      : ["  (none)"]),
    "",
    "CLI options:",
    ...padded(
      toolOptionDocs(name).map(({ flag, value, summary }) => [
        `${flag}${value ? ` ${value}` : ""}`,
        summary,
      ]),
    ),
  ].join("\n");
}

/** `reels help --plain exit-codes`. */
export function plainExitCodes(
  rows: { code: number; name: string; meaning: string }[],
) {
  return [
    "Exit codes:",
    ...padded(rows.map(({ code, name, meaning }) => [String(code), name, meaning])),
  ].join("\n");
}
