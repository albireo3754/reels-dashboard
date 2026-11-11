import { AgentCallError } from "../../shared/lib/agent-socket";
import { parseDataUrl } from "../../shared/lib/data-url";
import { errorMessage } from "../../shared/lib/errors";

export type Retry =
  | "safe"
  | "fix_input"
  | "refresh_first"
  | "wait"
  | "inspect_first"
  | "no";
export type WriteOutcome = "not_applied" | "applied" | "unknown" | "none";
type Rule = { exitCode: number; retry: Retry; writeOutcome: WriteOutcome };

export const exitCodes = {
  ok: 0,
  internal: 1,
  usage: 2,
  appOffline: 3,
  toolError: 4,
  conflict: 5,
  busy: 6,
  uncertain: 7,
  jobFailed: 8,
  jobCancelled: 9,
  waitTimeout: 10,
  localIo: 11,
  hangup: 129,
  interrupted: 130,
  terminated: 143,
} as const;

/** `reels help exit-codes` prints this; docs/cli-usage.md has the full table. */
export const exitCodeMeanings = {
  ok: "Success, including offline status and a completed --wait.",
  internal: "CLI bug.",
  usage: "Bad command, flag, JSON or input; nothing was sent.",
  appOffline: "The app cannot be called; nothing was sent.",
  toolError: "The app returned an error.",
  conflict: "Revision conflict: read again, then write with the new revision.",
  busy: "The app is busy: wait, then try again.",
  uncertain: "The outcome is unknown: inspect state before repeating a write.",
  jobFailed: "The render failed.",
  jobCancelled: "The render was cancelled.",
  waitTimeout: "Stopped waiting; the render keeps running.",
  localIo:
    "A local file failed: saving an image, a prepare-media copy, reading dashboard.json, or writing stdout.",
  hangup: "SIGHUP: stopped; the error says what happened to the work.",
  interrupted: "SIGINT: stopped; the error says what happened to the work.",
  terminated: "SIGTERM: stopped; the error says what happened to the work.",
} satisfies Record<keyof typeof exitCodes, string>;

const usage: Rule = {
  exitCode: exitCodes.usage,
  retry: "fix_input",
  writeOutcome: "not_applied",
};
/** Codes the CLI produces itself. A same-named code from the app goes through `remoteRule`. */
const localRules: Record<string, Rule> = {
  INTERNAL: {
    exitCode: exitCodes.internal,
    retry: "no",
    writeOutcome: "unknown",
  },
  USAGE: usage,
  UNKNOWN_TOOL: usage,
  INVALID_JSON: usage,
  INVALID_INPUT: usage,
  RENDER_FAILED: {
    exitCode: exitCodes.jobFailed,
    retry: "no",
    writeOutcome: "applied",
  },
  RENDER_CANCELLED: {
    exitCode: exitCodes.jobCancelled,
    retry: "no",
    writeOutcome: "applied",
  },
  WAIT_TIMEOUT: {
    exitCode: exitCodes.waitTimeout,
    retry: "safe",
    writeOutcome: "applied",
  },
  OUTPUT_WRITE_FAILED: {
    exitCode: exitCodes.localIo,
    retry: "safe",
    writeOutcome: "none",
  },
  STORE_UNREADABLE: {
    exitCode: exitCodes.localIo,
    retry: "no",
    writeOutcome: "not_applied",
  },
  PREPARE_FAILED: {
    exitCode: exitCodes.localIo,
    retry: "inspect_first",
    writeOutcome: "unknown",
  },
  // Each interruption states its own outcome; this is the cautious fallback.
  INTERRUPTED: {
    exitCode: exitCodes.interrupted,
    retry: "inspect_first",
    writeOutcome: "unknown",
  },
};

function remoteRule(code: string): Rule {
  if (code === "APP_OFFLINE")
    return {
      exitCode: exitCodes.appOffline,
      retry: "safe",
      writeOutcome: "not_applied",
    };
  if (code === "REQUEST_TOO_LARGE" || code === "OUTPUT_EXISTS") return usage;
  if (/^STALE_/.test(code) || code === "CONTEXT_REVISION_REQUIRED")
    return {
      exitCode: exitCodes.conflict,
      retry: "refresh_first",
      writeOutcome: "not_applied",
    };
  if (/(^|_)BUSY$/.test(code))
    return {
      exitCode: exitCodes.busy,
      retry: "wait",
      writeOutcome: "not_applied",
    };
  if (["REQUEST_TIMEOUT", "CONNECTION_LOST", "RESPONSE_INVALID"].includes(code))
    return {
      exitCode: exitCodes.uncertain,
      retry: "inspect_first",
      writeOutcome: "unknown",
    };
  return {
    exitCode: exitCodes.toolError,
    retry: "no",
    writeOutcome:
      code === "UNSUPPORTED" || code === "UNKNOWN_TOOL"
        ? "not_applied"
        : "unknown",
  };
}

/** `next` holds commands an agent can run as they are; anything else goes in `hint`. */
export type Guidance = { next?: string[]; hint?: string };

export type ErrorDetails = Guidance & {
  exitCode?: number;
  retry?: Retry;
  writeOutcome?: WriteOutcome;
  reason?: string;
  issues?: { path: PropertyKey[]; message: string }[];
  usage?: string;
  didYouMean?: string[];
  jobId?: string;
  job?: unknown;
};

/** Every failure the CLI reports. `remote` marks a code that came through the socket. */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: ErrorDetails = {},
    readonly remote = false,
  ) {
    super(message);
  }
}

const codePrefix = /^([A-Z][A-Z0-9_]+)(?::|$)/;

/** Classify what `callAgent` threw: `error.code`, then the message prefix, then `TOOL_ERROR`. */
export function agentFailure(
  error: unknown,
  guidance: (code: string) => Guidance,
) {
  const text = errorMessage(error);
  const unauthorized = text === "Unauthorized agent request";
  const explicit = (error as { code?: unknown } | null)?.code;
  const code = unauthorized
    ? "APP_OFFLINE"
    : typeof explicit === "string"
      ? explicit
      : (codePrefix.exec(text)?.[1] ?? "TOOL_ERROR");
  const reason = unauthorized
    ? "unresponsive"
    : error instanceof AgentCallError
      ? error.reason
      : undefined;
  return new CliError(
    code,
    text.replace(/^[A-Z][A-Z0-9_]+:\s*/, "") || text,
    { ...(reason ? { reason } : {}), ...guidance(code) },
    true,
  );
}

export function failureDocument(
  error: CliError,
  scope: { tool?: string; readOnly?: boolean; inFlight?: Guidance },
) {
  const rule =
    (!error.remote && localRules[error.code]) || remoteRule(error.code);
  const { exitCode, retry, writeOutcome, ...extra } = error.details;
  const code = exitCode ?? rule.exitCode;
  // A write with an unknown outcome says what to inspect, however it was cut off.
  const inspect =
    rule.exitCode === exitCodes.uncertain && !scope.readOnly && !extra.next
      ? { next: scope.inFlight?.next, hint: scope.inFlight?.hint }
      : {};
  return {
    exitCode: code,
    document: {
      ok: false,
      ...(scope.tool ? { tool: scope.tool } : {}),
      error: {
        code: error.code,
        message: error.message,
        exitCode: code,
        retry:
          retry ??
          (rule.exitCode === exitCodes.uncertain && scope.readOnly
            ? ("safe" as const)
            : rule.retry),
        writeOutcome: scope.readOnly
          ? ("none" as const)
          : (writeOutcome ?? rule.writeOutcome),
        ...inspect,
        ...extra,
      },
    },
  };
}

/** One JSON line. A data URL never reaches stdout, whatever tool produced it. */
export function serialize(document: unknown) {
  let omitted = 0;
  const text = JSON.stringify(document, (_key, value: unknown) => {
    const url = parseDataUrl(value);
    if (!url) return value;
    omitted++;
    return {
      omitted: "data_url",
      mimeType: url.mimeType,
      bytes: Buffer.byteLength(url.data, "base64"),
    };
  });
  return { text, omitted };
}
