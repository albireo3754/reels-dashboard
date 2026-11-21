import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { classifyLinear, defaultAutopilotConfig, autopilotConfigSchema, type RunOutput } from "../../src/shared/autopilot";
import {
  fetchLinearTeam, issueBlockersQuery, keychainAccount, keychainService, linearEndpoint, maskSecrets, maxIssues, maxPages, pageSize,
  linearFailureHint, refreshLinear, selectedFields, teamIssuesQuery, viewerOrganizationQuery,
  type FetchLike, type FetchResponseLike, type LinearDeps, type SecurityRunner,
} from "../../src/shared/lib/linear-source";
import { AutopilotStore } from "../../src/shared/lib/autopilot-store";
import { PlanningStore } from "../../src/shared/lib/planning-store";
import { LocalStore } from "../../src/shared/lib/storage";
import { linearImportSchema } from "../../src/shared/planning";
import { autopilotCommand, execute, runManual, tick, type AutopilotContext, type AutopilotDeps, type ModelRun } from "../../src/app/cli/autopilot";
import { CliError } from "../../src/app/cli/outcome";
import { run as runCli } from "../../src/app/cli/run";
import { Readable } from "node:stream";

const now = new Date("2026-11-16T05:00:00Z"); // Monday 14:00 KST, inside the active hours
const SECRET = "lin_api_SYNTHETICSECRETVALUE0123456789";
const settings = { teamKey: "P", workspaceUrlKey: "example-ws" };

type Json = Record<string, unknown>;
/** One issue as the official schema returns it for the query in `teamIssuesQuery`. */
const node = (n: number, extra: Json = {}): Json => ({
  id: `uuid-${n}`, identifier: `P-${n}`, title: `Synthetic issue ${n}`, url: `https://linear.app/example-ws/issue/P-${n}/synthetic-${n}`,
  description: null, dueDate: null, priority: 0,
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z", startedAt: null,
  state: { name: "Todo", type: "unstarted" }, team: { key: "P" },
  children: { pageInfo: { hasNextPage: false }, nodes: [] },
  inverseRelations: { pageInfo: { hasNextPage: false }, nodes: [] },
  attachments: { nodes: [] },
  ...extra,
});
const state = (type: string, name = type) => ({ name, type });
const page = (nodes: Json[], next?: string): Json => ({ data: { issues: { pageInfo: { hasNextPage: Boolean(next), endCursor: next ?? null }, nodes } } });

interface Call { url: string; headers: Record<string, string>; body: { query: string; variables: Json & { filter?: Json; after?: string | null; id?: string } }; }
const reply = (status: number, body: unknown, headers: Record<string, string> = {}): FetchResponseLike => ({
  status, headers: { get: name => headers[name.toLowerCase()] ?? null }, json: async () => body,
});
/**
 * A scripted API. `open` / `closed` are the pages of the two issue passes (cursor `c<n>` selects page n);
 * `blockers` are pages of the per-issue refetch. `respond` replaces any answer.
 */
function fakeApi(script: {
  open?: Json[][]; closed?: Json[][]; blockers?: Record<string, Json[][]>; respond?: (call: Call, index: number) => FetchResponseLike | Promise<FetchResponseLike>;
  headers?: Record<string, string>;
  /** The workspace the key belongs to (default: the one the tests configure), or a full reply to the organization query. */
  org?: string | (() => FetchResponseLike | Promise<FetchResponseLike>);
  /** Changes between calls: when set, the pages are read from here at call time. */
  live?: () => { open?: Json[][]; closed?: Json[][]; org?: string | (() => FetchResponseLike | Promise<FetchResponseLike>) };
} = {}) {
  const calls: Call[] = [];
  /** The workspace lookups, kept apart so the issue-page counts below stay about issues. */
  const orgCalls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call: Call = { url, headers: init.headers, body: JSON.parse(init.body) };
    const cur = script.live ? { ...script, ...script.live() } : script;
    if (call.body.query.includes("ViewerOrganization")) {
      orgCalls.push(call);
      if (typeof cur.org === "function") return cur.org();
      return reply(200, { data: { viewer: { organization: { id: "org-uuid", urlKey: cur.org ?? settings.workspaceUrlKey } } } });
    }
    calls.push(call);
    if (cur.respond) return cur.respond(call, calls.length - 1);
    const after = call.body.variables.after;
    const index = after ? Number(after.slice(1)) : 0;
    const paged = (pages: Json[][] | undefined, wrap: (nodes: Json[], next?: string) => Json) => {
      const nodes = pages?.[index] ?? [];
      return reply(200, wrap(nodes, pages && index + 1 < pages.length ? `c${index + 1}` : undefined), cur.headers);
    };
    if (call.body.query.includes("IssueBlockers"))
      return paged(cur.blockers?.[String(call.body.variables.id)], (nodes, next) => ({ data: { issue: { inverseRelations: { pageInfo: { hasNextPage: Boolean(next), endCursor: next ?? null }, nodes } } } }));
    const type = (call.body.variables.filter as { state: { type: Json } }).state.type;
    return paged("nin" in type ? cur.open : cur.closed, page);
  };
  return { fetch, calls, orgCalls };
}
/** A Keychain that holds `key` (or nothing) and records every call; no real `security` runs. */
function fakeKeychain(key: string | null = SECRET, interactiveCode = 0) {
  const captured: string[][] = [];
  const interactive: string[][] = [];
  const runner: SecurityRunner = {
    async capture(args) {
      captured.push(args);
      if (args[0] === "find-generic-password") return key === null ? { code: 44, stdout: "" } : { code: 0, stdout: `${key}\n` };
      return { code: key === null ? 44 : 0, stdout: "" };
    },
    async interactive(args) { interactive.push(args); return { code: interactiveCode }; },
  };
  return { runner, captured, interactive };
}
const deps = (api: { fetch: FetchLike }, keychain = fakeKeychain(), clock: () => Date = () => now): LinearDeps => ({ runner: keychain.runner, fetch: api.fetch, now: clock });

async function makeRoot(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "autopilot-linear-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const planningOf = (root: string) => new PlanningStore(root).get();
async function seedCopy(root: string, syncedAt: string, issues: unknown[] = []) {
  const store = new PlanningStore(root);
  const current = await store.get();
  await store.update({
    expectedUpdatedAt: current.updatedAt,
    linear: linearImportSchema.parse({ url: "https://linear.app/example-ws/team/P/all", syncedAt, window: { from: "2026-11-09", to: "2026-11-23" }, issues }),
  });
}
const outcome = async (result: unknown) => JSON.stringify(result);

test("L1. the query follows the checked contract: fields, endpoint, page size, header and filters", async () => {
  // Field names the official docs/schema confirm (linear-api-contract.md, section 4 and the recommended query).
  const contract = new Set([
    "issues", "pageInfo", "hasNextPage", "endCursor", "nodes", "id", "identifier", "title", "url", "description", "dueDate", "priority",
    "createdAt", "updatedAt", "startedAt", "state", "name", "type", "team", "key", "children", "inverseRelations", "issue", "attachments",
  ]);
  const used = selectedFields(teamIssuesQuery);
  assert.deepEqual(used, [
    "issues", "pageInfo", "hasNextPage", "endCursor", "nodes", "id", "identifier", "title", "url", "description", "dueDate", "priority",
    "createdAt", "updatedAt", "startedAt", "state", "name", "type", "team", "key", "children", "inverseRelations", "issue", "attachments",
  ], "snapshot of the selected field names");
  for (const field of [...used, ...selectedFields(issueBlockersQuery)]) assert.ok(contract.has(field) || field === "issue" || field === "inverseRelations", `${field} is in the contract`);
  assert.deepEqual(selectedFields(issueBlockersQuery), ["issue", "inverseRelations", "pageInfo", "hasNextPage", "endCursor", "nodes", "type", "identifier", "state"]);
  // Fields the contract marks UNCONFIRMED or that were not checked are not used.
  for (const unconfirmed of [/\bteam\(/, /\bcount\b/, /\bsubIssues\b/, /\bviewer\b/, /\borganization\b/, /\bmutation\b/i])
    assert.doesNotMatch(teamIssuesQuery + issueBlockersQuery, unconfirmed);
  // The workspace lookup uses only fields the official schema confirms (linear-api-contract.md, "Workspace").
  assert.deepEqual(selectedFields(viewerOrganizationQuery), ["viewer", "organization", "id", "urlKey"]);
  assert.doesNotMatch(viewerOrganizationQuery, /mutation/i);
  assert.equal(linearEndpoint, "https://api.linear.app/graphql");
  assert.ok(pageSize >= 1 && pageSize <= 250, "first is between 1 and 250");
  assert.match(teamIssuesQuery, /first: 10\)/, "nested connections ask for ten");

  const api = fakeApi({ open: [[node(1)]], closed: [[]] });
  const result = await fetchLinearTeam(settings, deps(api));
  assert.equal(result.ok, true);
  assert.equal(api.calls.length, 2);
  assert.equal(api.orgCalls.length, 1, "the workspace is checked once, before the issues");
  assert.equal(api.orgCalls[0].headers.authorization, SECRET);
  for (const call of api.calls) {
    assert.equal(call.url, linearEndpoint);
    assert.equal(call.headers.authorization, SECRET, "a personal API key is sent as is");
    assert.doesNotMatch(call.headers.authorization, /^Bearer /i);
    assert.equal(call.body.variables.first, pageSize);
    assert.deepEqual((call.body.variables.filter as { team: unknown }).team, { key: { eq: "P" } }, "team key filter");
  }
  const types = api.calls.map(call => (call.body.variables.filter as { state: { type: Json } }).state.type);
  assert.deepEqual(types[0], { nin: ["completed", "canceled", "duplicate"] }, "open pass: every state that is not closed (triage included)");
  assert.deepEqual(types[1], { in: ["completed", "canceled", "duplicate"] }, "closed pass");
  assert.deepEqual((api.calls[1].body.variables.filter as { updatedAt: unknown }).updatedAt, { gt: "-P14D" }, "closed in the last 14 days");
  assert.equal(JSON.stringify(api.calls).includes("mutation"), false, "read only");
});

test("L2. three pages of open issues and the recent closed ones are stored completely, with states, blockers and children", async t => {
  const root = await makeRoot(t);
  await seedCopy(root, "2026-11-12T00:00:00Z"); // an older copy that will be replaced
  const open1 = Array.from({ length: 3 }, (_, i) => node(i + 1));
  const open2 = [
    node(4, {
      state: state("started", "In Progress"), priority: 1, dueDate: "2026-11-20", startedAt: "2026-11-12T01:00:00.000Z",
      description: "원문 본문 dashboard:project-abc 연결",
      children: { pageInfo: { hasNextPage: false }, nodes: [{ state: { type: "completed" } }, { state: { type: "started" } }, { state: { type: "unstarted" } }] },
      inverseRelations: { pageInfo: { hasNextPage: false }, nodes: [
        { type: "blocks", issue: { identifier: "P-1", state: { type: "started" } } },
        { type: "blocks", issue: { identifier: "P-77", state: { type: "completed" } } },
        { type: "related", issue: { identifier: "P-88", state: { type: "started" } } },
      ] },
    }),
    node(5, { state: state("triage", "Inbox"), attachments: { nodes: [{ url: "https://example.com/x" }, { url: "dashboard:linked-id" }] } }),
  ];
  const open3 = [node(6, { state: state("backlog", "Backlog") })];
  const closed = [node(7, { state: state("completed", "Done"), description: "closed text" }), node(8, { state: state("canceled", "Canceled") }), node(9, { state: state("duplicate", "Duplicate") })];
  const api = fakeApi({ open: [open1, open2, open3], closed: [closed], headers: { "x-complexity": "812" } });
  const result = await refreshLinear(root, settings, deps(api), { dryRun: false });
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.saved);
  assert.ok(result.ok && result.summary.pages === 4 && result.summary.issues === 9 && result.summary.requests === 5);
  assert.deepEqual(result.ok && result.summary.complexity, { max: 812, total: 3248 }, "X-Complexity is recorded in the summary");
  assert.deepEqual(result.ok && result.summary.byState, { unstarted: 3, started: 1, triage: 1, backlog: 1, completed: 1, canceled: 1, duplicate: 1 });
  const saved = (await planningOf(root)).linear!;
  assert.equal(saved.issues.length, 9, "every page is in the copy");
  assert.equal(saved.url, "https://linear.app/example-ws/team/P/all");
  assert.equal(saved.syncedAt, now.toISOString());
  assert.deepEqual(saved.window, { from: "2026-11-02", to: "2026-12-14" }, "14 days back, 28 ahead of today (KST)");
  const four = saved.issues.find(i => i.identifier === "P-4")!;
  assert.deepEqual(
    { state: four.state, stateName: four.stateName, priority: four.priority, dueDate: four.dueDate, blockedBy: four.blockedBy, subIssues: four.subIssues, projectId: four.projectId, description: four.description, startedAt: four.startedAt },
    { state: "started", stateName: "In Progress", priority: 1, dueDate: "2026-11-20", blockedBy: ["P-1"], subIssues: { open: 2, total: 3 }, projectId: "project-abc", description: "원문 본문 dashboard:project-abc 연결", startedAt: "2026-11-12T01:00:00.000Z" },
    "only an open `blocks` source blocks; related and completed ones do not",
  );
  assert.equal(saved.issues.find(i => i.identifier === "P-5")!.projectId, "linked-id", "dashboard:<id> in an attachment url");
  assert.equal(saved.issues.find(i => i.identifier === "P-1")!.dueDate, null, "issues without a due date are kept");
  assert.equal(saved.issues.find(i => i.identifier === "P-7")!.description, undefined, "no text is kept for closed issues");
  assert.equal(saved.issues.find(i => i.identifier === "P-9")!.state, "duplicate");
  // Both the open and the closed pass followed the cursors.
  assert.deepEqual(api.calls.map(c => c.body.variables.after ?? null), [null, "c1", "c2", null]);
});

test("L3. any gap makes the read incomplete and leaves the saved copy untouched", async t => {
  const root = await makeRoot(t);
  await seedCopy(root, "2026-11-12T00:00:00Z", [{ id: "old", identifier: "P-1", title: "Old", url: "https://linear.app/example-ws/issue/P-1", dueDate: null, state: "unstarted" }]);
  const before = JSON.stringify(await planningOf(root));
  const cases: Record<string, () => ReturnType<typeof fakeApi>> = {
    "cursor repeated": () => fakeApi({ respond: () => reply(200, page([node(1)], "same")) }),
    "hasNextPage without a cursor": () => fakeApi({ respond: () => reply(200, { data: { issues: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [node(1)] } } }) }),
    "more pages than allowed": () => fakeApi({ respond: (_c, i) => reply(200, page([node(i + 1)], `n${i}`)) }),
    "graphql errors": () => fakeApi({ respond: () => reply(200, { errors: [{ message: "Query too complex", extensions: { code: "QUERY_TOO_COMPLEX" } }], data: null }) }),
    "network failure": () => fakeApi({ respond: () => { throw new Error("socket hang up"); } }),
    "server error": () => fakeApi({ respond: () => reply(502, "<html>") }),
    "second pass fails after the first succeeded": () => fakeApi({ respond: (_c, i) => (i === 0 ? reply(200, page([node(1)])) : reply(500, {})) }),
  };
  for (const [name, make] of Object.entries(cases)) {
    const api = make();
    const result = await refreshLinear(root, settings, deps(api), { dryRun: false });
    assert.equal(result.ok, false, name);
    assert.equal(!result.ok && result.reason, "linear_incomplete", name);
    assert.equal(JSON.stringify(await planningOf(root)), before, `${name}: nothing was saved`);
  }
  assert.ok(maxPages >= 1);
  // More issues than the snapshot holds is a failure, not a truncated copy.
  const many = fakeApi({ open: [Array.from({ length: maxIssues + 1 }, (_, i) => node(i + 1))] });
  const tooMany = await refreshLinear(root, settings, deps(many), { dryRun: false });
  assert.equal(!tooMany.ok && tooMany.reason, "linear_incomplete");
  assert.equal(JSON.stringify(await planningOf(root)), before);
});

test("L4. an issue of another team or workspace fails the whole read and saves nothing", async t => {
  const root = await makeRoot(t);
  const before = JSON.stringify(await planningOf(root));
  const otherTeam = await refreshLinear(root, settings, deps(fakeApi({ open: [[node(1), node(2, { team: { key: "OTHER" } })]] })), { dryRun: false });
  assert.equal(!otherTeam.ok && otherTeam.reason, "linear_scope_mismatch");
  const otherWorkspace = await refreshLinear(root, settings, deps(fakeApi({ open: [[node(1, { url: "https://linear.app/some-company/issue/P-1/x" })]] })), { dryRun: false });
  assert.equal(!otherWorkspace.ok && otherWorkspace.reason, "linear_scope_mismatch");
  const otherPass = await refreshLinear(root, settings, deps(fakeApi({ open: [[node(1)]], closed: [[node(3, { state: state("completed"), team: { key: "ZZ" } })]] })), { dryRun: false });
  assert.equal(!otherPass.ok && otherPass.reason, "linear_scope_mismatch", "also in the recently-closed pass");
  assert.equal(JSON.stringify(await planningOf(root)), before, "no issue of another team is stored");
});

test("L5. no key, a rejected key and a rate limit fail by name; the key never shows up anywhere", async t => {
  const root = await makeRoot(t);
  const before = JSON.stringify(await planningOf(root));
  const missingApi = fakeApi({ open: [[node(1)]] });
  const keychain = fakeKeychain(null);
  const missing = await refreshLinear(root, settings, deps(missingApi, keychain), { dryRun: false });
  assert.equal(!missing.ok && missing.reason, "linear_auth_missing");
  assert.equal(missingApi.calls.length, 0, "no key, no request");
  assert.deepEqual(keychain.captured[0], ["find-generic-password", "-s", keychainService, "-a", keychainAccount, "-w"]);

  const outputs: string[] = [];
  const rejected = fakeApi({ respond: () => reply(401, { errors: [{ message: `Authentication required, not authenticated (${SECRET})`, extensions: { type: "authentication error", code: "AUTHENTICATION_ERROR", statusCode: 401 } }] }) });
  const invalid = await refreshLinear(root, settings, deps(rejected), { dryRun: false });
  assert.equal(!invalid.ok && invalid.reason, "linear_auth_invalid");
  outputs.push(await outcome(invalid));
  const forbidden = await refreshLinear(root, settings, deps(fakeApi({ respond: () => reply(403, {}) })), { dryRun: false });
  assert.equal(!forbidden.ok && forbidden.reason, "linear_auth_invalid");

  const limited = fakeApi({ respond: () => reply(429, { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] }, { "retry-after": "60" }) });
  const rate = await refreshLinear(root, settings, deps(limited), { dryRun: false });
  assert.equal(!rate.ok && rate.reason, "linear_rate_limited");
  assert.equal(limited.calls.length, 1, "a rate limit is not retried");
  assert.match((!rate.ok && rate.detail) || "", /Retry-After 60s/);
  const limitedByBody = await refreshLinear(root, settings, deps(fakeApi({ respond: () => reply(200, { errors: [{ message: "x", extensions: { code: "RATELIMITED" } }] }) })), { dryRun: false });
  assert.equal(!limitedByBody.ok && limitedByBody.reason, "linear_rate_limited");

  // A thrown network error that quotes the header is masked in the result.
  const leaky = fakeApi({ respond: () => { throw new Error(`fetch failed: authorization: ${SECRET}`); } });
  const leaked = await refreshLinear(root, settings, deps(leaky), { dryRun: false });
  assert.equal(!leaked.ok && leaked.reason, "linear_incomplete");
  outputs.push(await outcome(leaked), await outcome(missing), await outcome(rate));
  for (const text of outputs) assert.equal(text.includes(SECRET), false, "no output carries the key");
  assert.equal((await readFile(path.join(root, "planning.json"), "utf8").catch(() => "")).includes(SECRET), false);
  assert.equal(JSON.stringify([keychain.captured, keychain.interactive]).includes(SECRET), false, "the key is never in an argument list");
  assert.equal(maskSecrets(`x ${SECRET} y`), "x [redacted] y");
  assert.equal(maskSecrets("abc secret-value def", "secret-value"), "abc [redacted] def");
  assert.equal(JSON.stringify(await planningOf(root)), before);
});

test("L6. states map to the planning values and the queue kinds; nested pages never hide a blocker or invent a count", async t => {
  const root = await makeRoot(t);
  const api = fakeApi({
    open: [[
      node(1, { state: state("triage", "Inbox") }),
      node(2, { state: state("started", "In Review") }),
      node(3, { state: state("started", "In Progress") }),
      node(4, { state: state("backlog", "Backlog") }),
      node(5, { state: state("unstarted", "Todo"), dueDate: "2026-11-30" }),
      // More than ten inverse relations: the first page is not trusted, the issue is refetched in full.
      node(6, {
        state: state("started", "In Progress"),
        inverseRelations: { pageInfo: { hasNextPage: true }, nodes: [{ type: "blocks", issue: { identifier: "P-70", state: { type: "completed" } } }] },
        children: { pageInfo: { hasNextPage: true }, nodes: [{ state: { type: "started" } }] },
      }),
    ]],
    closed: [[node(7, { state: state("completed", "Done") }), node(8, { state: state("canceled", "Canceled") }), node(9, { state: state("duplicate", "Duplicate") })]],
    blockers: { "uuid-6": [[{ type: "blocks", issue: { identifier: "P-70", state: { type: "completed" } } }], [{ type: "blocks", issue: { identifier: "P-71", state: { type: "unstarted" } } }]] },
  });
  assert.equal((await refreshLinear(root, settings, deps(api), { dryRun: false })).ok, true);
  const issues = (await planningOf(root)).linear!.issues;
  const by = (n: number) => issues.find(i => i.identifier === `P-${n}`)!;
  const kinds = Object.fromEntries(issues.map(i => [i.identifier, classifyLinear(i)]));
  assert.deepEqual(kinds, { "P-1": "review", "P-2": "review", "P-3": "active", "P-4": "candidate", "P-5": "candidate", "P-6": "active", "P-7": "ignore", "P-8": "ignore", "P-9": "ignore" });
  assert.deepEqual([by(1).state, by(1).stateName], ["triage", "Inbox"]);
  assert.equal(by(5).dueDate, "2026-11-30");
  assert.equal(by(4).dueDate, null);
  assert.deepEqual(by(6).blockedBy, ["P-71"], "the blocker on the second page of the refetch is found");
  assert.equal(by(6).subIssues, undefined, "a children page with more to come gives no honest count");
  const refetches = api.calls.filter(c => c.body.query.includes("IssueBlockers"));
  assert.equal(refetches.length, 2);
  assert.ok(refetches.every(c => c.body.variables.id === "uuid-6"));
  // The saved copy parses with the planning schema (a Dashboard link or the calendar would read it).
  assert.equal(linearImportSchema.safeParse((await planningOf(root)).linear).success, true);
});

test("L7. dry run saves nothing; a revision conflict rereads once; a newer copy is not overwritten", async t => {
  const root = await makeRoot(t);
  const api = () => fakeApi({ open: [[node(1)]], closed: [[]] });
  const dry = await refreshLinear(root, settings, deps(api()), { dryRun: true });
  assert.ok(dry.ok && !dry.saved);
  assert.equal((await planningOf(root)).linear, null);

  // The planning file changes between this refresh's read of the revision and its write (a connector sync):
  // the write is refused as stale, the refresh reads the revision again once and succeeds.
  await seedCopy(root, "2026-11-10T00:00:00Z");
  const original = PlanningStore.prototype.update;
  let injected = false;
  PlanningStore.prototype.update = function (this: PlanningStore, value: unknown) {
    if (injected) return original.call(this, value);
    injected = true;
    return this.get().then(current => original.call(this, { expectedUpdatedAt: current.updatedAt, weeklyTarget: 4 })).then(() => original.call(this, value));
  };
  try {
    const retried = await refreshLinear(root, settings, deps(api()), { dryRun: false });
    assert.ok(retried.ok && retried.saved);
  } finally { PlanningStore.prototype.update = original; }
  assert.equal(injected, true);
  assert.equal((await planningOf(root)).weeklyTarget, 4, "the concurrent change is kept");
  assert.equal((await planningOf(root)).linear!.issues.length, 1);

  // A connector sync that is already newer than this read wins.
  await seedCopy(root, "2026-11-16T09:00:00Z");
  const older = await refreshLinear(root, settings, deps(api(), fakeKeychain(), () => new Date("2026-11-16T06:00:00Z")), { dryRun: false });
  assert.ok(older.ok && !older.saved);
  assert.equal((await planningOf(root)).linear!.syncedAt, "2026-11-16T09:00:00Z");
});

// ---------------------------------------------------------------------------------------------
// Tick, config and commands through the injected Keychain and fetch.

function fakeDeps(api: { fetch: FetchLike }, keychain = fakeKeychain(), clock: { at: Date } = { at: now }) {
  const launches: { runId: string; token: string }[] = [];
  const models: ModelRun[] = [];
  const out: AutopilotDeps = {
    now: () => clock.at,
    isAlive: pid => pid === process.pid,
    processStart: pid => (pid === process.pid ? "T0" : undefined),
    newId: randomUUID,
    async launch(run) { launches.push(run); return { pid: process.pid }; },
    async runModel(run): Promise<RunOutput> { models.push(run); return { code: 0, stdout: "", stderr: "" }; },
    linear: { runner: keychain.runner, fetch: api.fetch },
  };
  return { deps: out, launches, models, keychain };
}
const context = (root: string, extra: Partial<AutopilotContext> = {}): AutopilotContext => ({ root, env: { REELS_USER_DATA: root }, script: "/unused/reels.mjs", ...extra });
async function writeConfig(root: string, value: Json) {
  await mkdir(path.join(root, "autopilot"), { recursive: true });
  await writeFile(path.join(root, "autopilot", "config.json"), JSON.stringify(value));
}
const candidates = (count: number) => Array.from({ length: count }, (_, i) => node(i + 1));

test("L8. config: the team and workspace default to P and rosy-trip2 and can be set; the refresh reads that team", async t => {
  assert.deepEqual(defaultAutopilotConfig().linear, { teamKey: "P", workspaceUrlKey: "rosy-trip2" });
  assert.equal(autopilotConfigSchema.safeParse({ ...defaultAutopilotConfig(), linear: { teamKey: "a b" } }).success, false);
  const root = await makeRoot(t);
  await writeConfig(root, { linear: { teamKey: "Q" } });
  const config = await new AutopilotStore(root).readConfig();
  assert.deepEqual(config.linear, { teamKey: "Q", workspaceUrlKey: "rosy-trip2" }, "a partial linear block keeps the other default");
  await writeConfig(root, { linear: { teamKey: "Q", workspaceUrlKey: "example-ws" } });
  const api = fakeApi({ open: [[node(1, { team: { key: "Q" }, url: "https://linear.app/example-ws/issue/Q-1/x" })]], closed: [[]] });
  const { deps: d } = fakeDeps(api);
  const result = await autopilotCommand(["refresh-linear", "--dry-run"], context(root), {}, d);
  assert.equal((result.data as { issues: number }).issues, 1);
  assert.deepEqual(api.calls[0].body.variables.filter && (api.calls[0].body.variables.filter as { team: unknown }).team, { key: { eq: "Q" } });
});

test("L9. a tick refreshes a stale copy first and goes on; a failed refresh means zero automatic runs and a kept reason", async t => {
  const root = await makeRoot(t);
  await writeConfig(root, { linear: { teamKey: "P", workspaceUrlKey: "example-ws" } });
  await seedCopy(root, "2026-11-16T01:00:00Z"); // 4 hours old: stale and past half of 180 minutes
  const ok = fakeDeps(fakeApi({ open: [candidates(2)], closed: [[]] }));
  const done = await tick(context(root), { dryRun: false, now }, ok.deps);
  assert.equal(done.admitted, 2);
  assert.equal(ok.launches.length, 1);
  assert.equal((done.refresh as { issues: number }).issues, 2, "the summary says how many issues were read");
  assert.equal((await planningOf(root)).linear!.syncedAt, now.toISOString());

  // 401: nothing starts and the reason names the code and the way out, not the key.
  const root2 = await makeRoot(t);
  await writeConfig(root2, { linear: { teamKey: "P", workspaceUrlKey: "example-ws" } });
  await seedCopy(root2, "2026-11-16T01:00:00Z");
  const rejected = fakeDeps(fakeApi({ respond: () => reply(401, { errors: [{ message: "nope", extensions: { code: "AUTHENTICATION_ERROR" } }] }) }));
  const blocked = await tick(context(root2), { dryRun: false, now }, rejected.deps);
  assert.equal(blocked.result, "freshness");
  assert.equal(blocked.admitted, 0);
  assert.match(blocked.reason as string, /linear_auth_invalid/);
  assert.equal(rejected.launches.length, 0);
  assert.equal(rejected.models.length, 0);
  const last = (await new AutopilotStore(root2).readState()).lastTick;
  assert.match(last?.reason ?? "", /linear_auth_invalid/);
  assert.equal(JSON.stringify(last).includes(SECRET), false);

  // No key at all: auth missing, and the reason says a connector re-auth does not renew the copy by itself.
  const root3 = await makeRoot(t);
  await seedCopy(root3, "2026-11-16T01:00:00Z");
  const nokey = fakeDeps(fakeApi(), fakeKeychain(null));
  const none = await tick(context(root3), { dryRun: false, now }, nokey.deps);
  assert.equal(none.admitted, 0);
  assert.match(none.reason as string, /linear_auth_missing/);
  assert.match(none.reason as string, /connect-linear/);

  // A copy younger than half of staleAfterMinutes is not read again.
  const root4 = await makeRoot(t);
  await seedCopy(root4, "2026-11-16T04:00:00Z"); // 60 minutes old, half is 90
  const api4 = fakeApi({ open: [candidates(1)], closed: [[]] });
  const fresh = fakeDeps(api4);
  const used = await tick(context(root4), { dryRun: false, now }, fresh.deps);
  assert.equal(api4.calls.length, 0, "no API call while the copy is young");
  assert.equal(used.admitted, 0, "(the young copy has no issues)");
});

test("L9b. overnight ticks renew Linear without admitting work, and retain the age throttle", async t => {
  const root = await makeRoot(t);
  const night = new Date("2026-11-16T12:00:00Z"); // 21:00 KST, outside dispatch hours
  const clock = { at: night };
  await writeConfig(root, { linear: settings });
  await seedCopy(root, "2026-11-16T01:00:00Z");
  const store = new AutopilotStore(root);
  await store.writeState({ ...await store.readState(), todayDate: "2026-11-16" });
  const api = fakeApi({ open: [candidates(2)], closed: [[]] });
  const f = fakeDeps(api, fakeKeychain(), clock);
  const first = await tick(context(root), { dryRun: false, now: night }, f.deps);
  assert.equal(first.result, "outside_hours");
  assert.equal((first.refresh as { refreshed: boolean }).refreshed, true);
  assert.equal(first.modelCalls, 0); assert.equal(first.admitted, 0);
  assert.equal(f.launches.length, 0); assert.equal(f.models.length, 0);
  assert.equal((await planningOf(root)).linear!.syncedAt, night.toISOString());
  const calls = api.calls.length + api.orgCalls.length;
  assert.ok(calls > 0);
  clock.at = new Date(night.getTime() + 30 * 60_000);
  const second = await tick(context(root), { dryRun: false, now: clock.at }, f.deps);
  assert.equal(second.result, "outside_hours");
  assert.equal(api.calls.length + api.orgCalls.length, calls, "a young copy does not cause another API read");
  assert.equal(f.launches.length, 0);

  // Early morning also refreshes; no off-work report is due yet and no model is admitted.
  clock.at = new Date("2026-11-16T21:00:00Z"); // next day 06:00 KST
  const morning = await tick(context(root), { dryRun: false, now: clock.at }, f.deps);
  assert.equal(morning.result, "outside_hours");
  assert.equal((await planningOf(root)).linear!.syncedAt, clock.at.toISOString());
  assert.equal(f.launches.length, 0); assert.equal(f.models.length, 0);
});

test("L9c. overnight refresh preserves dry-run, disabled/pause and failure behavior", async t => {
  const night = new Date("2026-11-16T12:00:00Z");
  for (const gate of ["dry", "disabled", "paused"] as const) {
    const root = await makeRoot(t);
    await writeConfig(root, { linear: settings, ...(gate === "disabled" ? { enabled: false } : {}) });
    await seedCopy(root, "2026-11-16T01:00:00Z");
    const store = new AutopilotStore(root);
    await store.writeState({ ...await store.readState(), todayDate: "2026-11-16", ...(gate === "paused" ? { paused: { at: night.toISOString(), reason: "user pause" } } : {}) });
    const before = await planningOf(root);
    const api = fakeApi({ open: [candidates(2)], closed: [[]] });
    const f = fakeDeps(api, fakeKeychain(), { at: night });
    await tick(context(root), { dryRun: gate === "dry", now: night }, f.deps);
    assert.equal(api.calls.length + api.orgCalls.length, 0, gate);
    assert.deepEqual(await planningOf(root), before, gate);
    assert.equal(f.launches.length, 0, gate); assert.equal(f.models.length, 0, gate);
  }
  const root = await makeRoot(t);
  await writeConfig(root, { linear: settings });
  await seedCopy(root, "2026-11-16T01:00:00Z");
  const f = fakeDeps(fakeApi({ org: () => reply(401, {}) }), fakeKeychain(), { at: night });
  const failed = await tick(context(root), { dryRun: false, now: night }, f.deps);
  assert.equal(failed.result, "freshness"); assert.equal(failed.admitted, 0);
  assert.match(failed.reason as string, /linear_auth_invalid/);
  assert.equal((await planningOf(root)).linear!.syncedAt, "2026-11-16T01:00:00Z");
  assert.equal(f.launches.length, 0); assert.equal(f.models.length, 0);
});

test("L10. a refresh with the same content only moves syncedAt: the next tick is unchanged and starts nothing", async t => {
  const root = await makeRoot(t);
  await writeConfig(root, { linear: { teamKey: "P", workspaceUrlKey: "example-ws" } });
  await seedCopy(root, "2026-11-16T01:00:00Z");
  const clock = { at: now };
  const api = fakeApi({ open: [candidates(2)], closed: [[]] });
  const first = fakeDeps(api, fakeKeychain(), clock);
  const a = await tick(context(root), { dryRun: false, now }, first.deps);
  assert.equal(a.admitted, 2);
  const later = new Date(now.getTime() + 100 * 60_000); // past half of the stale limit, the copy is read again
  clock.at = later;
  const b = await tick(context(root), { dryRun: false, now: later }, first.deps);
  assert.equal((await planningOf(root)).linear!.syncedAt, later.toISOString(), "the copy was refreshed");
  assert.equal(b.result, "unchanged");
  assert.equal(b.admitted, 0);
  assert.equal(first.launches.length, 1, "one executor in total");
  assert.equal(first.models.length, 0);
});

test("L11. connect-linear is terminal-only and hands the secret to macOS: -w is last, no value, no key anywhere", async t => {
  const root = await makeRoot(t);
  const before = JSON.stringify(await planningOf(root));
  const api = fakeApi({ open: [[node(1), node(2, { state: state("triage", "Inbox") })]], closed: [[]] });
  const f = fakeDeps(api, fakeKeychain(SECRET));
  await writeConfig(root, { linear: { teamKey: "P", workspaceUrlKey: "example-ws" } });

  // Not a terminal: refused, nothing run, nothing stored.
  await assert.rejects(autopilotCommand(["connect-linear"], context(root, { interactive: false }), {}, f.deps), (error: unknown) => error instanceof CliError && error.code === "USAGE" && /터미널/.test(error.message));
  assert.equal(f.keychain.interactive.length + f.keychain.captured.length, 0);
  assert.equal(api.calls.length, 0);

  const connected = await autopilotCommand(["connect-linear"], context(root, { interactive: true }), {}, f.deps);
  assert.equal(f.keychain.interactive.length, 1);
  const args = f.keychain.interactive[0];
  assert.deepEqual(args, ["add-generic-password", "-U", "-s", "reels-dashboard-linear", "-a", "linear", "-w"]);
  assert.equal(args[args.length - 1], "-w", "-w is the last argument");
  assert.equal(args.filter(a => a === "-w").length, 1);
  assert.equal(args.some(a => a.includes("lin_")), false, "no value follows -w");
  // The key is checked with a dry run that reports counts only, and saves nothing.
  const data = connected.data as { connected: boolean; verified: boolean; issues: number; byState: Json };
  assert.deepEqual([data.connected, data.verified, data.issues, data.byState], [true, true, 2, { unstarted: 1, triage: 1 }]);
  assert.equal(JSON.stringify(connected).includes(SECRET), false);
  assert.equal(JSON.stringify(connected).includes("Synthetic"), false, "no issue titles");
  assert.equal(JSON.stringify(await planningOf(root)), before, "the verification does not save the copy");
  assert.equal(JSON.stringify([f.keychain.captured, f.keychain.interactive]).includes(SECRET), false);

  // The terminal step fails: stored nothing, said so, no verification request.
  const api2 = fakeApi({ open: [[node(1)]] });
  const bad = fakeDeps(api2, fakeKeychain(SECRET, 51));
  await assert.rejects(autopilotCommand(["connect-linear"], context(root, { interactive: true }), {}, bad.deps), (error: unknown) => error instanceof CliError && error.code === "LINEAR_KEYCHAIN_FAILED");
  assert.equal(api2.calls.length, 0);
  // The key was stored but Linear rejects it: a failure that says the key is stored.
  const rejected = fakeDeps(fakeApi({ respond: () => reply(401, { errors: [{ message: "x", extensions: { code: "AUTHENTICATION_ERROR" } }] }) }));
  await assert.rejects(autopilotCommand(["connect-linear"], context(root, { interactive: true }), {}, rejected.deps), (error: unknown) => error instanceof CliError && error.code === "LINEAR_AUTH_INVALID" && /키는 저장했지만/.test(error.message));
});

test("L12. disconnect-linear deletes only this tool's Keychain item", async t => {
  const root = await makeRoot(t);
  const f = fakeDeps(fakeApi(), fakeKeychain(SECRET));
  const gone = await autopilotCommand(["disconnect-linear"], context(root), {}, f.deps);
  assert.deepEqual(f.keychain.captured, [["delete-generic-password", "-s", "reels-dashboard-linear", "-a", "linear"]]);
  assert.deepEqual(gone.data, { disconnected: true, service: "reels-dashboard-linear", account: "linear" });
  const empty = fakeDeps(fakeApi(), fakeKeychain(null));
  const none = await autopilotCommand(["disconnect-linear"], context(root), {}, empty.deps);
  assert.deepEqual((none.data as { disconnected: boolean; reason: string }).reason, "not_found");
});

test("L13. refresh-linear prints counts and states, saves unless --dry-run, and a failure exits non-zero with its code", async t => {
  const root = await makeRoot(t);
  await writeConfig(root, { linear: { teamKey: "P", workspaceUrlKey: "example-ws" } });
  const api = fakeApi({ open: [candidates(3)], closed: [[node(9, { state: state("completed") })]], headers: { "x-complexity": "500" } });
  const f = fakeDeps(api);
  const scope: { readOnly?: boolean } = {};
  const dry = await autopilotCommand(["refresh-linear", "--dry-run"], context(root), scope, f.deps);
  assert.equal(scope.readOnly, true);
  assert.equal((await planningOf(root)).linear, null);
  const dryData = dry.data as Json;
  assert.deepEqual([dryData.saved, dryData.issues, dryData.pages, dryData.syncedAt], [false, 4, 2, now.toISOString()]);
  assert.deepEqual(dryData.byState, { unstarted: 3, completed: 1 });
  assert.deepEqual(dryData.complexity, { max: 500, total: 1000 });
  assert.equal(JSON.stringify(dry).includes("Synthetic"), false, "no titles in the output");
  const real = await autopilotCommand(["refresh-linear"], context(root), {}, f.deps);
  assert.equal((real.data as Json).saved, true);
  assert.equal((await planningOf(root)).linear!.issues.length, 4);

  // Through the CLI entry point: a failure document carries the code and a non-zero exit; the key is not in it.
  const failing = fakeDeps(fakeApi({ respond: () => reply(429, { errors: [{ message: "slow", extensions: { code: "RATELIMITED" } }] }) }));
  await assert.rejects(autopilotCommand(["refresh-linear"], context(root), {}, failing.deps), (error: unknown) => error instanceof CliError && error.code === "LINEAR_RATE_LIMITED" && error.details.retry === "wait" && error.details.exitCode === 4);
  let text = "";
  const code = await runCli(["autopilot", "connect-linear"], { stdin: () => Readable.from([]), stdout: s => { text += s; }, stderr: () => {}, env: { REELS_USER_DATA: root }, cwd: () => root });
  assert.equal(code, 2, "not a terminal: nothing is asked or stored");
  assert.equal(JSON.parse(text).error.code, "USAGE");
  let helpText = "";
  await runCli(["help", "autopilot"], { stdin: () => Readable.from([]), stdout: s => { helpText += s; }, stderr: () => {}, env: { REELS_USER_DATA: root }, cwd: () => root });
  assert.match(JSON.parse(helpText).data.help, /connect-linear[\s\S]*disconnect-linear[\s\S]*refresh-linear/);
});

test("L14. the stored copy is read through the LocalStore-independent snapshot the card computes from", async t => {
  // The renderer card reads the same view as the CLI; here only the saved copy and an empty Dashboard feed it.
  const root = await makeRoot(t);
  await refreshLinear(root, settings, deps(fakeApi({ open: [[node(1, { state: state("triage", "Inbox") }), node(2, { state: state("started", "In Progress") })]], closed: [[]] })), { dryRun: false });
  await new LocalStore(root).save({ schemaVersion: 1, projects: [], updatedAt: "2026-11-16T00:00:00.000Z" });
  const { computeAutopilotView, emptyAutopilotState } = await import("../../src/shared/autopilot");
  const view = computeAutopilotView({ planning: await planningOf(root), projects: (await new LocalStore(root).load()).projects, state: emptyAutopilotState(), config: defaultAutopilotConfig(), now, probe: () => false });
  assert.equal(view.today?.kind, "review");
  assert.deepEqual([view.counts.review, view.counts.active, view.counts.occupancy], [1, 1, 1]);
});

// ---------------------------------------------------------------------------------------------
// H3: the workspace of the key is checked before any issue is read.

test("L15. a key of another workspace fails closed, also for an empty team; the right workspace with no issues is a clean empty queue", async t => {
  const root = await makeRoot(t);
  await seedCopy(root, "2026-11-12T00:00:00Z", [{ id: "old", identifier: "P-1", title: "Old", url: "https://linear.app/example-ws/issue/P-1", dueDate: null, state: "unstarted" }]);
  const before = JSON.stringify(await planningOf(root));
  // A team `P` of another workspace that has no issues at all: without the organization check this would look like success.
  const wrong = fakeApi({ org: "other-company", open: [[]], closed: [[]] });
  const refused = await refreshLinear(root, settings, deps(wrong), { dryRun: false });
  assert.equal(!refused.ok && refused.reason, "linear_workspace_mismatch");
  assert.match((!refused.ok && refused.detail) || "", /other-company/);
  assert.equal(wrong.calls.length, 0, "no issue is read once the workspace is wrong");
  assert.equal(JSON.stringify(await planningOf(root)), before, "nothing is saved");
  assert.match(linearFailureHint.linear_workspace_mismatch, /workspaceUrlKey/);
  // The correct workspace with zero issues: the organization and the team both passed, so an empty queue is a success.
  const right = fakeApi({ open: [[]], closed: [[]] });
  const empty = await refreshLinear(root, settings, deps(right), { dryRun: false });
  assert.ok(empty.ok && empty.saved && empty.summary.issues === 0);
  assert.equal(right.orgCalls.length, 1);
  assert.deepEqual((await planningOf(root)).linear!.issues, []);
  // The organization lookup that cannot be read fails closed too, and a rejected key stays an auth failure.
  const unreadable = await refreshLinear(root, settings, deps(fakeApi({ org: () => reply(200, { data: { viewer: null } }) })), { dryRun: false });
  assert.equal(!unreadable.ok && unreadable.reason, "linear_invalid_response");
  const rejected = await refreshLinear(root, settings, deps(fakeApi({ org: () => reply(401, { errors: [{ message: "x", extensions: { code: "AUTHENTICATION_ERROR" } }] }) })), { dryRun: false });
  assert.equal(!rejected.ok && rejected.reason, "linear_auth_invalid");
  // A tick with such a key starts nothing and names the reason.
  const rootTick = await makeRoot(t);
  await writeConfig(rootTick, { linear: { teamKey: "P", workspaceUrlKey: "example-ws" } });
  await seedCopy(rootTick, "2026-11-16T01:00:00Z");
  const f = fakeDeps(fakeApi({ org: "other-company", open: [candidates(2)], closed: [[]] }));
  const blocked = await tick(context(rootTick), { dryRun: false, now }, f.deps);
  assert.equal(blocked.admitted, 0);
  assert.match(blocked.reason as string, /linear_workspace_mismatch/);
  assert.equal(f.launches.length + f.models.length, 0);
});

// ---------------------------------------------------------------------------------------------
// I: a strict look at Linear right before reserving and right before the model starts.

const cachedIssue = (n: number, type = "unstarted", name?: string) => ({
  id: `uuid-${n}`, identifier: `P-${n}`, title: `Synthetic issue ${n}`, url: `https://linear.app/example-ws/issue/P-${n}/x`, dueDate: null, state: type, ...(name ? { stateName: name } : {}),
});
const inboxNode = (n: number) => node(n, { state: state("triage", "Inbox") });
const waiting = (count: number) => Array.from({ length: count }, (_, i) => inboxNode(101 + i));
const cachedWaiting = (count: number) => Array.from({ length: count }, (_, i) => cachedIssue(101 + i, "triage", "Inbox"));
const todo = [1, 2, 3].map(n => node(n));
const cachedTodo = [1, 2, 3].map(n => cachedIssue(n));
async function strictRoot(t: test.TestContext, cached: number, extraConfig: Json = {}) {
  const root = await makeRoot(t);
  await writeConfig(root, { linear: { teamKey: "P", workspaceUrlKey: "example-ws" }, execution: { workdir: root }, ...extraConfig });
  await seedCopy(root, "2026-11-16T04:30:00Z", [...cachedWaiting(cached), ...cachedTodo]);
  return root;
}
const stateOf = (root: string) => new AutopilotStore(root).readState();

test("L16. I(a): the cache says 2 waiting, the API says 3: the tick reserves nothing and calls no model; with 2 it reserves 1", async t => {
  const root = await strictRoot(t, 2);
  const api = fakeApi({ open: [[...waiting(3), ...todo]], closed: [[]] });
  const f = fakeDeps(api);
  const result = await tick(context(root), { dryRun: false, now }, f.deps);
  assert.equal(result.admitted, 0);
  assert.equal(result.result, "queue_full", "decided from the API's occupancy, not the cache's");
  assert.equal(result.modelCalls, 0);
  assert.equal(f.launches.length + f.models.length, 0);
  assert.equal(api.orgCalls.length, 1, "it did ask the API right before reserving");
  assert.equal((await stateOf(root)).reservations.length, 0);
  assert.equal((await planningOf(root)).linear!.issues.filter(i => i.state === "triage").length, 3, "the new answer was saved as the copy");
  // Control: the API agrees with the cache (2 waiting), so exactly one slot is reserved.
  const same = await strictRoot(t, 2);
  const ok = fakeDeps(fakeApi({ open: [[...waiting(2), ...todo]], closed: [[]] }));
  const reserved = await tick(context(same), { dryRun: false, now }, ok.deps);
  assert.equal(reserved.admitted, 1);
  assert.equal((reserved.recheck as { ok: boolean }).ok, true);
  assert.equal(ok.launches.length, 1);
  // The Dashboard is read again too: a review card that appears while the API is being asked counts as well.
  const board = await strictRoot(t, 2);
  const b = fakeDeps(fakeApi({
    open: [[...waiting(2), ...todo]], closed: [[]],
    org: async () => {
      await new LocalStore(board).save({ schemaVersion: 1, updatedAt: "2026-11-16T00:00:00.000Z", projects: [{ id: "p-review", title: "Synthetic review card", date: "2026-11-10", nextAction: "", stage: "review", publicURL: "", shared: false }] });
      return reply(200, { data: { viewer: { organization: { id: "o", urlKey: "example-ws" } } } });
    },
  }));
  const withCard = await tick(context(board), { dryRun: false, now }, b.deps);
  assert.equal(withCard.result, "queue_full", "2 Linear + 1 Dashboard review = 3");
  assert.equal(b.launches.length, 0);
});

test("L17. I(b): after a successful reservation, a full queue at the start removes the reservation and never calls the model", async t => {
  const root = await strictRoot(t, 2);
  let waitingNow = 2;
  const api = fakeApi({ live: () => ({ open: [[...waiting(waitingNow), ...todo]], closed: [[]] }) });
  const f = fakeDeps(api);
  const ticked = await tick(context(root), { dryRun: false, now }, f.deps);
  assert.equal(ticked.admitted, 1);
  const reservation = (await stateOf(root)).reservations[0];
  assert.equal(reservation.status, "running");
  waitingNow = 3; // a third review appeared between the tick and the executor
  const calls = api.orgCalls.length;
  const done = (await execute(context(root, { env: { REELS_USER_DATA: root, REELS_AUTOPILOT_RUN_TOKEN: reservation.token } }), reservation.runId!, f.deps)) as { started: boolean; modelCalls: number; removed: { reason: string }[] };
  assert.equal(api.orgCalls.length, calls + 1, "the executor asked the API itself");
  assert.deepEqual([done.started, done.modelCalls, done.removed.map(r => r.reason)], [false, 0, ["queue_full_at_start"]]);
  assert.equal(f.models.length, 0);
  assert.equal((await stateOf(root)).reservations.length, 0);
  const record = JSON.parse(await readFile(path.join(new AutopilotStore(root).runDir(reservation.runId!), "recheck.json"), "utf8"));
  assert.deepEqual([record.mode, record.occupancy, record.enforced, record.lookup.ok], ["auto", 3, true, true]);
});

test("L18. I(c): a failed, incomplete or unauthenticated lookup means zero automatic runs, with the reason kept", async t => {
  const failures: [string, () => ReturnType<typeof fakeApi>, ReturnType<typeof fakeKeychain>, RegExp][] = [
    ["network", () => fakeApi({ respond: () => { throw new Error("socket hang up"); }, open: [todo] }), fakeKeychain(), /linear_incomplete/],
    ["graphql errors", () => fakeApi({ respond: () => reply(200, { errors: [{ message: "x" }], data: null }) }), fakeKeychain(), /linear_incomplete/],
    ["rejected key", () => fakeApi({ org: () => reply(401, { errors: [{ message: "x", extensions: { code: "AUTHENTICATION_ERROR" } }] }) }), fakeKeychain(), /linear_auth_invalid/],
    ["no key", () => fakeApi({ open: [todo], closed: [[]] }), fakeKeychain(null), /linear_auth_missing/],
    ["wrong workspace", () => fakeApi({ org: "other-company" }), fakeKeychain(), /linear_workspace_mismatch/],
  ];
  for (const [name, api, keychain, reason] of failures) {
    const root = await strictRoot(t, 0);
    const f = fakeDeps(api(), keychain);
    const result = await tick(context(root), { dryRun: false, now }, f.deps);
    assert.equal(result.admitted, 0, name);
    assert.equal(result.result, "freshness", name);
    assert.match(result.reason as string, reason, name);
    assert.match(result.reason as string, /예약 직전/, name);
    assert.equal(f.launches.length + f.models.length, 0, name);
    assert.match((await stateOf(root)).lastTick?.reason ?? "", reason, `${name}: the reason is kept`);
    assert.equal((await stateOf(root)).reservations.length, 0, name);
    assert.equal(JSON.stringify(await stateOf(root)).includes(SECRET), false, name);
  }
  // The same failure just before the model starts: the reservation is taken back and nothing is called.
  const root = await strictRoot(t, 0);
  let broken = false;
  const api = fakeApi({ live: () => ({ open: [todo], closed: [[]], org: broken ? () => reply(200, { errors: [{ message: "x" }], data: null }) : undefined }) });
  const f = fakeDeps(api);
  assert.equal((await tick(context(root), { dryRun: false, now }, f.deps)).admitted, 3);
  const [first] = (await stateOf(root)).reservations;
  broken = true;
  const done = (await execute(context(root, { env: { REELS_USER_DATA: root, REELS_AUTOPILOT_RUN_TOKEN: first.token } }), first.runId!, f.deps)) as { started: boolean; modelCalls: number; removed: { reason: string }[]; recheck: { ok: boolean; reason: string } };
  assert.deepEqual([done.started, done.modelCalls], [false, 0]);
  assert.deepEqual(done.removed.map(r => r.reason), ["linear_unavailable_at_start", "linear_unavailable_at_start", "linear_unavailable_at_start"]);
  assert.deepEqual([done.recheck.ok, done.recheck.reason], [false, "linear_incomplete"]);
  assert.equal(f.models.length, 0);
});

test("L19. I(d): a manual run is never stopped by the occupancy or a failed lookup, and the lookup's result is written down", async t => {
  const root = await strictRoot(t, 0);
  let phase: "four" | "down" = "four";
  const api = fakeApi({ live: () => (phase === "four"
    ? { open: [[...waiting(4), ...todo]], closed: [[]] }
    : { open: [todo], closed: [[]], org: () => { throw new Error("offline"); } }) });
  const f = fakeDeps(api);
  await refreshLinear(root, { teamKey: "P", workspaceUrlKey: "example-ws" }, deps(api), { dryRun: false });
  const planningSeen = await planningOf(root);
  assert.equal(planningSeen.linear!.issues.filter(i => i.state === "triage").length, 4);
  const manual = (await runManual(context(root), ["linear:uuid-1"], f.deps)) as { runId: string };
  const reservation = (await stateOf(root)).reservations[0];
  assert.equal(reservation.mode, "manual");
  const env = { env: { REELS_USER_DATA: root, REELS_AUTOPILOT_RUN_TOKEN: reservation.token } };
  const done = (await execute(context(root, env), manual.runId, f.deps)) as { started: boolean; modelCalls: number; removed: unknown[] };
  assert.deepEqual([done.started, done.modelCalls, done.removed], [true, 1, []], "4 waiting does not stop a manual run");
  assert.equal(f.models.length, 1);
  const dir = new AutopilotStore(root).runDir(manual.runId);
  const ok = JSON.parse(await readFile(path.join(dir, "recheck.json"), "utf8"));
  assert.deepEqual([ok.mode, ok.occupancy, ok.enforced, ok.lookup.ok], ["manual", 4, false, true]);
  // The lookup fails: the manual run still goes on, and the failure is on record.
  phase = "down";
  const again = (await runManual(context(root), ["linear:uuid-2"], f.deps)) as { runId: string };
  const second = (await stateOf(root)).reservations.find(r => r.key === "linear:uuid-2")!;
  const result = (await execute(context(root, { env: { REELS_USER_DATA: root, REELS_AUTOPILOT_RUN_TOKEN: second.token } }), again.runId, f.deps)) as { started: boolean; recheck: { ok: boolean; reason: string } };
  assert.deepEqual([result.started, result.recheck.ok, result.recheck.reason], [true, false, "linear_incomplete"]);
  assert.equal(f.models.length, 2);
  const failed = JSON.parse(await readFile(path.join(new AutopilotStore(root).runDir(again.runId), "recheck.json"), "utf8"));
  assert.deepEqual([failed.mode, failed.lookup.ok, failed.lookup.reason, failed.enforced], ["manual", false, "linear_incomplete", false]);
});

test("L20. I(e): a cache that is already full ends the tick without any API call; so does unchanged input", async t => {
  const root = await strictRoot(t, 3);
  const api = fakeApi({ open: [[...waiting(3), ...todo]], closed: [[]] });
  const f = fakeDeps(api);
  const full = await tick(context(root), { dryRun: false, now }, f.deps);
  assert.equal(full.result, "queue_full");
  assert.equal(api.calls.length + api.orgCalls.length, 0, "no request at all");
  assert.equal(f.launches.length + f.models.length, 0);
  // After one reservation, an unchanged tick makes no request either.
  const ok = await strictRoot(t, 2);
  const api2 = fakeApi({ open: [[...waiting(2), ...todo]], closed: [[]] });
  const g = fakeDeps(api2);
  assert.equal((await tick(context(ok), { dryRun: false, now }, g.deps)).admitted, 1);
  const requests = api2.orgCalls.length + api2.calls.length;
  const again = await tick(context(ok), { dryRun: false, now }, g.deps);
  assert.equal(again.result, "unchanged");
  assert.equal(api2.orgCalls.length + api2.calls.length, requests);
});
