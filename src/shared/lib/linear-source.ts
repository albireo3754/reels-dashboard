import { execFile, spawn } from "node:child_process";
import { errorMessage } from "./errors";
import { PlanningStore } from "./planning-store";
import { addDays, linearImportSchema, seoulDate, type Planning } from "../planning";

/**
 * Read-only Linear GraphQL source for the after-work autopilot. No model is involved: one team's issues
 * are listed through `fetch` and stored as the planning snapshot's `linear` provider. Only queries are
 * sent. The API key lives in the macOS Keychain, is held in memory for one refresh and is never part of
 * an argument list, a log line, an error, the saved snapshot or any output.
 *
 * Query shape, headers, pagination and state types follow the checked contract in
 * `~/Obsidian/side/reels/research/2026-11-16-after-work-autopilot/work/linear-api-contract.md`
 * (official docs and the official schema). Fields that contract marks UNCONFIRMED are not used.
 */

export const linearEndpoint = "https://api.linear.app/graphql";
export const keychainService = "reels-dashboard-linear";
export const keychainAccount = "linear";
/** Official page-size limit is 250; 50 is the documented default and keeps one query well under the 10,000 point cap. */
export const pageSize = 50;
/** Nested connections request this many nodes; a `hasNextPage` on one is handled, never assumed away. */
export const nestedSize = 10;
export const maxPages = 20;
/** The planning schema holds at most this many issues; a team with more is a failure, not a truncated copy. */
export const maxIssues = 500;
const closedTypes = ["completed", "canceled", "duplicate"] as const;
const stateTypes = ["triage", "backlog", "unstarted", "started", ...closedTypes] as const;
const recentClosedWindow = "-P14D";
const blockerPageSize = 50;
const blockerMaxPages = 5;
const requestTimeoutMs = 30_000;

/** The selection of one issue. Arguments are written out once so the field-name snapshot test can read them. */
const issueSelection = `
      id identifier title url description dueDate priority createdAt updatedAt startedAt
      state { name type }
      team { key }
      children(first: ${nestedSize}) { pageInfo { hasNextPage } nodes { state { type } } }
      inverseRelations(first: ${nestedSize}) { pageInfo { hasNextPage } nodes { type issue { identifier state { type } } } }
      attachments(first: ${nestedSize}) { nodes { url } }`;
export const teamIssuesQuery = `query TeamIssues($filter: IssueFilter!, $first: Int!, $after: String) {
  issues(first: $first, after: $after, includeArchived: false, orderBy: updatedAt, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes {${issueSelection}
    }
  }
}`;
/** Used when an issue has more than {@link nestedSize} inverse relations, so no blocker is silently dropped. */
export const issueBlockersQuery = `query IssueBlockers($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    inverseRelations(first: $first, after: $after) { pageInfo { hasNextPage endCursor } nodes { type issue { identifier state { type } } } }
  }
}`;
/**
 * The workspace the API key belongs to. `viewer: User!`, `User.organization: Organization!` and
 * `Organization.{id: ID!, urlKey: String!}` are confirmed in the official schema (see linear-api-contract.md,
 * section "Workspace"). Compared with `linear.workspaceUrlKey` before any issue is read, because a team with the
 * same key in another workspace and no issues would otherwise be accepted as a successful empty queue.
 */
export const viewerOrganizationQuery = `query ViewerOrganization {
  viewer { organization { id urlKey } }
}`;
/** Field names a query selects (arguments and variables left out); compared with the contract in the unit test. */
export function selectedFields(query: string): string[] {
  const body = query.slice(query.indexOf("{"));
  const withoutArguments = body.replace(/\([^)]*\)/g, "");
  return [...new Set(withoutArguments.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])];
}

export type LinearFailure =
  | "linear_auth_missing" | "linear_auth_invalid" | "linear_scope_mismatch" | "linear_workspace_mismatch" | "linear_incomplete"
  | "linear_rate_limited" | "linear_invalid_response" | "linear_save_failed";
/** What a person can do about each failure, in one sentence. Never mentions a key value. */
export const linearFailureHint: Record<LinearFailure, string> = {
  linear_auth_missing: "Keychain에 Linear API 키가 없어요. `reels autopilot connect-linear`로 한 번 연결하세요. Claude 커넥터 재인증은 자동 갱신에 쓰이지 않아요.",
  linear_auth_invalid: "Linear가 저장된 API 키를 거절했어요. 키가 폐기됐으면 `reels autopilot connect-linear`로 새 키를 저장하세요.",
  linear_scope_mismatch: "응답에 설정한 팀·워크스페이스가 아닌 이슈가 섞여 있어 아무것도 저장하지 않았어요. config.json의 linear.teamKey·workspaceUrlKey를 확인하세요.",
  linear_workspace_mismatch: "저장된 API 키가 설정한 workspace(linear.workspaceUrlKey)의 키가 아니라서 아무것도 저장하지 않았어요. 키가 속한 workspace와 config.json의 linear.workspaceUrlKey를 확인하세요.",
  linear_incomplete: "조회가 끝까지 완료되지 않아 부분 결과를 저장하지 않았어요. 다음 tick이 다시 시도해요.",
  linear_rate_limited: "Linear 호출 한도(429)에 걸렸어요. 재시도하지 않고 다음 tick까지 기다려요.",
  linear_invalid_response: "Linear 응답이 예상한 모양이 아니라서 저장하지 않았어요.",
  linear_save_failed: "조회는 성공했지만 planning.json에 저장하지 못했어요.",
};

export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}
export type FetchLike = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<FetchResponseLike>;

export interface SecurityResult { code: number | null; stdout: string; }
/** The only place the `security` tool runs, so tests replace it and never touch the real Keychain. */
export interface SecurityRunner {
  /** Output is captured (used for reading the key into memory). */
  capture(args: string[]): Promise<SecurityResult>;
  /** Attached to the terminal, so macOS itself asks for the secret; this process never sees it. */
  interactive(args: string[]): Promise<{ code: number | null }>;
}
export const defaultSecurityRunner: SecurityRunner = {
  capture: args => new Promise(resolve => {
    execFile("security", args, { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 }, (error, stdout) => {
      const code = error ? ((error as NodeJS.ErrnoException & { code?: unknown }).code) : 0;
      resolve({ code: typeof code === "number" ? code : error ? null : 0, stdout: error ? "" : stdout });
    });
  }),
  interactive: args => new Promise(resolve => {
    const child = spawn("security", args, { stdio: "inherit" });
    child.once("error", () => resolve({ code: null }));
    child.once("close", code => resolve({ code }));
  }),
};

const addKeyArguments = () => ["add-generic-password", "-U", "-s", keychainService, "-a", keychainAccount, "-w"];
const readKeyArguments = () => ["find-generic-password", "-s", keychainService, "-a", keychainAccount, "-w"];
const removeKeyArguments = () => ["delete-generic-password", "-s", keychainService, "-a", keychainAccount];
/** Exit status of `security` when no matching item exists. */
const keychainNotFound = 44;

/**
 * Stores the key. `-w` is the last argument and has no value, so macOS prompts for the secret on the
 * terminal and the value never appears in this process's argument list or memory.
 */
export const addLinearKey = (runner: SecurityRunner) => runner.interactive(addKeyArguments());
export async function removeLinearKey(runner: SecurityRunner): Promise<{ removed: boolean; code: number | null }> {
  const { code } = await runner.capture(removeKeyArguments());
  return { removed: code === 0, code };
}
export async function readLinearKey(runner: SecurityRunner): Promise<{ key: string } | { key: null; code: number | null }> {
  const { code, stdout } = await runner.capture(readKeyArguments());
  const key = stdout.trim();
  return code === 0 && key ? { key } : { key: null, code: code === 0 ? keychainNotFound : code };
}

/** Removes the key from any text that may leave this module; Linear personal keys also share a prefix. */
export function maskSecrets(text: string, key?: string): string {
  const plain = key ? text.split(key).join("[redacted]") : text;
  return plain.replace(/lin_(?:api|oauth)_[A-Za-z0-9]+/g, "[redacted]");
}

export type LinearImport = NonNullable<Planning["linear"]>;
type Issue = LinearImport["issues"][number];
export interface LinearSettings { teamKey: string; workspaceUrlKey: string; }
export interface LinearSummary {
  team: string;
  issues: number;
  /** Counts per Linear state type; no titles or text. */
  byState: Record<string, number>;
  pages: number;
  requests: number;
  syncedAt: string;
  /** `X-Complexity` values the API reported, when it did. */
  complexity?: { max: number; total: number };
}
export type LinearFetchResult =
  | { ok: true; linear: LinearImport; summary: LinearSummary }
  | { ok: false; reason: LinearFailure; detail?: string };
export interface LinearDeps { runner: SecurityRunner; fetch: FetchLike; now: () => Date; }

class Failure extends Error {
  constructor(readonly reason: LinearFailure, readonly detail?: string) { super(reason); }
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const isClosed = (type: string) => (closedTypes as readonly string[]).includes(type);

/**
 * Lists one team's open issues plus those closed in the last 14 days, completely or not at all. Any gap
 * (error, rate limit, repeated cursor, too many pages or issues, an issue of another team) fails the
 * whole read, so a partial copy is never saved.
 */
export async function fetchLinearTeam(settings: LinearSettings, deps: LinearDeps): Promise<LinearFetchResult> {
  const found = await readLinearKey(deps.runner);
  if (found.key === null) return { ok: false, reason: "linear_auth_missing", detail: `keychain ${keychainService}/${keychainAccount} read exit ${found.code ?? "none"}` };
  const key = found.key;
  const mask = (value: string) => maskSecrets(value, key);
  const fail = (reason: LinearFailure, detail?: string) => new Failure(reason, detail === undefined ? undefined : mask(detail).slice(0, 300));
  let requests = 0;
  const complexities: number[] = [];

  const post = async (query: string, variables: Json): Promise<Json> => {
    let response: FetchResponseLike;
    try {
      response = await deps.fetch(linearEndpoint, {
        method: "POST",
        // A personal API key goes in as is; "Bearer" is for OAuth tokens only.
        headers: { "content-type": "application/json", authorization: key },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) { throw fail("linear_incomplete", `network: ${errorMessage(error)}`); }
    requests++;
    const complexity = Number(response.headers.get("x-complexity"));
    if (response.headers.get("x-complexity") !== null && Number.isFinite(complexity)) complexities.push(complexity);
    const retryAfter = response.headers.get("retry-after");
    let body: unknown;
    try { body = await response.json(); } catch { body = undefined; }
    const errors = isObject(body) && Array.isArray(body.errors) ? body.errors.filter(isObject) : [];
    const codes = errors.map(error => (isObject(error.extensions) ? text(error.extensions.code) : undefined));
    if (response.status === 429 || codes.includes("RATELIMITED"))
      throw fail("linear_rate_limited", `HTTP ${response.status}${retryAfter ? `, Retry-After ${retryAfter}s` : ""}`);
    if (response.status === 401 || response.status === 403 || codes.includes("AUTHENTICATION_ERROR"))
      throw fail("linear_auth_invalid", `HTTP ${response.status}`);
    if (errors.length) throw fail("linear_incomplete", `graphql errors: ${codes.find(Boolean) ?? text(errors[0].message) ?? "unknown"}`);
    if (response.status !== 200) throw fail("linear_incomplete", `HTTP ${response.status}`);
    if (!isObject(body) || !isObject(body.data)) throw fail("linear_invalid_response", "no data object");
    return body.data;
  };

  const connection = (value: unknown, what: string): { nodes: Json[]; hasNextPage: boolean; endCursor: string | null } => {
    if (!isObject(value) || !Array.isArray(value.nodes) || !value.nodes.every(isObject) || !isObject(value.pageInfo) || typeof value.pageInfo.hasNextPage !== "boolean")
      throw fail("linear_invalid_response", `${what} is not a connection`);
    const { endCursor } = value.pageInfo;
    return { nodes: value.nodes as Json[], hasNextPage: value.pageInfo.hasNextPage, endCursor: typeof endCursor === "string" && endCursor ? endCursor : null };
  };
  /** Follows `endCursor` until `hasNextPage` is false. A repeated cursor, a missing one or too many pages is incomplete. */
  const pages = async (what: string, limit: number, request: (after: string | null) => Promise<{ nodes: Json[]; hasNextPage: boolean; endCursor: string | null }>) => {
    const nodes: Json[] = [];
    const seen = new Set<string>();
    let after: string | null = null;
    for (let page = 1; ; page++) {
      if (page > limit) throw fail("linear_incomplete", `${what}: more than ${limit} pages`);
      const result = await request(after);
      nodes.push(...result.nodes);
      if (!result.hasNextPage) return { nodes, pages: page };
      if (!result.endCursor) throw fail("linear_incomplete", `${what}: hasNextPage without endCursor`);
      if (seen.has(result.endCursor)) throw fail("linear_incomplete", `${what}: cursor repeated`);
      seen.add(result.endCursor);
      after = result.endCursor;
    }
  };

  const team = { team: { key: { eq: settings.teamKey } } };
  // Workspace first: the issue list below says nothing about it when the team is empty.
  const organization = async () => {
    const data = await post(viewerOrganizationQuery, {});
    const viewer = data.viewer, org = isObject(viewer) ? viewer.organization : undefined;
    const urlKey = isObject(org) ? text(org.urlKey) : undefined;
    if (!isObject(org) || !text(org.id) || !urlKey) throw fail("linear_invalid_response", "the workspace of the key could not be read");
    if (urlKey !== settings.workspaceUrlKey) throw fail("linear_workspace_mismatch", `the key belongs to workspace ${urlKey}, expected ${settings.workspaceUrlKey}`);
  };
  const passes: { name: string; filter: Json }[] = [
    { name: "open", filter: { ...team, state: { type: { nin: [...closedTypes] } } } },
    { name: "recently_closed", filter: { ...team, state: { type: { in: [...closedTypes] } }, updatedAt: { gt: recentClosedWindow } } },
  ];
  let pageCount = 0;
  const raw = new Map<string, Json>();
  try {
    await organization();
    for (const pass of passes) {
      const result = await pages(pass.name, maxPages, async after => {
        const data = await post(teamIssuesQuery, { filter: pass.filter, first: pageSize, after });
        return connection(data.issues, "issues");
      });
      pageCount += result.pages;
      // Ordering by update time can shift while paging; the same id twice is one issue.
      for (const node of result.nodes) if (typeof node.id === "string") raw.set(node.id, raw.get(node.id) ?? node);
      if (raw.size > maxIssues) throw fail("linear_incomplete", `more than ${maxIssues} issues; the snapshot holds at most ${maxIssues}`);
    }

    const blockers = async (node: Json, nested: ReturnType<typeof connection>): Promise<string[]> => {
      let relations = nested.nodes;
      if (nested.hasNextPage) {
        // The first page said there are more: read the whole list so a blocker is not missed.
        const all = await pages(`blockers of ${text(node.identifier) ?? "issue"}`, blockerMaxPages, async after => {
          const data = await post(issueBlockersQuery, { id: node.id, first: blockerPageSize, after });
          if (!isObject(data.issue)) throw fail("linear_invalid_response", "issue not found for blockers");
          return connection(data.issue.inverseRelations, "inverseRelations");
        });
        relations = all.nodes;
      }
      const open: string[] = [];
      for (const relation of relations) {
        if (relation.type !== "blocks") continue;
        const source = relation.issue;
        if (!isObject(source) || !text(source.identifier) || !isObject(source.state) || typeof source.state.type !== "string")
          throw fail("linear_invalid_response", "blocking issue has no identifier or state");
        if (!isClosed(source.state.type)) open.push(source.identifier as string);
      }
      return [...new Set(open)].slice(0, 50);
    };

    const issues: Issue[] = [];
    for (const node of raw.values()) {
      const state = isObject(node.state) ? node.state : undefined;
      const stateType = state && typeof state.type === "string" ? state.type : undefined;
      if (!stateType || !(stateTypes as readonly string[]).includes(stateType)) throw fail("linear_invalid_response", `unknown state type ${stateType ?? "none"}`);
      const nodeTeam = isObject(node.team) ? text(node.team.key) : undefined;
      if (nodeTeam !== settings.teamKey) throw fail("linear_scope_mismatch", `an issue belongs to team ${nodeTeam ?? "none"}, expected ${settings.teamKey}`);
      const url = text(node.url);
      let path = "";
      try { path = new URL(url ?? "").pathname; } catch { throw fail("linear_invalid_response", "issue url is not a URL"); }
      if (!path.startsWith(`/${settings.workspaceUrlKey}/`)) throw fail("linear_scope_mismatch", `an issue link is outside workspace ${settings.workspaceUrlKey}`);
      const id = text(node.id), identifier = text(node.identifier), title = text(node.title);
      if (!id || !identifier || !title || !url) throw fail("linear_invalid_response", "an issue misses id, identifier, title or url");
      const closed = isClosed(stateType);
      const description = !closed ? text(node.description) : undefined;
      const children = node.children === undefined ? undefined : connection(node.children, "children");
      const inverse = node.inverseRelations === undefined ? undefined : connection(node.inverseRelations, "inverseRelations");
      const attachments = isObject(node.attachments) && Array.isArray(node.attachments.nodes) ? node.attachments.nodes.filter(isObject).map(a => text(a.url) ?? "") : [];
      const projectId = [description ?? "", ...attachments].map(value => /dashboard:([A-Za-z0-9_.-]{1,200})/.exec(value)?.[1]).find(Boolean);
      const blockedBy = inverse && !closed ? await blockers(node, inverse) : [];
      const priority = typeof node.priority === "number" && Number.isInteger(node.priority) && node.priority >= 0 && node.priority <= 4 ? node.priority : undefined;
      issues.push({
        id, identifier, title, url,
        dueDate: typeof node.dueDate === "string" ? node.dueDate : null,
        state: stateType as Issue["state"],
        ...(text(state?.name) ? { stateName: text(state?.name) } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(text(node.createdAt) ? { createdAt: text(node.createdAt) } : {}),
        ...(text(node.updatedAt) ? { updatedAt: text(node.updatedAt) } : {}),
        ...(text(node.startedAt) ? { startedAt: text(node.startedAt) } : {}),
        ...(blockedBy.length ? { blockedBy } : {}),
        // A nested page that says more exist gives no honest count, so the count is left out.
        ...(children && !children.hasNextPage && children.nodes.length
          ? { subIssues: { open: children.nodes.filter(child => !isObject(child.state) || !isClosed(String(child.state.type))).length, total: children.nodes.length } }
          : {}),
        ...(projectId ? { projectId } : {}),
        ...(description ? { description: description.slice(0, 20_000) } : {}),
      });
    }

    const syncedAt = deps.now().toISOString();
    const today = seoulDate(deps.now());
    const candidate = {
      url: `https://linear.app/${settings.workspaceUrlKey}/team/${settings.teamKey}/all`,
      syncedAt, window: { from: addDays(today, -14), to: addDays(today, 28) }, issues,
    };
    const parsed = linearImportSchema.safeParse(candidate);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw fail("linear_invalid_response", `snapshot rejected at ${first ? first.path.join(".") : "?"}: ${first?.message ?? ""}`);
    }
    const byState: Record<string, number> = {};
    for (const issue of parsed.data.issues) byState[issue.state] = (byState[issue.state] ?? 0) + 1;
    return {
      ok: true, linear: parsed.data,
      summary: {
        team: settings.teamKey, issues: parsed.data.issues.length, byState, pages: pageCount, requests, syncedAt,
        ...(complexities.length ? { complexity: { max: Math.max(...complexities), total: complexities.reduce((a, b) => a + b, 0) } } : {}),
      },
    };
  } catch (error) {
    if (error instanceof Failure) return { ok: false, reason: error.reason, ...(error.detail ? { detail: error.detail } : {}) };
    return { ok: false, reason: "linear_incomplete", detail: mask(errorMessage(error)).slice(0, 300) };
  }
}

export type LinearRefresh =
  /** `linear` is what the API returned just now, whether or not it was saved over a newer copy. */
  | { ok: true; saved: boolean; summary: LinearSummary; linear: LinearImport; note?: string }
  | { ok: false; reason: LinearFailure; detail?: string };

/**
 * Reads the team and, unless `dryRun`, replaces the planning snapshot's `linear` provider with the result.
 * The write checks the planning revision (`expectedUpdatedAt`); on a conflict it rereads once. A copy that
 * a concurrent refresh or a connector sync already made newer is left alone.
 */
export async function refreshLinear(root: string, settings: LinearSettings, deps: LinearDeps, options: { dryRun: boolean }): Promise<LinearRefresh> {
  const fetched = await fetchLinearTeam(settings, deps);
  if (!fetched.ok) return fetched;
  if (options.dryRun) return { ok: true, saved: false, summary: fetched.summary, linear: fetched.linear };
  const store = new PlanningStore(root);
  let lastConflict = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const current = await store.get();
      await store.update({ expectedUpdatedAt: current.updatedAt, linear: fetched.linear });
      return { ok: true, saved: true, summary: fetched.summary, linear: fetched.linear };
    } catch (error) {
      const message = errorMessage(error);
      if (message.startsWith("STALE_SOURCE")) return { ok: true, saved: false, summary: fetched.summary, linear: fetched.linear, note: "a newer Linear copy was already saved" };
      if (!message.startsWith("STALE_PLANNING")) return { ok: false, reason: "linear_save_failed", detail: message.slice(0, 200) };
      lastConflict = message;
    }
  }
  return { ok: false, reason: "linear_save_failed", detail: lastConflict.slice(0, 200) };
}
