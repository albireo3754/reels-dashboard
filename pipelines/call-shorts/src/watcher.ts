/**
 * inbox 감시 — iCloud 플레이스홀더 제외, 크기 안정화 대기, SHA-256 멱등성.
 *
 * 1) `.m4a.icloud`는 아직 내려받지 않은 파일 → `brctl download` 시도 후 대기
 * 2) 크기가 STABLE_SECONDS 동안 변하지 않아야 시작 (동기화 중 잘린 오디오 방지)
 * 3) 같은 해시가 state에 있으면 skip (같은 통화 두 번 처리 = 돈 두 번)
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { Config } from "./config.js";
import type { StateStore } from "./state.js";

const ICLOUD_SUFFIX = ".icloud";

export type ScanStatus = "new" | "duplicate" | "unstable" | "placeholder" | "ignored";

export interface ScanItem {
  path: string;
  status: ScanStatus;
  sha256?: string;
  size: number;
  reason: string;
  existingProject?: string;
}

export interface ScannerOptions {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  sizeOf?: (file: string) => number;
}

export function isIcloudPlaceholder(file: string): boolean {
  return path.basename(file).toLowerCase().endsWith(ICLOUD_SUFFIX);
}

export function isHidden(file: string): boolean {
  return path.basename(file).startsWith(".");
}

export function isProcessable(file: string, extensions: string[]): boolean {
  if (isIcloudPlaceholder(file)) return false;
  if (isHidden(file)) return false;
  return extensions.includes(path.extname(file).toLowerCase());
}

export function listInboxFiles(inboxDir: string): string[] {
  if (!existsSync(inboxDir)) return [];
  return readdirSync(inboxDir)
    .map((name) => path.join(inboxDir, name))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

export function discoverAudioFiles(inboxDir: string, extensions: string[]): string[] {
  return listInboxFiles(inboxDir).filter((file) => isProcessable(file, extensions));
}

export async function sha256File(file: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function sizeOf(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return -1;
  }
}

/** 크기가 stableSeconds 동안 그대로면 true. 테스트를 위해 시계/슬립을 주입할 수 있습니다. */
export async function isStable(
  file: string,
  stableSeconds: number,
  options: {
    pollMs?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    sizeOf?: (file: string) => number;
  } = {},
): Promise<boolean> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const size = options.sizeOf ?? sizeOf;
  const pollMs = Math.max(10, options.pollMs ?? 500);
  const timeoutMs = options.timeoutMs ?? Math.max(60_000, stableSeconds * 10_000 + 30_000);
  const started = now();
  let lastSize = size(file);
  let lastChange = now();

  for (;;) {
    const current = now();
    const currentSize = size(file);
    if (currentSize < 0) return false;
    if (currentSize !== lastSize) {
      lastSize = currentSize;
      lastChange = current;
    } else if (currentSize > 0 && current - lastChange >= stableSeconds * 1000) {
      return true;
    }
    if (current - started > timeoutMs) return false;
    await sleep(pollMs);
  }
}

/** macOS 전용: iCloud 파일을 내려받게 요청합니다. */
export function requestIcloudDownload(file: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    execFile("brctl", ["download", file], { timeout: 60_000 }, () => undefined);
    return true;
  } catch {
    return false;
  }
}

export class InboxScanner {
  private readonly config: Config;
  private readonly store: StateStore;
  private readonly options: ScannerOptions;

  constructor(config: Config, store: StateStore, options: ScannerOptions = {}) {
    this.config = config;
    this.store = store;
    this.options = options;
  }

  async scan(force = false): Promise<ScanItem[]> {
    const items: ScanItem[] = [];
    for (const file of listInboxFiles(this.config.inboxDir)) {
      if (isIcloudPlaceholder(file)) {
        const requested = requestIcloudDownload(file);
        items.push({
          path: file,
          status: "placeholder",
          size: 0,
          reason: `iCloud 플레이스홀더 — 다운로드 요청 ${requested ? "됨" : "불가(맥에서 brctl 필요)"}`,
        });
        continue;
      }
      if (isHidden(file) || !isProcessable(file, this.config.allowedExtensions)) {
        items.push({ path: file, status: "ignored", size: 0, reason: "대상 확장자 아님/숨김 파일" });
        continue;
      }

      const size = (this.options.sizeOf ?? sizeOf)(file);
      if (size <= 0) {
        items.push({ path: file, status: "unstable", size: Math.max(0, size), reason: "크기 0 — 아직 동기화 중" });
        continue;
      }
      const stable = await isStable(file, this.config.stableSeconds, {
        pollMs: Math.min(1000, Math.max(50, this.config.pollIntervalSec * 100)),
        sleep: this.options.sleep,
        now: this.options.now,
        sizeOf: this.options.sizeOf,
      });
      if (!stable) {
        items.push({ path: file, status: "unstable", size, reason: "크기가 아직 변하는 중" });
        continue;
      }

      const digest = await sha256File(file);
      const existing = this.store.getFile(digest);
      if (!existing) {
        items.push({ path: file, status: "new", sha256: digest, size, reason: "새 파일" });
      } else if (existing.status === "failed" && force) {
        items.push({ path: file, status: "new", sha256: digest, size, reason: "실패 재시도" });
      } else {
        items.push({
          path: file,
          status: "duplicate",
          sha256: digest,
          size,
          reason: `이미 처리한 해시 (${existing.status})`,
          existingProject: existing.projectDir,
        });
      }
    }
    return items;
  }
}

/** 새 파일이 생기면 handler를 부르는 폴링 감시 루프. */
export async function watchForever(
  config: Config,
  store: StateStore,
  handler: (item: ScanItem) => Promise<void>,
  options: { intervalSec?: number; force?: boolean; signal?: AbortSignal } = {},
): Promise<void> {
  const intervalMs = Math.max(1000, (options.intervalSec ?? config.pollIntervalSec) * 1000);
  const scanner = new InboxScanner(config, store);
  for (;;) {
    if (options.signal?.aborted) return;
    try {
      for (const item of await scanner.scan(options.force ?? false)) {
        if (item.status === "new") await handler(item);
      }
    } catch (error) {
      console.error(`[watch] 스캔 오류: ${(error as Error).message}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
