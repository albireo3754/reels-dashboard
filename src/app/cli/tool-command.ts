import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { z } from "zod";
import { toolDefinitions, type ToolName } from "../../features/agent-tools";
import { agentRequestLimit } from "../../shared/lib/agent-socket";
import { errorMessage } from "../../shared/lib/errors";
import { CliError } from "./outcome";

export type CliIO = {
  stdin(): NodeJS.ReadableStream & { isTTY?: boolean };
  stdout(text: string): void;
  stderr(text: string): void;
  env: NodeJS.ProcessEnv;
  /** Throws when the working folder is gone; only relative paths need it. */
  cwd(): string;
  pollMs?: number;
};

type ToolCliOption = {
  imageField?: string;
  wait?: boolean;
  /** Example values, already quoted for a shell. An optional flag listed here joins the example. */
  sample?: Record<string, string>;
};
/** The only hand-written tool metadata; everything else derives from the schemas. */
export const cliOptions = {
  reels_preview_frame: { imageField: "image", sample: { kind: "cover" } },
  reels_form_media: { imageField: "dataUrl" },
  reels_start_render: { wait: true, sample: { outputPath: "/abs/new.mov" } },
  reels_get_render_job: { wait: true },
  reels_update_project: { sample: { patch: `'{"cover":{"time":7.25}}'` } },
  reels_photos_search: { sample: { text: "cafe" } },
  reels_sync_planning: { sample: { weeklyTarget: "3" } },
  reels_convert_gif: { sample: { outputPath: "/abs/clip.gif", crop: `'{"x":0,"y":0.15,"width":1,"height":0.85}'` } },
} satisfies Partial<Record<ToolName, ToolCliOption>>;
export const toolCliOption = (name: ToolName): ToolCliOption =>
  (cliOptions as Partial<Record<ToolName, ToolCliOption>>)[name] ?? {};

export const builtinCommands = [
  "status",
  "tools",
  "call",
  "prepare-media",
  "help",
];
export const reservedOptions = {
  input: { type: "string" },
  "input-file": { type: "string" },
  timeout: { type: "string" },
  out: { type: "string" },
  wait: { type: "boolean" },
  "wait-timeout": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

/** Above this a timer overflows and Node fires it after 1 ms. */
export const maxWaitSeconds = 2_147_483;

export const toolNames = Object.keys(toolDefinitions) as ToolName[];
export const toolSlug = (name: string) =>
  name.replace(/^reels_/, "").replaceAll("_", "-");
export const propertyFlag = (property: string) =>
  property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const slugs = new Map(toolNames.map((name) => [toolSlug(name), name]));
/** Takes the full name, the slug, or `get_project` as the guidance text writes it. */
export const resolveTool = (value: string) => slugs.get(toolSlug(value));

function editDistance(from: string, to: string) {
  let row = Array.from({ length: to.length + 1 }, (_, index) => index);
  for (const [i, letter] of [...from].entries()) {
    const next = [i + 1];
    for (let j = 0; j < to.length; j++)
      next.push(
        Math.min(
          row[j + 1] + 1,
          next[j] + 1,
          row[j] + (letter === to[j] ? 0 : 1),
        ),
      );
    row = next;
  }
  return row[to.length];
}

export function didYouMean(value: string, extra: string[] = []) {
  if (value.startsWith("-")) return [];
  const query = toolSlug(value.toLowerCase());
  const limit = Math.min(3, Math.max(1, Math.floor(query.length / 3)));
  const contains = (name: string) =>
    query.length >= 3 && (name.includes(query) || query.includes(name));
  const prefix = (name: string) => Number(name.startsWith(query));
  const gap = (name: string) => Math.abs(name.length - query.length);
  return [...extra, ...slugs.keys()]
    .map((name) => ({
      name,
      distance: contains(name) ? 0 : editDistance(query, name),
    }))
    .filter(({ distance }) => distance <= limit)
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        prefix(b.name) - prefix(a.name) ||
        gap(a.name) - gap(b.name),
    )
    .slice(0, 3)
    .map(({ name }) => name);
}

type JsonSchema = {
  properties?: Record<
    string,
    {
      type?: unknown;
      enum?: unknown[];
      format?: string;
      pattern?: string;
      description?: string;
      default?: unknown;
    }
  >;
  required?: string[];
};
export const toolSchema = (name: ToolName) =>
  z.toJSONSchema(toolDefinitions[name].input, { io: "input" });

export type ToolFlag = {
  flag: string;
  property: string;
  type: string;
  required: boolean;
  enum?: unknown[];
  format?: string;
  pattern?: string;
  description?: string;
  default?: unknown;
};
const patternNames: Record<string, string> = {
  "^\\/.*": "abs-path",
  "^\\d{4}-\\d{2}-\\d{2}$": "YYYY-MM-DD",
  "^[a-f0-9]{64}$": "hex64",
};
/** Zod's own `starts_with` says nothing about the value, so a known pattern is named instead. */
const flagFormat = (value: { format?: string; pattern?: string }) =>
  patternNames[value.pattern ?? ""] ??
  (value.format === "starts_with" ? undefined : value.format);
export function toolFlags(name: ToolName): ToolFlag[] {
  const schema = toolSchema(name) as JsonSchema;
  return Object.entries(schema.properties ?? {}).map(([property, value]) => {
    const format = flagFormat(value);
    return {
      flag: `--${propertyFlag(property)}`,
      property,
      type: typeof value.type === "string" ? value.type : "json",
      required: schema.required?.includes(property) ?? false,
      ...(value.enum ? { enum: value.enum } : {}),
      ...(format ? { format } : {}),
      ...(value.pattern && !value.format ? { pattern: value.pattern } : {}),
      ...(value.description ? { description: value.description } : {}),
      ...(value.default !== undefined ? { default: value.default } : {}),
    };
  });
}

const placeholder = ({ type, enum: values, format }: ToolFlag) =>
  type === "boolean"
    ? ""
    : values
      ? ` <${values.join("|")}>`
      : ["object", "array", "json"].includes(type)
        ? " '<json>'"
        : ` <${format === "date-time" ? "iso-datetime" : (format ?? type)}>`;
/** Usage with real values wherever the schema or `sample` supplies one. */
export function toolExample(name: ToolName) {
  const { imageField, wait, sample } = toolCliOption(name);
  return [
    `reels ${toolSlug(name)}`,
    ...toolFlags(name)
      .filter((flag) => flag.required || sample?.[flag.property] !== undefined)
      .map((flag) => {
        const value = sample?.[flag.property] ?? flag.enum?.[0];
        return value === undefined
          ? flag.flag + placeholder(flag)
          : `${flag.flag} ${value}`;
      }),
    ...(imageField ? ["--out frame.png"] : []),
    ...(wait ? ["--wait"] : []),
  ].join(" ");
}
export function toolUsage(name: ToolName) {
  const flags = toolFlags(name);
  const { imageField, wait } = toolCliOption(name);
  return [
    `reels ${toolSlug(name)}`,
    ...flags
      .filter((flag) => flag.required)
      .map((flag) => flag.flag + placeholder(flag)),
    ...(imageField ? ["--out <path>"] : []),
    ...flags
      .filter((flag) => !flag.required)
      .map((flag) => `[${flag.flag}${placeholder(flag)}]`),
    ...(wait ? ["[--wait [--wait-timeout <s>]]"] : []),
  ].join(" ");
}

/** The first schema issue with its flag, so one stderr line says what to fix. */
export function issueSummary(
  name: ToolName,
  issues: readonly { path: PropertyKey[]; message: string }[],
) {
  const [first] = issues;
  if (!first) return "Invalid input.";
  const flag = toolFlags(name).find(
    ({ property }) => first.path.length === 1 && property === first.path[0],
  );
  const where = flag
    ? `${flag.flag} (${flag.property})`
    : first.path.map(String).join(".");
  const what = /received undefined$/.test(first.message)
    ? "required"
    : first.message;
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
  return `${where ? `${where}: ` : ""}${what}${more}`;
}
export function toolOptionDocs(name: ToolName) {
  const { imageField, wait } = toolCliOption(name);
  return [
    {
      flag: "--input",
      value: "<json|->",
      summary: "Whole input as JSON; - reads stdin. Replaces the schema flags.",
    },
    {
      flag: "--input-file",
      value: "<path>",
      summary: "Whole input from a JSON file.",
    },
    {
      flag: "--timeout",
      value: "<s>",
      summary: "Limit for one app call, up to 180. Default 180.",
    },
    ...(imageField
      ? [
          {
            flag: "--out",
            value: "<path>",
            required: true,
            summary: "New file for the image.",
          },
        ]
      : []),
    ...(wait
      ? [
          {
            flag: "--wait",
            summary: "Wait for the job to reach a terminal state.",
          },
          {
            flag: "--wait-timeout",
            value: "<s>",
            summary: `Stop waiting after this long, up to ${maxWaitSeconds}; the job keeps running. Default none.`,
          },
        ]
      : []),
  ];
}

/**
 * True when `--help` or `-h` stands as an option. As the value of another option it
 * stays a value, so strict parsing reports it instead of a write quietly not running.
 */
export function wantsHelp(
  args: string[],
  options: ParseArgsOptionsConfig = {},
) {
  const { tokens } = parseArgs({
    args,
    options: { ...options, help: reservedOptions.help },
    strict: false,
    tokens: true,
  });
  return tokens.some(
    (token) => token.kind === "option" && token.name === "help",
  );
}

/** `parseArgs` in strict mode, plus the duplicate check it does not do itself. */
export function parseOptions<T extends ParseArgsOptionsConfig>(
  args: string[],
  options: T,
  usage: string,
) {
  let parsed;
  try {
    parsed = parseArgs({ args, options, strict: true, tokens: true });
  } catch (error) {
    throw new CliError("USAGE", usageMessage(error, args), { usage });
  }
  const seen = new Set<string>();
  for (const token of parsed.tokens)
    if (token.kind === "option") {
      if (seen.has(token.name))
        throw new CliError(
          "USAGE",
          `--${token.name} was given more than once.`,
          { usage },
        );
      seen.add(token.name);
    }
  return parsed.values;
}

function usageMessage(error: unknown, args: string[]) {
  const text = errorMessage(error);
  const flag = /^Option '(?:-\w, )?(--[\w-]+)[^']*' argument is ambiguous/.exec(
    text,
  )?.[1];
  if (!flag) return text.split(/\n|\. /)[0];
  const value = args[args.indexOf(flag) + 1];
  return `${flag} value starts with a dash. Write it as ${flag}=${value}.`;
}

const tooLarge = () =>
  new CliError(
    "REQUEST_TOO_LARGE",
    `Input exceeds ${agentRequestLimit} bytes.`,
  );

export async function readStdin(io: CliIO) {
  const stdin = io.stdin();
  if (stdin.isTTY)
    throw new CliError(
      "USAGE",
      "stdin is a terminal; pipe JSON into this command.",
    );
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > agentRequestLimit) throw tooLarge();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Only a relative path needs the working folder, so only it can fail on a deleted one. */
export function localPath(file: string, flag: string, io: CliIO) {
  if (path.isAbsolute(file)) return path.resolve(file);
  try {
    return path.resolve(io.cwd(), file);
  } catch {
    throw new CliError(
      "USAGE",
      `${flag} is relative but the working folder no longer exists. Use an absolute path.`,
    );
  }
}

export async function readInputFile(file: string, flag: string, io: CliIO) {
  const target = localPath(file, flag, io);
  try {
    if ((await stat(target)).size > agentRequestLimit) throw tooLarge();
    return await readFile(target, "utf8");
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      "USAGE",
      `Could not read ${file}: ${errorMessage(error)}`,
    );
  }
}

export function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(
      "INVALID_JSON",
      text.trim() ? `${source} is not valid JSON.` : `${source} is empty.`,
    );
  }
}

function flagValue(flag: ToolFlag, value: string | boolean) {
  if (typeof value === "boolean") return value;
  if (flag.type === "string") return value;
  if (flag.type === "number" || flag.type === "integer")
    return value.trim() ? Number(value) : NaN;
  return parseJson(value, flag.flag);
}

export const toolArgOptions = (name: ToolName): ParseArgsOptionsConfig => ({
  ...Object.fromEntries(
    toolFlags(name).map(({ flag, type }) => [
      flag.slice(2),
      { type: type === "boolean" ? ("boolean" as const) : ("string" as const) },
    ]),
  ),
  ...reservedOptions,
});

/** Parses a tool's arguments. Reads no input, so option errors never touch stdin. */
export function parseToolArgs(name: ToolName, args: string[]) {
  const flags = toolFlags(name);
  const usage = toolUsage(name);
  const values = parseOptions(args, toolArgOptions(name), usage) as Record<
    string,
    string | boolean | undefined
  >;
  const given = flags.filter(({ flag }) => values[flag.slice(2)] !== undefined);
  const {
    input,
    "input-file": inputFile,
    out,
    wait,
  } = values as {
    input?: string;
    "input-file"?: string;
    out?: string;
    wait?: boolean;
  };
  const waitTimeout = values["wait-timeout"] as string | undefined;
  const fail = (message: string) => new CliError("USAGE", message, { usage });
  if (input !== undefined && inputFile !== undefined)
    throw fail("Use only one of --input and --input-file.");
  if ((input !== undefined || inputFile !== undefined) && given.length)
    throw fail(
      `--input and --input-file replace schema flags; remove ${given[0].flag}.`,
    );
  const { imageField, wait: waitable } = toolCliOption(name);
  if (out !== undefined && !imageField)
    throw fail("--out only applies to tools that return an image.");
  if (out === undefined && imageField)
    throw fail("--out <path> is required: this tool returns an image.");
  if (wait && !waitable) throw fail("--wait only applies to render jobs.");
  if (waitTimeout !== undefined && !wait)
    throw fail("--wait-timeout needs --wait.");
  return {
    given: given.map((flag) => [flag, values[flag.flag.slice(2)]!] as const),
    input,
    inputFile,
    out,
    wait: wait === true,
    timeout: values.timeout as string | undefined,
    waitTimeout,
  };
}

export async function readToolInput(
  parsed: ReturnType<typeof parseToolArgs>,
  io: CliIO,
): Promise<unknown> {
  if (parsed.input === "-") return parseJson(await readStdin(io), "stdin");
  if (parsed.input !== undefined) {
    if (Buffer.byteLength(parsed.input) > agentRequestLimit) throw tooLarge();
    return parseJson(parsed.input, "--input");
  }
  if (parsed.inputFile !== undefined)
    return parseJson(
      await readInputFile(parsed.inputFile, "--input-file", io),
      parsed.inputFile,
    );
  return Object.fromEntries(
    parsed.given.map(([flag, value]) => [
      flag.property,
      flagValue(flag, value),
    ]),
  );
}

/** `--timeout` and `--wait-timeout` are seconds; returns milliseconds. */
export function secondsOption(
  value: string | undefined,
  flag: string,
  max: number,
) {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!(seconds > 0 && seconds <= max))
    throw new CliError(
      "USAGE",
      `${flag} must be greater than 0 and at most ${max}.`,
    );
  return seconds * 1000;
}
