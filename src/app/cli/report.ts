import { lstat, mkdir, open, stat } from "node:fs/promises";
import path from "node:path";
import { computeAutopilotView } from "../../shared/autopilot";
import { AutopilotStore, processAlive, processStartTime } from "../../shared/lib/autopilot-store";
import { errorMessage } from "../../shared/lib/errors";
import { writeFileAtomic } from "../../shared/lib/fs";
import { PlanningStore } from "../../shared/lib/planning-store";
import { LocalStore, StoreUnreadable } from "../../shared/lib/storage";
import { buildStatusReport, renderStatusReportHtml, statusReportMarker } from "../../features/status-report";
import { finishedBlogsFromServer } from "../workflow/client";
import { CliError } from "./outcome";
import { localPath, parseOptions, wantsHelp, type CliIO } from "./tool-command";

export const reportOptions = { out: { type: "string" }, now: { type: "string" } } as const;
export const reportUsage = "reels report [--out <path>] [--now <iso-datetime>]";
export const reportHelp = `Usage: ${reportUsage}
Writes the current progress as one HTML file for people and other sessions: today's pick,
counts by state, weekly goals and the two-week video queue, the work order, what waits for
review or a channel, and posts from the last 14 days. Works without the app; reads only.
The same report is embedded as JSON in <script id="reels-status-report">.
--out  Where to write. Default: <profile>/reports/status.html. An existing file is replaced
       only when this command wrote it; anything else exits 2 (OUTPUT_EXISTS).
--now  Report as of this time (ISO 8601 with offset), for a reproducible copy. Default: now.
Leaves out local paths, notes, resources and calendar links; live post links stay.
Example: reels report
Example: reels report --out ./status.html`;
export const reportFileName = "status.html";

export interface ReportContext {
  root: string;
  io: CliIO;
  /** Test seam; the CLI passes the real clock. */
  now?: () => Date;
}

/** Only a regular file that carries the marker is ours to replace. */
async function ownedOrMissing(target: string) {
  const info = await lstat(target).catch(() => null);
  if (!info) return;
  const refuse = () => new CliError("OUTPUT_EXISTS", `--out already exists and was not written by reels report: ${target}`);
  if (!info.isFile()) throw refuse();
  const handle = await open(target, "r");
  try {
    const head = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    if (!head.subarray(0, bytesRead).toString("utf8").includes(`content="${statusReportMarker}"`)) throw refuse();
  } finally {
    await handle.close();
  }
}

async function outputPath(out: string | undefined, root: string, io: CliIO) {
  if (out === undefined) {
    const dir = path.join(root, "reports");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const target = path.join(dir, reportFileName);
    await ownedOrMissing(target);
    return target;
  }
  const target = localPath(out, "--out", io);
  const parent = await stat(path.dirname(target)).catch(() => null);
  if (!parent?.isDirectory())
    throw new CliError("USAGE", `--out parent folder does not exist: ${path.dirname(target)}`, { usage: reportUsage });
  await ownedOrMissing(target);
  return target;
}

function parseNow(value: string | undefined, fallback: () => Date) {
  if (value === undefined) return fallback();
  const at = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(at.getTime()))
    throw new CliError("USAGE", "--now must be an ISO 8601 date-time with an offset, such as 2026-11-17T09:00:00+09:00.", { usage: reportUsage });
  return at;
}

/** `reels report`: reads dashboard.json, planning.json and autopilot/, writes one HTML file. Never touches app state. */
export async function reportCommand(args: string[], { root, io, now = () => new Date() }: ReportContext) {
  if (wantsHelp(args, reportOptions)) return { data: { help: reportHelp } };
  const options = parseOptions(args, reportOptions, reportUsage);
  const at = parseNow(options.now, now);
  const target = await outputPath(options.out, root, io);

  let dashboard, planning;
  try {
    [dashboard, planning] = await Promise.all([new LocalStore(root).load(), new PlanningStore(root).get()]);
  } catch (error) {
    const file = error instanceof StoreUnreadable ? error.file : path.join(root, "planning.json");
    throw new CliError("STORE_UNREADABLE", `Could not read the app's saved data at ${file}: ${errorMessage(error)}`);
  }
  // The autopilot part is optional: a damaged autopilot file must not hide the rest of the report.
  let autopilot = null;
  try {
    const store = new AutopilotStore(root, { now: () => at });
    const [config, state] = await Promise.all([store.readConfig(), store.readState()]);
    autopilot = computeAutopilotView({
      planning, projects: dashboard.projects, state, config, now: at,
      probe: { isAlive: processAlive, startedAt: processStartTime },
    });
  } catch {
    autopilot = null;
  }

  const report = buildStatusReport({ dashboard, planning, autopilot, now: at, signals: { finishedBlogs: await finishedBlogsFromServer() } });
  const html = renderStatusReportHtml(report);
  try {
    await writeFileAtomic(target, html, { mode: 0o600 });
  } catch (error) {
    throw new CliError("OUTPUT_WRITE_FAILED", `Could not write ${target}: ${errorMessage(error)}`);
  }
  const week = report.goals.thisWeek.totals;
  return {
    data: {
      path: target,
      bytes: Buffer.byteLength(html),
      generatedAt: report.generatedAt,
      counts: report.counts,
      today: report.autopilot?.today ? { title: report.autopilot.today.title, decision: report.autopilot.today.decision } : null,
      thisWeek: { from: report.goals.thisWeek.from, ...week },
      warnings: report.warnings.length,
    },
  };
}
