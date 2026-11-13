import path from "node:path";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  InstagramInsightsClient,
  InstagramApiError,
  CORE_METRICS,
  REEL_METRICS,
} from "../../../packages/instagram-insights/index.mjs";
import {
  instagramConnectionInput,
  instagramCollectionSource,
  type InstagramCollectionSource,
  instagramSnapshotSchema,
  instagramTopicsInput,
  type InstagramInsightsState,
} from "../instagram-insights";
import { readJsonFile, writeJsonAtomic } from "./fs";

const settingsSchema = instagramConnectionInput.extend({
  tokenFile: z.string().min(1),
  topics: z.record(z.string(), z.string()).default({}),
});
const indexSchema = z.array(
  z.strictObject({
    id: z.string().uuid(),
    username: z.string(),
    collectedAt: z.string().datetime(),
    count: z.number().int(),
    source: instagramCollectionSource.default("manual"),
  }),
);
const stateInput = z.strictObject({ snapshotId: z.string().uuid().optional() });
/** Only fixed summaries cross the credential boundary, never server messages or URLs. */
export function instagramFailure(error: unknown): {
  code: string;
  message: string;
} {
  if (error instanceof InstagramApiError) {
    if (error.status === 401 || [102, 190].includes(Number(error.code)))
      return {
        code: "INSTAGRAM_AUTH",
        message: "인증 실패: 토큰이 만료되거나 취소됐을 수 있어요. Codex에 Instagram 조회 토큰 갱신을 요청해주세요. 기존 비공개 토큰 파일과 계정 연결을 통해 갱신을 도울 수 있어요.",
      };
    if (error.status === 403 || [10, 200].includes(Number(error.code)))
      return {
        code: "INSTAGRAM_PERMISSION",
        message:
          "조회 권한이 부족해요. Instagram 인사이트 읽기 권한을 확인해주세요.",
      };
    if (
      error.status === 429 ||
      [4, 17, 32, 613, 80002].includes(Number(error.code))
    )
      return {
        code: "INSTAGRAM_RATE_LIMIT",
        message: "요청 제한에 도달했어요 (HTTP 429). 자동 재시도하지 않아요.",
      };
    if (error.status === 0)
      return {
        code: "INSTAGRAM_NETWORK",
        message: "네트워크 연결 또는 요청 시간 초과로 수집하지 못했어요.",
      };
    return {
      code: "INSTAGRAM_API",
      message: "Instagram API가 정상 결과를 제공하지 않았어요.",
    };
  }
  const code =
    error instanceof Error
      ? /^(INSTAGRAM_[A-Z_]+):/.exec(error.message)?.[1]
      : undefined;
  const messages: Record<string, string> = {
    INSTAGRAM_BUSY:
      "다른 앱 또는 CLI가 Instagram 저장소를 사용 중이에요. 자동 재시도하지 않아요. 비정상 종료 후라면 잠금 소유 프로세스를 확인해주세요.",
    INSTAGRAM_TOKEN: "실제 조회 토큰 파일과 파일 권한(600)을 확인해주세요.",
    INSTAGRAM_NOT_CONNECTED: "먼저 앱에서 조회 토큰 파일을 연결해주세요.",
    INSTAGRAM_PERMISSION: "인사이트 조회 권한이 부족해요.",
    INSTAGRAM_INSIGHTS_UNAVAILABLE:
      "사용 가능한 인사이트 지표가 없어요. 이전 성공 기록은 유지돼요.",
  };
  return code && messages[code]
    ? { code, message: messages[code]! }
    : {
        code: "INSTAGRAM_COLLECTION_FAILED",
        message:
          "수집·저장을 완료하지 못했어요. 이전 성공 기록을 확인해주세요. 자동 재시도하지 않아요.",
      };
}
function tokenHealth(expiresAt?: string) {
  return {
    status: !expiresAt
      ? ("unknown" as const)
      : Date.parse(expiresAt) <= Date.now()
        ? ("expired" as const)
        : Date.parse(expiresAt) - Date.now() <= 7 * 86400000
          ? ("expiring" as const)
          : ("valid" as const),
    expiresAt: expiresAt ?? null,
  };
}
export class InstagramInsightsStore {
  private running = false;
  private lastError: string | null = null;
  constructor(
    private root: string,
    private fetchImpl?: (url: URL, init: RequestInit) => Promise<Response>,
    private changed: () => void = () => {},
  ) {}
  clearError() {
    this.lastError = null;
  }
  get busy() {
    return this.running;
  }
  private settings() {
    return readJsonFile(
      path.join(this.root, "instagram-connection.json"),
      (value) => settingsSchema.parse(value),
      () => null,
    );
  }
  private index() {
    return readJsonFile(
      path.join(this.root, "instagram-history.json"),
      (value) => indexSchema.parse(value),
      () => [],
    );
  }
  private async token(file: string) {
    try {
      const info = await stat(file);
      if (!info.isFile() || info.mode & 0o077 || info.size > 65536)
        throw new Error();
      const value = (await readFile(file, "utf8")).trim();
      if (value.length < 40 || /[^\x21-\x7e]|\*/.test(value)) throw new Error();
      return value;
    } catch {
      throw new Error(
        "INSTAGRAM_TOKEN: 실제 조회 토큰 파일과 파일 권한(600)을 확인해주세요.",
      );
    }
  }
  private get lockFile() {
    return path.join(this.root, "instagram-collection.lock");
  }
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.running)
      throw new Error(
        "INSTAGRAM_BUSY: 현재 가져오기가 끝난 뒤 다시 시도해주세요.",
      );
    this.running = true;
    let lock;
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      try {
        lock = await open(this.lockFile, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error("INSTAGRAM_BUSY: Instagram 저장소 사용 중");
        throw error;
      }
      await lock.writeFile(
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
        }),
      );
      return await work();
    } finally {
      try {
        if (lock) {
          await lock.close();
          await unlink(this.lockFile);
        }
      } finally {
        this.running = false;
      }
    }
  }
  async get(value: unknown = {}): Promise<InstagramInsightsState> {
    const input = stateInput.parse(value);
    const settings = await this.settings();
    const history = (await this.index()).filter(
      (v) => v.username === settings?.username,
    );
    const selected = input.snapshotId
      ? history.find((v) => v.id === input.snapshotId)
      : history[0];
    if (input.snapshotId && !selected)
      throw new Error(
        "INSTAGRAM_SNAPSHOT: 이 계정의 수집 기록을 찾지 못했어요.",
      );
    const snapshot = selected
      ? instagramSnapshotSchema.parse(
          JSON.parse(
            await readFile(
              path.join(
                this.root,
                "instagram-snapshots",
                `${selected.id}.json`,
              ),
              "utf8",
            ),
          ),
        )
      : null;
    const tokenReady = settings
      ? await this.token(settings.tokenFile).then(
          () => true,
          () => false,
        )
      : false;
    return {
      connection: settings
        ? {
            username: settings.username,
            login: settings.login,
            tokenReady,
            tokenHealth: tokenHealth(settings.tokenExpiresAt),
          }
        : null,
      snapshot,
      history: history.slice(0, 50).map(({ username: _, ...entry }) => entry),
      topics: settings?.topics ?? {},
      busy:
        this.running ||
        (await stat(this.lockFile).then(
          () => true,
          (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        )),
      lastError: this.lastError,
    };
  }
  startRefresh() {
    if (this.running)
      throw new Error(
        "INSTAGRAM_BUSY: 현재 가져오기가 끝난 뒤 다시 시도해주세요.",
      );
    this.lastError = null;
    void this.refresh()
      .catch((error) => {
        const failure = instagramFailure(error);
        this.lastError = `${failure.code}: ${failure.message}`;
      })
      .finally(() => this.changed());
    this.changed();
    return this.get();
  }
  async connect(value: unknown, tokenFile: string) {
    const input = instagramConnectionInput.parse(value);
    if (!path.isAbsolute(tokenFile))
      throw new Error("INSTAGRAM_TOKEN: 토큰 파일을 다시 선택해주세요.");
    await this.exclusive(async () => {
      const accessToken = await this.token(tokenFile);
      const client = new InstagramInsightsClient({
        accessToken,
        expectedUsername: input.username,
        login: input.login,
        fetchImpl: this.fetchImpl,
      });
      await client.account();
      const current = await this.settings();
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(
        path.join(this.root, "instagram-connection.json"),
        {
          ...input,
          tokenFile,
          topics: current?.username === input.username ? current.topics : {},
        },
        { mode: 0o600 },
      );
    });
    this.changed();
    return this.get();
  }
  async refresh(
    source: InstagramCollectionSource = "manual",
    signal?: AbortSignal,
    // CLI signals must distinguish an aborted request from a possibly committed snapshot.
    onWrite?: (outcome: "unknown" | "applied") => void,
  ) {
    instagramCollectionSource.parse(source);
    this.lastError = null;
    let result!: InstagramInsightsState;
    await this.exclusive(async () => {
      const settings = await this.settings();
      if (!settings)
        throw new Error(
          "INSTAGRAM_NOT_CONNECTED: 먼저 조회 토큰 파일을 연결해주세요.",
        );
      const collectedAt = new Date().toISOString();
      const client = new InstagramInsightsClient({
        accessToken: await this.token(settings.tokenFile),
        login: settings.login,
        expectedUsername: settings.username,
        fetchImpl: (url, init) =>
          (this.fetchImpl ?? fetch)(url, {
            ...init,
            signal: signal
              ? AbortSignal.any([signal, init.signal!])
              : init.signal,
          }),
      });
      signal?.throwIfAborted();
      const account = await client.account();
      const media = (await client.media(account)).sort(
        (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
      );
      const results = [];
      for (const post of media.slice(0, 100))
        results.push({
          ...post,
          metrics: (
            await client.insights(
              post,
              post.mediaProductType === "REELS"
                ? [...CORE_METRICS, ...REEL_METRICS]
                : CORE_METRICS,
            )
          ).metrics,
        });
      if (
        results.length &&
        results.every((post) =>
          post.metrics.every((metric) => metric.status !== "available"),
        )
      )
        throw new Error(
          "INSTAGRAM_INSIGHTS_UNAVAILABLE: 조회 권한과 지표 제공 여부를 확인해주세요.",
        );
      if (
        results.some((post) =>
          post.metrics.some((metric) => metric.status === "permission_denied"),
        )
      )
        throw new Error("INSTAGRAM_PERMISSION: 인사이트 조회 권한 부족");
      signal?.throwIfAborted();
      const snapshot = instagramSnapshotSchema.parse({
        schemaVersion: 1,
        id: randomUUID(),
        collectedAt,
        source,
        tokenHealth: tokenHealth(settings.tokenExpiresAt),
        completedAt: new Date().toISOString(),
        apiVersion: client.apiVersion,
        login: settings.login,
        account,
        ownedMediaCount: media.length,
        media: results,
      });
      onWrite?.("unknown");
      const directory = path.join(this.root, "instagram-snapshots");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(
        path.join(directory, `${snapshot.id}.json`),
        snapshot,
        { mode: 0o600 },
      );
      const history = await this.index();
      await writeJsonAtomic(
        path.join(this.root, "instagram-history.json"),
        [
          {
            id: snapshot.id,
            username: account.username,
            collectedAt,
            source,
            count: results.length,
          },
          ...history,
        ],
        { mode: 0o600 },
      );
      onWrite?.("applied");
      result = await this.get();
      result.busy = false;
    });
    this.changed();
    return result;
  }
  async setTopics(value: unknown) {
    const input = instagramTopicsInput.parse(value);
    await this.exclusive(async () => {
      const current = await this.settings();
      if (!current) throw new Error("INSTAGRAM_NOT_CONNECTED");
      const state = await this.get();
      const ids = new Set(state.snapshot?.media.map((p) => p.id));
      if (Object.keys(input).some((id) => !ids.has(id)))
        throw new Error(
          "INSTAGRAM_MEDIA: 현재 계정의 게시물만 분류할 수 있어요.",
        );
      await writeJsonAtomic(
        path.join(this.root, "instagram-connection.json"),
        { ...current, topics: { ...current.topics, ...input } },
        { mode: 0o600 },
      );
    });
    this.changed();
    return this.get();
  }
}
