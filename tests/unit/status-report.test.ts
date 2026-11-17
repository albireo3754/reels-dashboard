import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { buildStatusReport, renderStatusReportHtml, statusReportMarker, type StatusReport } from "../../src/features/status-report";
import { emptyPlanning, type Planning } from "../../src/shared/planning";
import type { Dashboard, Project } from "../../src/shared/contracts";
import type { Publication } from "../../src/shared/publications";
import { run } from "../../src/app/cli/run";
import type { CliIO } from "../../src/app/cli/tool-command";

// Tuesday 2026-11-17, 10:00 KST (the week runs from Sunday 11-15).
const now = new Date("2026-11-17T01:00:00Z");
const nowArg = "2026-11-17T10:00:00+09:00";
const calendarLink = "https://www.google.com/calendar/event?eid=SECRETACCOUNT";
const project = (id: string, extra: Partial<Project> = {}): Project => ({
  id, title: id, date: "2026-11-01", stage: "captured", nextAction: `next ${id}`, publicURL: "", shared: false,
  resources: [{ role: "footage", path: `/private-media/${id}.mov`, label: "원본" }],
  localNotes: `private note ${id}`,
  ...extra,
});
const pub = (channel: Publication["channel"], status: Publication["status"], extra: Partial<Publication> = {}): Publication =>
  ({ channel, status, url: "", ...extra });

const projects: Project[] = [
  project("first", { priority: 1, stage: "published", publications: [pub("instagram", "published", { publishedAt: "2026-11-10", url: "https://www.instagram.com/p/first/" }), pub("blog", "draft")] }),
  project("second", { priority: 2, stage: "review" }),
  project("done-with-priority", { priority: 3, stage: "done" }),
  project("review-unordered", { stage: "review", date: "2026-11-12" }),
  project("booked", { stage: "review", publications: [pub("naver-clip", "scheduled", { scheduledAt: "2026-11-20T15:56:00+09:00" })] }),
  project("overdue", { stage: "review", publications: [pub("naver-clip", "scheduled", { scheduledAt: "2026-11-16T15:56:00+09:00" })] }),
  project("old-post", { stage: "published", publications: [pub("instagram", "published", { publishedAt: "2026-10-01", url: "https://www.instagram.com/p/old/" })] }),
  project("idea", { stage: "idea", date: "2026-11-02" }),
];
const dashboard: Dashboard = { schemaVersion: 1, projects, updatedAt: "2026-11-17T00:00:00.000Z" };
const planning: Planning = {
  ...emptyPlanning(),
  updatedAt: "2026-11-17T00:00:00.000Z",
  calendar: {
    url: "https://calendar.google.com/calendar/u/0/r/week",
    syncedAt: "2026-11-16T00:00:00.000Z",
    window: { from: "2026-11-09", to: "2026-11-30" },
    events: [{ id: "e1", title: "[클립] idea", url: calendarLink, start: "2026-11-19T15:56:00+09:00", projectId: "idea", channel: "naver-clip", cancelled: false }],
  },
};
const build = (autopilot: Parameters<typeof buildStatusReport>[0]["autopilot"] = null) => buildStatusReport({ dashboard, planning, autopilot, now });

test("states: counts every project, work order first, complete ones left out", () => {
  const report = build();
  assert.deepEqual(report.counts, { complete: 2, scheduled: 2, channel_pending: 1, review: 2, in_progress: 1, total: 8, needsUser: 3 });
  const group = (id: string) => report.groups.find((g) => g.id === id)!.projects.map((p) => p.id);
  assert.deepEqual(group("ordered"), ["first", "second"]);
  // A project with a priority shows once, in the work order, never again under its state.
  assert.deepEqual(group("review"), ["review-unordered"]);
  assert.deepEqual(group("channel_pending"), []);
  // Every channel still to come is booked, so it waits on the channel even after the time passed.
  assert.deepEqual(group("scheduled"), ["booked", "overdue"]);
  assert.deepEqual(group("in_progress"), ["idea"]);
  const first = report.groups[0].projects[0];
  assert.equal(first.stateLabel, "채널 남음");
  assert.deepEqual(first.channels.map((c) => [c.label, c.statusLabel, c.url ?? null]), [
    ["인스타그램", "게시 완료", "https://www.instagram.com/p/first/"],
    ["블로그", "임시저장", null],
  ]);
});

test("recent posts cover 14 days and overdue bookings become warnings", () => {
  const report = build();
  assert.deepEqual(report.recent.map((r) => [r.projectId, r.day]), [["first", "2026-11-10"]]);
  const overdue = report.groups.flatMap((g) => g.projects).find((p) => p.id === "overdue")!;
  assert.equal(overdue.channels[0].overdue, true);
  assert.ok(report.warnings.some((w) => w.includes("「overdue」") && w.includes("11. 16. 15:56")));
  assert.ok(report.warnings.some((w) => w.includes("autopilot")), "a missing autopilot view is said, not guessed");
});

test("only what is safe to share: no local paths, notes or calendar links", () => {
  const report = build();
  const json = JSON.stringify(report);
  assert.ok(!json.includes("/private-media/"));
  assert.ok(!json.includes("private note"));
  assert.ok(!json.includes("SECRETACCOUNT"));
  // The calendar booking still counts toward the clip goal.
  const clip = report.goals.thisWeek.channels.find((c) => c.channel === "naver-clip")!;
  assert.ok(clip.posts.some((p) => p.projectId === "idea" && p.url === ""));
  const html = renderStatusReportHtml(report);
  assert.ok(!html.includes("/private-media/") && !html.includes("SECRETACCOUNT") && !html.includes("private note"));
});

test("html escapes text, keeps only http links and embeds the same report as JSON", () => {
  const hostile = project("x", {
    title: `<script>alert(1)</script></script><!-- & "q"`,
    priority: 1,
    stage: "published",
    publications: [pub("instagram", "published", { publishedAt: "2026-11-15", url: "https://example.com/a?b=1&c=<2>" })],
  });
  const report: StatusReport = buildStatusReport({ dashboard: { ...dashboard, projects: [hostile] }, planning, autopilot: null, now });
  const html = renderStatusReportHtml(report);
  assert.ok(html.includes(`<meta name="generator" content="${statusReportMarker}">`));
  assert.ok(!html.includes("<script>alert"));
  assert.equal(html.match(/<script/g)?.length, 1, "only the JSON block");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  const json = /<script type="application\/json" id="reels-status-report">(.*)<\/script>/s.exec(html)![1];
  assert.deepEqual(JSON.parse(json), JSON.parse(JSON.stringify(report)));
  assert.ok(html.includes(`href="https://example.com/a?b=1&amp;c=%3C2%3E"`));
  assert.ok(html.includes(`rel="noreferrer"`));
});

async function profile() {
  return realpath(await mkdtemp(path.join(tmpdir(), "reels-report-")));
}
async function cli(root: string, args: string[], cwd = root) {
  let stdout = "";
  const io: CliIO = {
    stdin: () => Readable.from([]),
    stdout: (text) => (stdout += text),
    stderr: () => {},
    env: { REELS_USER_DATA: root },
    cwd: () => cwd,
    pollMs: 5,
  };
  const code = await run(args, io);
  assert.equal(stdout.split("\n").length, 2, "stdout is one line");
  return { code, document: JSON.parse(stdout) };
}
const withProfile = async (body: (root: string) => Promise<void>) => {
  const root = await profile();
  try {
    await writeFile(path.join(root, "dashboard.json"), JSON.stringify(dashboard));
    await writeFile(path.join(root, "planning.json"), JSON.stringify(planning));
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("reels report writes the profile copy without the app and replaces only its own file", async () => {
  await withProfile(async (root) => {
    const first = await cli(root, ["report", "--now", nowArg]);
    assert.equal(first.code, 0, JSON.stringify(first.document));
    const target = path.join(root, "reports", "status.html");
    assert.equal(first.document.data.path, target);
    assert.equal(first.document.data.counts.needsUser, 3);
    assert.equal(first.document.data.generatedAt, now.toISOString());
    assert.equal((await lstat(target)).mode & 0o777, 0o600);
    const html = await readFile(target, "utf8");
    assert.ok(html.includes("릴스 대시보드 현황"));
    // Rerunning refreshes the same file.
    assert.equal((await cli(root, ["report", "--now", nowArg])).code, 0);
    // A file this command did not write is never replaced.
    const foreign = path.join(root, "mine.html");
    await writeFile(foreign, "<html>mine</html>");
    const refused = await cli(root, ["report", "--out", "mine.html"]);
    assert.equal(refused.code, 2);
    assert.equal(refused.document.error.code, "OUTPUT_EXISTS");
    assert.equal(await readFile(foreign, "utf8"), "<html>mine</html>");
    await symlink(target, path.join(root, "link.html"));
    assert.equal((await cli(root, ["report", "--out", "link.html"])).document.error.code, "OUTPUT_EXISTS");
    // A relative --out resolves against the working folder.
    const out = await cli(root, ["report", "--out", "share.html"]);
    assert.equal(out.document.data.path, path.join(root, "share.html"));
  });
});

test("reels report: usage errors, empty profile and a damaged store", async () => {
  await withProfile(async (root) => {
    assert.equal((await cli(root, ["report", "--now", "yesterday"])).code, 2);
    assert.equal((await cli(root, ["report", "--out", path.join(root, "missing", "a.html")])).code, 2);
    assert.equal((await cli(root, ["report", "--bogus"])).code, 2);
    const help = await cli(root, ["report", "--help"]);
    assert.equal(help.code, 0);
    assert.match(help.document.data.help, /^Usage: reels report/);
    await writeFile(path.join(root, "dashboard.json"), "{broken");
    const damaged = await cli(root, ["report"]);
    assert.equal(damaged.code, 11);
    assert.equal(damaged.document.error.code, "STORE_UNREADABLE");
  });
  const empty = await profile();
  try {
    await mkdir(empty, { recursive: true });
    const result = await cli(empty, ["report"]);
    assert.equal(result.code, 0, JSON.stringify(result.document));
    assert.equal(result.document.data.counts.total, 0);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("reels report is a listed built-in", async () => {
  const root = await profile();
  try {
    const tools = await cli(root, ["tools"]);
    assert.ok(tools.document.data.builtins.some((b: { command: string }) => b.command === "reels report"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
