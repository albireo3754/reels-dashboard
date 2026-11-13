import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  agentGuidance,
  toolDefinitions,
  type ToolName,
} from "../../features/agent-tools";
import {
  ContentLibrary,
  LocalMediaRejected,
  mediaExtensions,
  prepareLocalMedia,
} from "../../features/content-library";
import {
  AgentCallError,
  agentRoot,
  callAgent,
} from "../../shared/lib/agent-socket";
import type { RenderJob } from "../../shared/editor";
import { errorMessage } from "../../shared/lib/errors";
import { localPathSchema } from "../../shared/local-resources";
import { LocalStore, StoreUnreadable } from "../../shared/lib/storage";
import { engines, version } from "../../../package.json";
import { agentGuide } from "./agent-guide";
import { runtimeCheck, setupChecks, type Check } from "./doctor";
import {
  completionScript,
  completionShells,
  type CompletionShell,
} from "./completion";
import { checkOutputPath, saveImage } from "./image-output";
import {
  plainExitCodes,
  plainToolDetail,
  plainToolList,
  takePlain,
} from "./plain";
import {
  agentFailure,
  CliError,
  exitCodeMeanings,
  exitCodes,
  failureDocument,
  serialize,
  type ErrorDetails,
  type Guidance,
} from "./outcome";
import {
  closest,
  didYouMean,
  issueSummary,
  localPath,
  maxWaitSeconds,
  parseJson,
  parseOptions,
  parseToolArgs,
  readInputFile,
  readStdin,
  readToolInput,
  resolveTool,
  secondsOption,
  toolArgOptions,
  toolCliOption,
  toolExample,
  toolFlags,
  toolNames,
  toolOptionDocs,
  toolSchema,
  toolSlug,
  toolUsage,
  wantsHelp,
  type CliIO,
} from "./tool-command";
import {
  toolGroupIds,
  toolGroupOf,
  toolGroups,
  type ToolGroup,
} from "./tool-groups";

const statusOptions = { timeout: { type: "string" } } as const;
const prepareMediaOptions = {
  "project-id": { type: "string" },
  selection: { type: "string" },
  destination: { type: "string" },
  list: { type: "boolean" },
} as const;
const openApp = "Open Reels Dashboard; this CLI never launches it.";
const defaultCallSeconds = 180;
const defaultStatusSeconds = 5;
const maxCallSeconds = 180;
const defaultPollMs = 1000;

type JobWait = ErrorDetails & { jobId: string; job: RenderJob };
/** What the command is doing now, which decides how a failure or a signal reads. */
type Scope = {
  /** Aborted by SIGHUP, SIGINT or SIGTERM. */
  signal: AbortSignal;
  tool?: ToolName;
  readOnly?: boolean;
  /** Set once work may have reached the app or the disk: how an interruption reads from then on. */
  inFlight?: ErrorDetails;
  /** Set once a render job is known. */
  wait?: JobWait;
};
/**
 * `raw` replaces the JSON document with text for people. Only the opt-in text
 * forms set it (`help --plain`, `tools --plain`); failures are always JSON.
 */
type Success = { tool?: ToolName; data: unknown; raw?: string };

const shellArg = (value: unknown) => {
  const text = String(value);
  return /^[\w@%+=:,./-]+$/.test(text)
    ? text
    : `'${text.replaceAll("'", `'\\''`)}'`;
};

const showHelp = (text: string): Success => ({ data: { help: text } });

/** Words for `reels completion`: a command's own options, plus --help. */
const optionWords = (options: object) => [
  ...Object.keys(options).map((name) => `--${name}`),
  "--help",
];
/** Options that take a value: after one, completion offers file names, not flags. */
const valueWords = (options: Record<string, { type: string }>) =>
  Object.entries(options)
    .filter(([, { type }]) => type !== "boolean")
    .map(([name]) => `--${name}`);
const toolSlugs = () => toolNames.map(toolSlug);

type Input = Record<string, any>;

/** Writes whose input names nothing to read back; `reels status` covers the rest. */
const listReads: Partial<Record<ToolName, string>> = {
  reels_import_video: "reels list-projects",
  reels_import_photos_video: "reels list-projects",
  reels_merge_projects: "reels list-projects",
  // The entry may not exist yet, so get-content could be a dead end.
  reels_upsert_content: "reels list-projects",
  reels_form_create: "reels forms-list",
  reels_extract_blog_reference: "reels list-blog-references",
  reels_link_blog_reference: "reels list-blog-references",
  reels_unlink_blog_reference: "reels list-blog-references",
  reels_create_blog_comment: "reels list-blog-comments",
  reels_update_blog_comment: "reels list-blog-comments",
  reels_remove_blog_comment: "reels list-blog-comments",
};

/** The read that shows what a write touched, filled in from the input it sent. */
function stateRead(tool: ToolName, input: Input) {
  // A render's project does not say whether its job started; the job list does.
  if (tool === "reels_start_render") return "reels status";
  if (input.jobId)
    return `reels get-render-job --job-id ${shellArg(input.jobId)}`;
  if (input.formId) return `reels form-get --form-id ${shellArg(input.formId)}`;
  const id = input.projectId ?? input.reuse?.projectId;
  if (id === undefined) return listReads[tool] ?? "reels status";
  if (tool === "reels_start_analysis" || tool === "reels_correct_analysis")
    return `reels search-analysis --project-id ${shellArg(id)}`;
  // Editing tools take a uuid and content tools a dashboard id; the two are not interchangeable.
  const editing =
    input.reuse ||
    toolFlags(tool).some(
      ({ property, format }) => property === "projectId" && format === "uuid",
    );
  return `reels ${editing ? "get-project" : "get-content"} --project-id ${shellArg(id)}`;
}

/** What an agent can do next, filled in from the input it just sent. */
function guidance(code: string, input: Input, tool: ToolName): Guidance {
  if (code === "STALE_PROJECT") {
    const id = input.projectId ?? input.reuse?.projectId;
    return {
      next: [
        id
          ? `reels get-project --project-id ${shellArg(id)}`
          : "reels list-projects",
      ],
    };
  }
  if (code === "STALE_DASHBOARD")
    return {
      next: ["reels list-projects"],
      hint: "Use .data.dashboard.updatedAt as expectedUpdatedAt.",
    };
  if (code === "CONTEXT_REVISION_REQUIRED" || /^STALE_/.test(code)) {
    const read = stateRead(tool, input);
    return {
      next: [read],
      ...(/ (form-get|search-analysis) /.test(read)
        ? { hint: "Use .data.revision as expectedRevision." }
        : {}),
    };
  }
  if (code === "RENDER_JOB_NOT_FOUND") return { next: ["reels status"] };
  if (code === "APP_OFFLINE") return { next: ["reels status"], hint: openApp };
  if (code === "UNKNOWN_TOOL")
    return {
      hint: "Rebuild and restart Reels Dashboard; the running app predates this tool.",
    };
  return {};
}

/** A relative REELS_USER_DATA needs the working folder, which may be gone. */
function profileRoot(io: CliIO) {
  const value = io.env.REELS_USER_DATA;
  return value && !path.isAbsolute(value)
    ? localPath(value, "REELS_USER_DATA", io)
    : agentRoot(io.env);
}

function offlineReason(error: unknown) {
  if (errorMessage(error) === "Unauthorized agent request")
    return "unresponsive";
  if (!(error instanceof AgentCallError)) return undefined;
  return error.code === "APP_OFFLINE" ? error.reason : "unresponsive";
}

type AppStatus = {
  app: Record<string, unknown> & { online: boolean; reason?: string };
  userData: string | null;
  hint?: string;
};

/** The one verdict on whether the app can be called; `status` and `doctor` both report it. */
async function appStatus(
  io: CliIO,
  scope: Scope,
  timeoutMs: number,
): Promise<AppStatus> {
  let root: string;
  try {
    root = profileRoot(io);
  } catch (error) {
    return {
      app: { online: false, reason: "user_data_unresolved" },
      userData: null,
      hint: errorMessage(error),
    };
  }
  scope.inFlight = { retry: "safe" };
  try {
    const state = await callAgent(
      root,
      "reels_get_app_state",
      {},
      { timeoutMs, signal: scope.signal },
    );
    return { app: { online: true, ...state }, userData: root };
  } catch (error) {
    const reason = offlineReason(error);
    if (reason)
      return { app: { online: false, reason }, userData: root, hint: openApp };
    // It answered, so it is online; only its state could not be read.
    const { code, message } = agentFailure(error, () => ({}));
    return {
      app: { online: true, stateError: { code, message } },
      userData: root,
    };
  }
}

function statusTimeout(args: string[], usage: string) {
  const { timeout } = parseOptions(args, statusOptions, usage);
  return (
    secondsOption(timeout, "--timeout", maxCallSeconds) ??
    defaultStatusSeconds * 1000
  );
}

async function status(
  args: string[],
  io: CliIO,
  scope: Scope,
): Promise<Success> {
  scope.readOnly = true;
  if (wantsHelp(args, statusOptions)) return showHelp(statusCommand.help);
  const timeoutMs = statusTimeout(args, statusCommand.usage);
  const { app, userData, hint } = await appStatus(io, scope, timeoutMs);
  return {
    data: {
      app,
      cli: { version },
      userData,
      ...(hint === undefined ? {} : { hint }),
    },
  };
}

/** The app check of `reels doctor`, read off the same verdict `reels status` prints. */
function appCheck({ app }: AppStatus): Check {
  if (app.online) {
    const stateError = app.stateError as { code: string } | undefined;
    return stateError
      ? {
          id: "app",
          ok: false,
          detail: `Reels Dashboard answers, but its state could not be read (${stateError.code}).`,
          fix: "Restart Reels Dashboard; see .data.app.stateError.",
        }
      : { id: "app", ok: true, detail: "Reels Dashboard answers." };
  }
  if (app.reason === "user_data_unresolved")
    return {
      id: "app",
      ok: null,
      detail: "Not checked: the profile folder is unresolved.",
    };
  return {
    id: "app",
    ok: false,
    detail: `Reels Dashboard cannot be called (${app.reason}).`,
    fix:
      app.reason === "unresponsive"
        ? "Reels Dashboard did not answer in time; wait for it to finish starting, or restart it. This CLI never launches it."
        : openApp,
  };
}

async function profileCheck({ userData, hint }: AppStatus, io: CliIO) {
  const source = io.env.REELS_USER_DATA
    ? "REELS_USER_DATA"
    : "the default profile";
  if (userData === null)
    return {
      id: "profile",
      ok: false,
      detail: hint ?? "REELS_USER_DATA could not be resolved.",
      fix: "Set REELS_USER_DATA to an absolute path.",
    } satisfies Check;
  const folder = await stat(userData).catch(() => undefined);
  return folder?.isDirectory()
    ? ({
        id: "profile",
        ok: true,
        detail: `${userData} (${source}) exists.`,
      } satisfies Check)
    : ({
        id: "profile",
        ok: false,
        detail: `${userData} (${source}) is not a folder.`,
        fix: "Check REELS_USER_DATA, or open Reels Dashboard once so it creates its profile folder.",
      } satisfies Check);
}

async function doctor(
  args: string[],
  io: CliIO,
  scope: Scope,
): Promise<Success> {
  scope.readOnly = true;
  if (wantsHelp(args, statusOptions)) return showHelp(doctorCommand.help);
  const timeoutMs = statusTimeout(args, doctorCommand.usage);
  const versions = io.versions ?? {
    node: process.versions.node,
    electron: process.versions.electron,
  };
  const reported = await appStatus(io, scope, timeoutMs);
  const setup = await setupChecks({
    home: io.env.HOME || homedir(),
    pathEnv: io.env.PATH,
    script: io.script,
  });
  const checks: Check[] = [
    runtimeCheck(versions, engines?.node),
    await profileCheck(reported, io),
    appCheck(reported),
    {
      id: "app_version",
      ok: null,
      detail:
        "Unknown: the app does not report its version to the CLI. The app's launcher runs the bundle shipped with the app.",
    },
    ...setup.checks,
  ];
  return {
    data: {
      healthy: checks.every(({ ok }) => ok !== false),
      checks,
      cli: {
        version,
        ...(io.script ? { bundle: io.script } : {}),
        node: versions.node,
        ...(versions.electron ? { electron: versions.electron } : {}),
      },
      userData: reported.userData,
      app: reported.app,
      launcher: setup.launcher,
      command: setup.command,
    },
  };
}

const firstSentence = (text: string) =>
  text.split(/(?<=[.!?])(?<!\b(?:e\.g|i\.e)\.)\s/)[0];

const toolEntry = (name: ToolName) => ({
  name,
  command: `reels ${toolSlug(name)}`,
  readOnly: toolDefinitions[name].readOnly,
  summary: firstSentence(toolDefinitions[name].description),
  group: toolGroupOf[name],
});
const groupSummaries = toolGroupIds.map((id) => ({
  id,
  summary: toolGroups[id],
  count: toolNames.filter((name) => toolGroupOf[name] === id).length,
}));
const isGroupFlag = (arg: string) =>
  arg === "--group" || arg.startsWith("--group=");

/** `--group <id>`, or undefined when the list is not filtered. */
function groupFilter(args: string[]): ToolGroup | undefined {
  const usage = toolsCommand.usage;
  if (!args.some(isGroupFlag)) {
    if (args.length > 1 || args[0]?.startsWith("-"))
      throw new CliError("USAGE", "tools takes at most one tool name.", {
        usage,
      });
    return undefined;
  }
  if (args.some((arg, i) => !arg.startsWith("-") && args[i - 1] !== "--group"))
    throw new CliError(
      "USAGE",
      "--group filters the tool list; it does not take a tool name.",
      { usage },
    );
  const { group } = parseOptions(args, toolsOptions, usage);
  if (group !== undefined && Object.hasOwn(toolGroups, group))
    return group as ToolGroup;
  throw new CliError(
    "USAGE",
    `Unknown group: ${group}. Groups: ${toolGroupIds.join(", ")}.`,
    { didYouMean: closest(group ?? "", toolGroupIds), usage },
  );
}

function tools(argv: string[], scope: Scope): Success {
  scope.readOnly = true;
  const { plain, rest: args } = takePlain(argv, toolsCommand.usage);
  if (wantsHelp(args)) return asText(showHelp(toolsCommand.help), plain);
  const group = groupFilter(args);
  if (!args.length || group) {
    const names = group
      ? toolNames.filter((name) => toolGroupOf[name] === group)
      : toolNames;
    if (plain)
      return {
        data: null,
        raw: plainToolList(names.map(toolEntry), builtinSummaries, group),
      };
    return {
      data: {
        guidance: agentGuidance,
        builtins: builtinSummaries,
        count: names.length,
        tools: names.map(toolEntry),
        groups: groupSummaries,
        ...(group ? { group } : {}),
      },
    };
  }
  const name = requireTool(args[0]);
  if (plain) return { data: null, raw: plainToolDetail(name) };
  return {
    data: {
      name,
      command: `reels ${toolSlug(name)}`,
      readOnly: toolDefinitions[name].readOnly,
      description: toolDefinitions[name].description,
      inputSchema: toolSchema(name),
      flags: toolFlags(name),
      cliOptions: toolOptionDocs(name),
      example: toolExample(name),
      group: toolGroupOf[name],
    },
  };
}

function requireTool(value: string) {
  const name = resolveTool(value);
  if (name) return name;
  if (builtinCommands.includes(value))
    throw new CliError("UNKNOWN_TOOL", `${value} is a command, not a tool.`, {
      next: [`reels help ${value}`],
    });
  throw new CliError("UNKNOWN_TOOL", `Unknown tool: ${value}`, {
    didYouMean: didYouMean(value, builtinCommands),
    next: ["reels tools"],
  });
}

function toolHelp(name: ToolName) {
  return [
    `reels ${toolSlug(name)}${toolDefinitions[name].readOnly ? " (read-only)" : ""}`,
    toolDefinitions[name].description,
    `Usage: ${toolUsage(name)}`,
    `Example: ${toolExample(name)}`,
    ...toolFlags(name).flatMap(({ flag, description }) =>
      description ? [`  ${flag}  ${description}`] : [],
    ),
    ...toolOptionDocs(name).map(
      ({ flag, value, summary }) =>
        `  ${flag}${value ? ` ${value}` : ""}  ${summary}`,
    ),
    `Schema: reels tools ${toolSlug(name)}`,
    `Group: ${toolGroupOf[name]} (reels tools --group ${toolGroupOf[name]})`,
  ].join("\n");
}

/** Where a malformed id usually came from, by the flag that rejected it. */
const idSources: Record<string, Guidance> = {
  projectId: {
    next: ["reels list-projects"],
    hint: "This flag takes an editing project id: .data.editorProjects[].id, not a dashboard id.",
  },
  jobId: { next: ["reels status"] },
  formId: { next: ["reels forms-list"] },
};
function idGuidance(name: ToolName, issues: readonly z.core.$ZodIssue[]) {
  const flag = toolFlags(name).find(
    ({ property, format }) =>
      format === "uuid" &&
      issues.some(({ path }) => path.length === 1 && path[0] === property),
  );
  return flag ? idSources[flag.property] : undefined;
}

async function runTool(
  name: ToolName,
  args: string[],
  io: CliIO,
  scope: Scope,
): Promise<Success> {
  const definition = toolDefinitions[name];
  scope.tool = name;
  scope.readOnly = definition.readOnly;
  if (wantsHelp(args, toolArgOptions(name))) return showHelp(toolHelp(name));
  const parsed = parseToolArgs(name, args);
  const timeoutMs =
    secondsOption(parsed.timeout, "--timeout", maxCallSeconds) ??
    defaultCallSeconds * 1000;
  const waitLimitMs = secondsOption(
    parsed.waitTimeout,
    "--wait-timeout",
    maxWaitSeconds,
  );
  const raw = await readToolInput(parsed, io);
  const checked = (definition.input as z.ZodType).safeParse(raw);
  if (!checked.success)
    throw new CliError(
      "INVALID_INPUT",
      issueSummary(name, checked.error.issues),
      {
        issues: checked.error.issues.map(({ path, message }) => ({
          path,
          message,
        })),
        usage: toolUsage(name),
        ...idGuidance(name, checked.error.issues),
      },
    );
  const imageField = toolCliOption(name).imageField;
  const target =
    parsed.out === undefined
      ? undefined
      : await checkOutputPath(parsed.out, io);
  const root = profileRoot(io);
  const input = checked.data as Input;
  scope.inFlight = definition.readOnly
    ? { retry: "safe" }
    : {
        retry: "inspect_first",
        writeOutcome: "unknown",
        next: [stateRead(name, input)],
        hint: "The app may still apply this write. Check its state before repeating it.",
      };
  let data: unknown;
  try {
    data = await callAgent(root, name, input, {
      timeoutMs,
      signal: scope.signal,
    });
  } catch (error) {
    throw agentFailure(error, (code) => guidance(code, input, name));
  }
  if (target && imageField) data = await saveImage(data, imageField, target);
  if (parsed.wait)
    data = await waitForJob(data, {
      root,
      io,
      scope,
      timeoutMs,
      waitLimitMs,
      applied: !definition.readOnly,
    });
  return { tool: name, data: data ?? null };
}

/** Exhaustive in both directions, so a state added to `RenderJob` fails the type check here. */
const renderStates = {
  running: true,
  completed: true,
  cancelled: true,
  failed: true,
} satisfies Record<RenderJob["state"], true>;

function asJob(value: unknown): RenderJob {
  const job = value as Partial<RenderJob> | null;
  if (
    typeof job?.id !== "string" ||
    !Object.hasOwn(renderStates, job.state ?? "")
  )
    throw new CliError("RESPONSE_INVALID", "App response is not a render job.");
  return job as RenderJob;
}

type WaitOptions = {
  root: string;
  io: CliIO;
  scope: Scope;
  timeoutMs: number;
  waitLimitMs?: number;
  /** True when this command started the job, so later errors must not read as "not applied". */
  applied: boolean;
};

/** Follows a job to a terminal state. Never cancels it: the app owns the job. */
async function waitForJob(value: unknown, options: WaitOptions) {
  const { root, io, scope, timeoutMs, waitLimitMs, applied } = options;
  let job = asJob(value);
  const jobId = job.id;
  const context = {
    jobId,
    next: [`reels get-render-job --job-id ${jobId} --wait`],
    ...(applied ? { writeOutcome: "applied" as const } : {}),
  };
  scope.wait = { ...context, job, retry: "safe" };
  const limit = new AbortController();
  const stopped = AbortSignal.any([scope.signal, limit.signal]);
  const timer =
    waitLimitMs === undefined
      ? undefined
      : setTimeout(() => limit.abort(), waitLimitMs);
  /** `run` turns a signal into its own report, so only the wait limit is worded here. */
  const stopIfAsked = () => {
    if (limit.signal.aborted)
      throw new CliError(
        "WAIT_TIMEOUT",
        "Stopped waiting; the render keeps running in the app.",
        { ...context, job },
      );
    scope.signal.throwIfAborted();
  };
  let last = "";
  try {
    io.stderr(`reels: waiting for render job ${jobId}\n`);
    while (true) {
      const line =
        `${job.state} ${job.phase ?? ""} ${job.progress ?? ""}`.trim();
      if (line !== last) io.stderr(`reels: ${jobId} ${line}\n`);
      last = line;
      if (job.state !== "running") break;
      await delay(io.pollMs ?? defaultPollMs, undefined, {
        signal: stopped,
      }).catch(() => {});
      stopIfAsked();
      try {
        job = asJob(
          await callAgent(
            root,
            "reels_get_render_job",
            { jobId },
            { timeoutMs, signal: stopped },
          ),
        );
        scope.wait.job = job;
      } catch (error) {
        stopIfAsked();
        const failure =
          error instanceof CliError
            ? error
            : agentFailure(error, (code) =>
                guidance(code, {}, "reels_get_render_job"),
              );
        Object.assign(failure.details, context, { job });
        if (failure.code === "RENDER_JOB_NOT_FOUND")
          failure.details.next = ["reels status"];
        throw failure;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  if (job.state === "completed") return job;
  const failed = job.state === "failed";
  throw new CliError(
    failed ? "RENDER_FAILED" : "RENDER_CANCELLED",
    (failed && job.error) || `Render job ${job.state}.`,
    { jobId, job, ...(applied ? { writeOutcome: "applied" as const } : {}) },
  );
}

const storeFailure = (error: StoreUnreadable) =>
  new CliError(
    "STORE_UNREADABLE",
    `Could not read the app's saved data at ${error.file}: ${error.message}`,
    {
      hint: "Neither retrying nor changing the input helps. The file is damaged, unreadable, or written by a newer app; in that last case update the CLI.",
    },
  );

/** Read-only: lets an agent find a project and its paths while the app is closed. */
async function listMedia(root: string, projectId: string | undefined) {
  const store = new LocalStore(root);
  try {
    if (projectId === undefined)
      return {
        projects: (await store.load()).projects.map(
          ({ id, title, resources }) => ({
            id,
            title,
            resources: resources?.length ?? 0,
          }),
        ),
      };
    const { project, resources } = await new ContentLibrary(store).get(
      projectId,
    );
    return { id: project.id, title: project.title, resources };
  } catch (error) {
    if (error instanceof StoreUnreadable) throw storeFailure(error);
    throw agentFailure(error, () => ({ next: ["reels prepare-media --list"] }));
  }
}

async function prepareMedia(
  args: string[],
  io: CliIO,
  scope: Scope,
): Promise<Success> {
  // Before parsing, so a bad option in a read-only listing also reads as one.
  scope.readOnly = args.includes("--list");
  if (wantsHelp(args, prepareMediaOptions))
    return showHelp(prepareMediaCommand.help);
  const usage = prepareMediaCommand.usage;
  const options = parseOptions(args, prepareMediaOptions, usage);
  const projectId = options["project-id"];
  const { selection, destination, list } = options;
  if (list) {
    if (selection !== undefined || destination !== undefined)
      throw new CliError("USAGE", "--list only takes --project-id.", { usage });
    return { data: await listMedia(profileRoot(io), projectId) };
  }
  if (!projectId || !selection || !destination)
    throw new CliError(
      "USAGE",
      "--project-id, --selection and --destination are all required.",
      { usage },
    );
  if (
    !path.isAbsolute(destination) ||
    path.resolve(destination) !== destination
  )
    throw new CliError(
      "USAGE",
      "--destination must be a normalized absolute path, without a trailing slash.",
      { usage },
    );
  const text =
    selection === "-"
      ? await readStdin(io)
      : await readInputFile(selection, "--selection", io);
  const paths = z
    .array(localPathSchema)
    .safeParse(parseJson(text, selection === "-" ? "stdin" : selection));
  if (!paths.success)
    throw new CliError(
      "INVALID_INPUT",
      "--selection must be a JSON array of registered absolute media paths.",
      { usage },
    );
  // load() only reads, so this never writes to the app's store.
  const library = new ContentLibrary(new LocalStore(profileRoot(io)));
  const hint = `Inspect ${destination} before retrying; it may be incomplete.`;
  scope.inFlight = { retry: "inspect_first", writeOutcome: "unknown", hint };
  try {
    return {
      data: await prepareLocalMedia(library, {
        projectId,
        sources: paths.data,
        destination,
      }),
    };
  } catch (error) {
    if (error instanceof StoreUnreadable) throw storeFailure(error);
    const message = errorMessage(error);
    if (error instanceof LocalMediaRejected)
      throw new CliError("INVALID_INPUT", message, {
        usage,
        ...(error.issues.length
          ? {
              issues: error.issues,
              next: [
                `reels prepare-media --list --project-id ${shellArg(projectId)}`,
              ],
            }
          : {}),
        ...(/parent must not be a symlink/.test(message)
          ? {
              hint: "Use the real path of the parent folder. On macOS /tmp is a symlink to /private/tmp.",
            }
          : {}),
      });
    throw new CliError("PREPARE_FAILED", message, { hint });
  }
}

function exitCodeHelp(plain: boolean): Success {
  const rows = Object.entries(exitCodes).map(([name, code]) => ({
    code,
    name,
    meaning: exitCodeMeanings[name as keyof typeof exitCodes],
  }));
  if (plain) return { data: null, raw: plainExitCodes(rows) };
  return {
    data: {
      help: rows.map(({ code, meaning }) => `${code}  ${meaning}`).join("\n"),
      exitCodes: rows,
    },
  };
}

async function call(args: string[], io: CliIO, scope: Scope): Promise<Success> {
  if (args[0] === undefined || args[0].startsWith("-")) {
    if (wantsHelp(args)) return showHelp(callCommand.help);
    throw new CliError("USAGE", "call needs a tool name.", {
      usage: callCommand.usage,
    });
  }
  return runTool(requireTool(args[0]), args.slice(1), io, scope);
}

/** What a built-in gets from the router besides its arguments. */
type BuiltinContext = {
  io: CliIO;
  scope: Scope;
  /** Dispatches another argv, as `help <name>` does. */
  route(argv: string[]): Promise<Success>;
};
/**
 * A built-in command or global flag. To add one, define an entry and list it in
 * `builtins`: the router, `reels tools` and the unknown-name suggestions all read it.
 */
type Builtin = {
  /** argv[0]. A name starting with `-` is a global flag, not a command word. */
  name: string;
  /** Other argv[0] spellings that run this entry. */
  aliases?: readonly string[];
  /** Attached to its usage errors. */
  usage?: string;
  /** What `reels help <name>` and `--help` print, ending in an example. */
  help?: string;
  /** Set on commands that do work; `reels tools` lists them in data.builtins. */
  summary?: string;
  /** Words `reels completion` offers after this command. */
  completions?: () => readonly string[];
  /** Its options that take a value, for `reels completion`. */
  completionValues?: () => readonly string[];
  run(args: string[], context: BuiltinContext): Promise<Success> | Success;
};
/** `reels help <topic>`: help that belongs to no command. `plain` asks for text. */
type HelpTopic = { name: string; run(plain: boolean): Success };

/** The help text of a result, as text for people when asked for. */
function asText(result: Success, plain: boolean): Success {
  if (!plain) return result;
  const help = (result.data as { help?: unknown } | null)?.help;
  if (typeof help === "string") return { data: null, raw: help };
  throw new CliError("USAGE", "--plain only applies to help text.", {
    usage: helpUsage,
  });
}

const globalHelp = `reels - Reels Dashboard agent CLI. stdout: one JSON document. Diagnostics: stderr.
Start:   reels status     (setup problems: reels doctor)
Find:    reels tools | reels tools update-project | reels help update-project   (text: --plain)
List:    reels list-projects     (.data.editorProjects[].id for editing, .data.dashboard.projects[].id for content)
Read:    reels get-project --project-id <id>     (.data.updatedAt is the revision)
Edit:    reels update-project --project-id <id> --expected-updated-at <rev> --patch '{"cover":{"time":7.25}}'
Preview: reels preview-frame --project-id <id> --expected-updated-at <rev> --kind cover --out cover.png
Render:  reels start-render --project-id <id> --expected-updated-at <rev> --target video --output-path /abs/new.mov --wait
Resume:  reels get-render-job --job-id <id> --wait
Any:     reels call <tool> --input - < input.json
Copy:    reels prepare-media --list | reels prepare-media --help
Env:     REELS_USER_DATA selects the app profile.
Exit codes: reels help exit-codes. While writeOutcome is unknown, never retry a write; inspect state first.
Agents: reels help agent prints the usage guide for this version.`;
const helpFlag = {
  name: "--help",
  aliases: ["-h"],
  help: globalHelp,
  run: () => showHelp(globalHelp),
} satisfies Builtin;
const versionFlag = {
  name: "--version",
  run: () => ({ data: { version } }),
} satisfies Builtin;
const statusUsage = "reels status [--timeout <s>]";
const statusCommand = {
  name: "status",
  usage: statusUsage,
  help: `Usage: ${statusUsage}
Reports whether the app can be called. Exit 0 even when it cannot.
Example: reels status --timeout 2`,
  summary: "Whether the app can be called.",
  completions: () => optionWords(statusOptions),
  completionValues: () => valueWords(statusOptions),
  run: (args, { io, scope }) => status(args, io, scope),
} satisfies Builtin;
const doctorUsage = "reels doctor [--timeout <s>]";
const doctorCommand = {
  name: "doctor",
  usage: doctorUsage,
  help: `Usage: ${doctorUsage}
Read-only checks of why reels cannot be used right now: runtime, profile, app,
~/.local/bin/reels launcher and PATH. Each check has ok true, false or null (unknown),
and fix advice that the CLI never applies. Exit 0 whatever it finds.
Example: reels doctor`,
  summary: "Read-only checks of runtime, profile, app, launcher and PATH.",
  completions: () => optionWords(statusOptions),
  completionValues: () => valueWords(statusOptions),
  run: (args, { io, scope }) => doctor(args, io, scope),
} satisfies Builtin;
const toolsUsage = "reels tools [<name|slug> | --group <id>]";
const toolsOptions = { group: { type: "string" } } as const;
const toolsCommand = {
  name: "tools",
  usage: toolsUsage,
  help: `Usage: ${toolsUsage}
Lists every tool and built-in command, or prints one tool's input schema and flags.
--group <id>  Only the tools in one domain group. Groups: ${toolGroupIds.join(", ")}.
--plain       Text for people instead of JSON; failures stay JSON. Also: reels help --plain [<name>].
Example: reels tools start-render
Example: reels tools --group render`,
  completions: () => ["--plain", ...optionWords(toolsOptions), ...toolSlugs()],
  run: (args, { scope }) => tools(args, scope),
} satisfies Builtin;
const callUsage =
  "reels call <name|slug> [--input <json|-> | --input-file <path> | schema flags]";
const callCommand = {
  name: "call",
  usage: callUsage,
  help: `Usage: ${callUsage}
Calls any tool. List them with: reels tools
Example: reels call reels_get_project --input '{"projectId":"<uuid>"}'
Example: reels call reels_update_project --input - < input.json`,
  completions: toolSlugs,
  run: (args, { io, scope }) => call(args, io, scope),
} satisfies Builtin;
const prepareMediaCommand = {
  name: "prepare-media",
  usage:
    "reels prepare-media --project-id <id> --selection <file|-> --destination <abs> | --list [--project-id <id>]",
  help: `Usage: reels prepare-media --project-id <id> --selection <file|-> --destination <abs>
       reels prepare-media --list [--project-id <id>]
Copies registered media to a new folder with receipt.json. Works without the app.
--selection    File holding a JSON array of absolute registered paths, or - for stdin.
--destination  New folder: it must not exist, and its parent must exist and not be a symlink.
--list         Read-only. Projects, or one project's registered paths. Works without the app.
Select files, not folders; for a folder resource list the files inside it. Media: ${mediaExtensions.join(" ")}
Example: reels prepare-media --list --project-id sample
Example: echo '["/abs/clip.mov"]' | reels prepare-media --project-id sample --selection - --destination /abs/new-dir`,
  summary: "Copy registered media to a new folder. Works without the app.",
  completions: () => optionWords(prepareMediaOptions),
  completionValues: () => valueWords(prepareMediaOptions),
  run: (args, { io, scope }) => prepareMedia(args, io, scope),
} satisfies Builtin;
export const helpTopics: readonly HelpTopic[] = [
  { name: "exit-codes", run: exitCodeHelp },
  {
    name: "agent",
    run: (plain) => {
      const { guide, name } = agentGuide();
      // The Markdown guide as it is: it already reads as text.
      if (plain) return { data: null, raw: guide };
      return { data: { guide, name, version } };
    },
  },
];
const helpUsage = "reels help [--plain] [<topic|command|tool>]";
const helpCommand = {
  name: "help",
  completions: () => [
    "--plain",
    ...helpTopics.map(({ name }) => name),
    ...builtinCommands,
    ...toolSlugs(),
  ],
  /** A topic first; anything else is `<args> --help`. `--plain` is taken off first. */
  run: async (argv, { route }) => {
    const { plain, rest: args } = takePlain(argv, helpUsage);
    const topic = helpTopics.find(({ name }) => name === args[0]);
    if (topic) return topic.run(plain);
    // People asking about one tool get the full detail of `reels tools --plain <tool>`.
    const tool = plain && args.length === 1 ? resolveTool(args[0]) : undefined;
    if (tool) return { data: null, raw: plainToolDetail(tool) };
    const result = await route(args.length ? [...args, "--help"] : ["--help"]);
    return asText(result, plain);
  },
} satisfies Builtin;

const completionUsage = "reels completion <bash|zsh|fish>";
const completionCommand = {
  name: "completion",
  usage: completionUsage,
  help: `Usage: ${completionUsage}
Prints a shell completion script as text, not JSON. It installs nothing.
The script lists this version's commands and flags: re-run it after updating the app.
Example: reels completion zsh > ~/.zfunc/_reels
Example: eval "$(reels completion bash)"`,
  completions: () => completionShells,
  run: (args, { scope }) => completion(args, scope),
} satisfies Builtin;

/** Every built-in. The order of commands is the order of suggestions and of data.builtins. */
export const builtins: readonly Builtin[] = [
  helpFlag,
  versionFlag,
  statusCommand,
  doctorCommand,
  toolsCommand,
  callCommand,
  prepareMediaCommand,
  helpCommand,
  completionCommand,
];
/** Command words: never tool names, and offered when a name is mistyped. */
export const builtinCommands = builtins
  .map(({ name }) => name)
  .filter((name) => !name.startsWith("-"));
const builtinSummaries = builtins.flatMap(({ name, summary }) =>
  summary ? [{ command: `reels ${name}`, summary }] : [],
);
/** Read from the built-in table and the tool definitions each time, so it matches this version. */
function completionSpec() {
  return {
    version,
    first: [
      ...builtinCommands,
      ...toolSlugs(),
      ...builtins.flatMap(({ name }) => (name.startsWith("-") ? [name] : [])),
    ],
    commands: [
      ...builtins.flatMap(({ name, completions, completionValues }) =>
        completions && !name.startsWith("-")
          ? [
              {
                names: [name],
                words: completions(),
                values: completionValues?.() ?? [],
              },
            ]
          : [],
      ),
      ...toolNames.map((name) => ({
        names: [toolSlug(name), name],
        words: [
          ...toolFlags(name).map(({ flag }) => flag),
          ...toolOptionDocs(name).map(({ flag }) => flag),
          "--help",
        ],
        values: [
          ...toolFlags(name)
            .filter(({ type }) => type !== "boolean")
            .map(({ flag }) => flag),
          ...toolOptionDocs(name).flatMap(({ flag, value }) =>
            value ? [flag] : [],
          ),
        ],
      })),
    ],
    groups: toolGroupIds,
  };
}

function completion(args: string[], scope: Scope): Success {
  scope.readOnly = true;
  if (wantsHelp(args)) return showHelp(completionCommand.help);
  const [shell, ...extra] = args;
  const usage = completionCommand.usage;
  if (shell === undefined || shell.startsWith("-"))
    throw new CliError(
      "USAGE",
      shell === undefined
        ? `completion needs a shell: ${completionShells.join(", ")}.`
        : `Unknown option '${shell}'`,
      { didYouMean: [...completionShells], usage },
    );
  if (!(completionShells as readonly string[]).includes(shell)) {
    const near = closest(shell, completionShells);
    throw new CliError(
      "USAGE",
      `Unknown shell: ${shell}. Shells: ${completionShells.join(", ")}.`,
      { didYouMean: near.length ? near : [...completionShells], usage },
    );
  }
  if (extra.length)
    throw new CliError("USAGE", "completion takes one shell.", { usage });
  return {
    data: null,
    raw: completionScript(shell as CompletionShell, completionSpec()),
  };
}

const builtinsByName = new Map(
  builtins.flatMap((entry) =>
    [entry.name, ...(entry.aliases ?? [])].map((name) => [name, entry]),
  ),
);

async function route(
  argv: string[],
  io: CliIO,
  scope: Scope,
): Promise<Success> {
  const [command, ...rest] = argv;
  if (command === undefined)
    throw new CliError("USAGE", "Missing command.", { usage: "reels --help" });
  const builtin = builtinsByName.get(command);
  if (builtin)
    return builtin.run(rest, {
      io,
      scope,
      route: (next) => route(next, io, scope),
    });
  const tool = resolveTool(command);
  if (tool) return runTool(tool, rest, io, scope);
  throw new CliError("USAGE", `Unknown command: ${command}`, {
    didYouMean: didYouMean(command, builtinCommands),
    usage: "reels --help",
  });
}

const interrupts = {
  SIGHUP: exitCodes.hangup,
  SIGINT: exitCodes.interrupted,
  SIGTERM: exitCodes.terminated,
} as const;
type Interrupt = keyof typeof interrupts;

/** Turns the first signal into an abort. A second one gets the default behavior, so a stuck exit can still be killed. */
function watchSignals() {
  const controller = new AbortController();
  let received: Interrupt | undefined;
  const listeners = (Object.keys(interrupts) as Interrupt[]).map(
    (signal) => [signal, () => receive(signal)] as const,
  );
  const stop = () => {
    for (const [signal, listener] of listeners) process.off(signal, listener);
  };
  const receive = (signal: Interrupt) => {
    stop();
    received = signal;
    controller.abort();
  };
  for (const [signal, listener] of listeners) process.on(signal, listener);
  const raised = new Promise<never>((_resolve, reject) =>
    controller.signal.addEventListener("abort", () =>
      reject(new Error("interrupted")),
    ),
  );
  return { signal: controller.signal, raised, stop, received: () => received };
}

/** What a signal means depends on how far the command got; see the exit code table. */
function interruption(signal: Interrupt, { wait, inFlight }: Scope) {
  const exitCode = interrupts[signal];
  if (wait)
    return new CliError(
      "INTERRUPTED",
      "Stopped waiting; the render keeps running in the app.",
      { ...wait, exitCode },
    );
  if (inFlight)
    return new CliError("INTERRUPTED", "Stopped before the result was known.", {
      ...inFlight,
      exitCode,
    });
  return new CliError("INTERRUPTED", "Stopped before anything was sent.", {
    exitCode,
    retry: "safe",
    writeOutcome: "not_applied",
  });
}

export async function run(argv: string[], io: CliIO): Promise<number> {
  const signals = watchSignals();
  const scope: Scope = { signal: signals.signal };
  const write = (document: unknown) => {
    const { text, omitted } = serialize(document);
    if (omitted)
      io.stderr(
        `reels: replaced ${omitted} data URL value(s) in the result; stdout never carries base64.\n`,
      );
    io.stdout(text + "\n");
  };
  try {
    // The race ends the command even if what it was doing cannot be aborted.
    const { tool, data, raw } = await Promise.race([
      route(argv, io, scope),
      signals.raised,
    ]);
    signals.stop();
    // Text for people goes through the same writer, so a failed write still exits 11.
    if (raw !== undefined) io.stdout(raw.endsWith("\n") ? raw : raw + "\n");
    else write({ ok: true, ...(tool ? { tool } : {}), data });
    return exitCodes.ok;
  } catch (error) {
    signals.stop();
    const signal = signals.received();
    const failure = signal
      ? interruption(signal, scope)
      : error instanceof CliError
        ? error
        : new CliError("INTERNAL", errorMessage(error));
    const { exitCode, document } = failureDocument(failure, scope);
    io.stderr(
      `reels: ${failure.code}: ${failure.message.replace(/\s+/g, " ")}\n`,
    );
    write(document);
    return exitCode;
  }
}
