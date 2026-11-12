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
import { version } from "../../../package.json";
import { checkOutputPath, saveImage } from "./image-output";
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
  builtinCommands,
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

const helpText = `reels - Reels Dashboard agent CLI. stdout: one JSON document. Diagnostics: stderr.
Start:   reels status
Find:    reels tools | reels tools update-project | reels help update-project
List:    reels list-projects     (.data.editorProjects[].id for editing, .data.dashboard.projects[].id for content)
Read:    reels get-project --project-id <id>     (.data.updatedAt is the revision)
Edit:    reels update-project --project-id <id> --expected-updated-at <rev> --patch '{"cover":{"time":7.25}}'
Preview: reels preview-frame --project-id <id> --expected-updated-at <rev> --kind cover --out cover.png
Render:  reels start-render --project-id <id> --expected-updated-at <rev> --target video --output-path /abs/new.mov --wait
Resume:  reels get-render-job --job-id <id> --wait
Any:     reels call <tool> --input - < input.json
Copy:    reels prepare-media --list | reels prepare-media --help
Env:     REELS_USER_DATA selects the app profile.
Exit codes: reels help exit-codes. While writeOutcome is unknown, never retry a write; inspect state first.`;
const usages = {
  status: "reels status [--timeout <s>]",
  tools: "reels tools [<name|slug>]",
  call: "reels call <name|slug> [--input <json|-> | --input-file <path> | schema flags]",
  prepareMedia:
    "reels prepare-media --project-id <id> --selection <file|-> --destination <abs> | --list [--project-id <id>]",
};
const prepareMediaHelp = `Usage: reels prepare-media --project-id <id> --selection <file|-> --destination <abs>
       reels prepare-media --list [--project-id <id>]
Copies registered media to a new folder with receipt.json. Works without the app.
--selection    File holding a JSON array of absolute registered paths, or - for stdin.
--destination  New folder: it must not exist, and its parent must exist and not be a symlink.
--list         Read-only. Projects, or one project's registered paths. Works without the app.
Select files, not folders; for a folder resource list the files inside it. Media: ${mediaExtensions.join(" ")}
Example: reels prepare-media --list --project-id sample
Example: echo '["/abs/clip.mov"]' | reels prepare-media --project-id sample --selection - --destination /abs/new-dir`;
const statusHelp = `Usage: ${usages.status}
Reports whether the app can be called. Exit 0 even when it cannot.
Example: reels status --timeout 2`;
const toolsHelp = `Usage: ${usages.tools}
Lists every tool and built-in command, or prints one tool's input schema and flags.
Example: reels tools start-render`;
const callHelp = `Usage: ${usages.call}
Calls any tool. List them with: reels tools
Example: reels call reels_get_project --input '{"projectId":"<uuid>"}'
Example: reels call reels_update_project --input - < input.json`;
const builtinSummaries = [
  { command: "reels status", summary: "Whether the app can be called." },
  {
    command: "reels prepare-media",
    summary: "Copy registered media to a new folder. Works without the app.",
  },
];
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
type Success = { tool?: ToolName; data: unknown };

const shellArg = (value: unknown) => {
  const text = String(value);
  return /^[\w@%+=:,./-]+$/.test(text)
    ? text
    : `'${text.replaceAll("'", `'\\''`)}'`;
};

const showHelp = (text: string): Success => ({ data: { help: text } });

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

async function status(
  args: string[],
  io: CliIO,
  scope: Scope,
): Promise<Success> {
  scope.readOnly = true;
  if (wantsHelp(args, statusOptions)) return showHelp(statusHelp);
  const { timeout } = parseOptions(args, statusOptions, usages.status);
  const cli = { version };
  const timeoutMs =
    secondsOption(timeout, "--timeout", maxCallSeconds) ??
    defaultStatusSeconds * 1000;
  let root: string;
  try {
    root = profileRoot(io);
  } catch (error) {
    return {
      data: {
        app: { online: false, reason: "user_data_unresolved" },
        cli,
        userData: null,
        hint: errorMessage(error),
      },
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
    return { data: { app: { online: true, ...state }, cli, userData: root } };
  } catch (error) {
    const reason = offlineReason(error);
    if (reason)
      return {
        data: {
          app: { online: false, reason },
          cli,
          userData: root,
          hint: openApp,
        },
      };
    // It answered, so it is online; only its state could not be read.
    const { code, message } = agentFailure(error, () => ({}));
    return {
      data: {
        app: { online: true, stateError: { code, message } },
        cli,
        userData: root,
      },
    };
  }
}

const firstSentence = (text: string) =>
  text.split(/(?<=[.!?])(?<!\b(?:e\.g|i\.e)\.)\s/)[0];

function tools(args: string[], scope: Scope): Success {
  scope.readOnly = true;
  if (wantsHelp(args)) return showHelp(toolsHelp);
  if (args.length > 1 || args[0]?.startsWith("-"))
    throw new CliError("USAGE", "tools takes at most one tool name.", {
      usage: usages.tools,
    });
  if (!args.length)
    return {
      data: {
        guidance: agentGuidance,
        builtins: builtinSummaries,
        count: toolNames.length,
        tools: toolNames.map((name) => ({
          name,
          command: `reels ${toolSlug(name)}`,
          readOnly: toolDefinitions[name].readOnly,
          summary: firstSentence(toolDefinitions[name].description),
        })),
      },
    };
  const name = requireTool(args[0]);
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
  if (wantsHelp(args, prepareMediaOptions)) return showHelp(prepareMediaHelp);
  const usage = usages.prepareMedia;
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

function exitCodeHelp(): Success {
  const rows = Object.entries(exitCodes).map(([name, code]) => ({
    code,
    name,
    meaning: exitCodeMeanings[name as keyof typeof exitCodes],
  }));
  return {
    data: {
      help: rows.map(({ code, meaning }) => `${code}  ${meaning}`).join("\n"),
      exitCodes: rows,
    },
  };
}

async function route(
  argv: string[],
  io: CliIO,
  scope: Scope,
): Promise<Success> {
  const [command, ...rest] = argv;
  if (command === undefined)
    throw new CliError("USAGE", "Missing command.", { usage: "reels --help" });
  if (command === "--help" || command === "-h") return showHelp(helpText);
  if (command === "help")
    return rest[0] === "exit-codes"
      ? exitCodeHelp()
      : route(rest.length ? [...rest, "--help"] : ["--help"], io, scope);
  if (command === "--version") return { data: { version } };
  if (command === "status") return status(rest, io, scope);
  if (command === "tools") return tools(rest, scope);
  if (command === "prepare-media") return prepareMedia(rest, io, scope);
  if (command === "call") {
    if (rest[0] === undefined || rest[0].startsWith("-")) {
      if (wantsHelp(rest)) return showHelp(callHelp);
      throw new CliError("USAGE", "call needs a tool name.", {
        usage: usages.call,
      });
    }
    return runTool(requireTool(rest[0]), rest.slice(1), io, scope);
  }
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
    const { tool, data } = await Promise.race([
      route(argv, io, scope),
      signals.raised,
    ]);
    signals.stop();
    write({ ok: true, ...(tool ? { tool } : {}), data });
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
