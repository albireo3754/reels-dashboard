import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseEnv } from "node:util";
import type { MeetingCredit, MeetingProvider } from "../shared/meeting-notes";

// Weekly console sync + 1-day buffer; local reservations & usage settlements track interim spend.
const MAX_AGE = 8 * 24 * 60 * 60 * 1000;
const MICRO_USD = 1_000_000;
const providerList = ["openai", "claude"] as const;
const keyName = { openai: "OPENAI_API_KEY", claude: "ANTHROPIC_API_KEY" } as const;
const scopeName = { openai: "OPENAI_BASE_URL", claude: "ANTHROPIC_BASE_URL" } as const;
const baseUrl = { openai: "https://api.openai.com/v1", claude: "https://api.anthropic.com/v1" } as const;
const claudeConsoleKey = /^sk-ant-(?:api[A-Za-z0-9_-]+|(?!admin|oat|ort|oauth|svc|workload)[A-Za-z0-9_-]{99})$/;
const validUsd = (usd: unknown): usd is number => typeof usd === "number" &&
  Number.isFinite(usd) && usd >= 0 && usd <= 10_000;

async function readPrivateFile(file: string, max: number): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await handle.stat();
    if (!s.isFile() || (s.mode & 0o077) || s.size > max ||
      (process.getuid && s.uid !== process.getuid())) throw new Error("설정 파일 권한 확인 필요");
    return (await handle.readFile("utf8")).slice(0, max + 1);
  } finally {
    await handle.close();
  }
}

export async function meetingApiKey(provider: MeetingProvider, env = process.env): Promise<string | undefined> {
  const file = env.REELS_MEETING_CREDENTIALS_FILE ?? (!env[keyName[provider]]
    ? path.join(os.homedir(), ".config", "reels-dashboard", "meeting-credentials.env") : undefined);
  let config = env;
  if (file) {
    if (!path.isAbsolute(file)) return;
    config = await readPrivateFile(file, 128 * 1024).then(parseEnv).catch(() => ({}));
  }
  // Never re-target a provider-compatible proxy's key to the official API.
  const scope = config[scopeName[provider]] ?? env[scopeName[provider]];
  if (scope) {
    try {
      const parsed = new URL(scope);
      if (parsed.username || parsed.password || parsed.search || parsed.hash ||
        parsed.origin !== new URL(baseUrl[provider]).origin ||
        !["", "/", "/v1", "/v1/"].includes(parsed.pathname)) return;
    } catch { return; }
  }
  const key = config[keyName[provider]]?.trim();
  if (!key || /\s/.test(key)) return;
  // Claude Console issues workspace keys with and without the older api marker.
  if (provider === "openai" ? !key.startsWith("sk-proj-") : !claudeConsoleKey.test(key)) return;
  return key;
}

type CreditValue = {
  observedAt: string; expiresAt: string; totalUsd: number; remainingUsd: number;
  exclusiveSpend: boolean;
};
function readObservation(raw: unknown, now: number): CreditValue | undefined {
  if (!raw || typeof raw !== "object") return;
  const o = raw as Partial<CreditValue>;
  if (typeof o.observedAt !== "string" || typeof o.expiresAt !== "string" ||
    !validUsd(o.totalUsd) || o.totalUsd === 0 || !validUsd(o.remainingUsd) ||
    o.remainingUsd > o.totalUsd) return;
  const observed = Date.parse(o.observedAt), expires = Date.parse(o.expiresAt);
  if (!Number.isFinite(observed) || !Number.isFinite(expires) || observed > now ||
    now - observed > MAX_AGE || expires <= now || expires <= observed) return;
  return { ...o, exclusiveSpend: o.exclusiveSpend === true } as CreditValue;
}

export class MeetingCreditGuard {
  // The desktop single-instance lock plus this serialized in-process queue make
  // reservations atomic across simultaneous requests in the only app instance.
  private queue = Promise.resolve();
  constructor(private root: string, private env = process.env, private now = Date.now) {}
  private files() {
    return {
      observations: path.join(this.root, "meeting-credit-observations.json"),
      journal: path.join(this.root, "meeting-credit-reservations.jsonl"),
    };
  }
  private async inspect(provider: MeetingProvider) {
    const now = this.now();
    const { observations, journal } = this.files();
    const data = await readPrivateFile(observations, 16_384).then(s => JSON.parse(s)).catch(() => null);
    const observation = readObservation(data?.[provider], now);
    const unknown: MeetingCredit = { provider, status: "unknown", enabled: false };
    if (!observation) return { credit: unknown };
    let spend = 0;
    try {
      const lines = await readPrivateFile(journal, 4 * 1024 * 1024)
        .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; });
      const observedMs = Date.parse(observation.observedAt);
      const reservedById = new Map<string, number>();
      const settledById = new Map<string, number>();
      let legacySpend = 0;
      for (const line of lines.split("\n").filter(Boolean)) {
        const item = JSON.parse(line);
        const isSettle = item.type === "settle";
        if (!providerList.includes(item.provider) || !Number.isSafeInteger(item.at) ||
          !Number.isSafeInteger(item.microUsd) || (isSettle ? item.microUsd < 0 : item.microUsd <= 0)) {
          return { credit: unknown };
        }
        if (isSettle && (typeof item.id !== "string" || !item.id)) return { credit: unknown };
        // Reservations stay counted even on ambiguous failures. Only an explicit
        // settlement line for the same reservation ID replaces its reserved upper bound.
        if (item.provider !== provider || item.at < observedMs) continue;
        if (isSettle) {
          settledById.set(item.id, item.microUsd);
        } else if (typeof item.id === "string" && item.id) {
          reservedById.set(item.id, (reservedById.get(item.id) ?? 0) + item.microUsd);
        } else {
          legacySpend += item.microUsd;
        }
      }
      spend = legacySpend;
      for (const [id, reservedMicro] of reservedById) {
        spend += settledById.has(id) ? settledById.get(id)! : reservedMicro;
      }
    } catch { return { credit: unknown }; }
    const usable = Math.max(0, Math.floor(observation.remainingUsd * MICRO_USD) - spend);
    const reserve = Math.ceil(observation.totalUsd * MICRO_USD / 10);
    const key = await meetingApiKey(provider, this.env);
    const enabled = Boolean(this.env.REELS_MEETING_API_ENABLED === "1" &&
      observation.exclusiveSpend && key && usable > reserve);
    const credit: MeetingCredit = {
      provider, status: spend > 0 ? "estimated" : "snapshot", enabled,
      totalUsd: observation.totalUsd, remainingUsd: usable / MICRO_USD,
      observedAt: observation.observedAt,
    };
    return { credit, key, usable, reserve };
  }
  async credits(): Promise<MeetingCredit[]> {
    return Promise.all(providerList.map(async provider => (await this.inspect(provider)).credit));
  }
  private async appendJournal(entry: Record<string, unknown>): Promise<boolean> {
    const { journal } = this.files();
    // Recheck this opt-in profile rather than writing to an unsafe location.
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootStat = await lstat(this.root);
    if (!rootStat.isDirectory() || (rootStat.mode & 0o022)) return false;
    const handle = await open(journal, constants.O_WRONLY | constants.O_CREAT |
      constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || (stats.mode & 0o077) || stats.size >= 4 * 1024 * 1024 ||
        (process.getuid && stats.uid !== process.getuid())) return false;
      await handle.appendFile(JSON.stringify(entry) + "\n");
      await handle.sync();
      return true;
    } finally { await handle.close(); }
  }
  reserveLease(provider: MeetingProvider, upperUsd: number): Promise<{ key: string; id: string } | undefined> {
    const operation = this.queue.then(async () => {
      if (!validUsd(upperUsd) || upperUsd <= 0) return;
      const { credit, key, usable, reserve } = await this.inspect(provider);
      const microUsd = Math.ceil(upperUsd * MICRO_USD);
      if (!credit.enabled || !key || usable === undefined || reserve === undefined ||
        usable - microUsd <= reserve) return;
      const id = randomUUID();
      const wrote = await this.appendJournal({ type: "reserve", id, provider, microUsd, at: this.now() });
      if (!wrote) return;
      return { key, id };
    });
    this.queue = operation.then(() => {}, () => {});
    return operation.catch(() => undefined);
  }
  async reserve(provider: MeetingProvider, upperUsd: number): Promise<string | undefined> {
    return (await this.reserveLease(provider, upperUsd))?.key;
  }
  settle(provider: MeetingProvider, reservationId: string, actualUsd: number): Promise<boolean> {
    const operation = this.queue.then(async () => {
      if (!reservationId || !validUsd(actualUsd) || actualUsd < 0) return false;
      const microUsd = Math.ceil(actualUsd * MICRO_USD);
      return this.appendJournal({ type: "settle", id: reservationId, provider, microUsd, at: this.now() });
    });
    this.queue = operation.then(() => {}, () => {});
    return operation.catch(() => false);
  }
}
