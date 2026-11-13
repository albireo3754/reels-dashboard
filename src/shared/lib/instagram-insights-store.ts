import path from "node:path";
import { mkdir, readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  InstagramInsightsClient,
  InstagramApiError,
  CORE_METRICS,
} from "../../../packages/instagram-insights/index.mjs";
import {
  instagramConnectionInput,
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
  }),
);
const stateInput = z.strictObject({ snapshotId: z.string().uuid().optional() });
export class InstagramInsightsStore {
  private running = false;
  private lastError: string | null = null;
  constructor(
    private root: string,
    private fetchImpl?: (url: URL, init: RequestInit) => Promise<Response>,
    private changed: () => void = () => {},
  ) {}
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
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.running)
      throw new Error(
        "INSTAGRAM_BUSY: 현재 가져오기가 끝난 뒤 다시 시도해주세요.",
      );
    this.running = true;
    try {
      return await work();
    } finally {
      this.running = false;
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
        ? { username: settings.username, login: settings.login, tokenReady }
        : null,
      snapshot,
      history: history.slice(0, 50).map(({ username: _, ...entry }) => entry),
      topics: settings?.topics ?? {},
      busy: this.running,
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
        this.lastError =
          error instanceof InstagramApiError
            ? error.message
            : "Instagram 가져오기를 완료하지 못했어요. 계정 연결을 확인해주세요. 이전 수집 기록은 유지돼요.";
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
  async refresh() {
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
        fetchImpl: this.fetchImpl,
      });
      const account = await client.account();
      const media = (await client.media(account)).sort(
        (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
      );
      const results = [];
      for (const post of media.slice(0, 100))
        results.push({
          ...post,
          metrics: (await client.insights(post, CORE_METRICS)).metrics,
        });
      if (results.length && results.every(post => post.metrics.every(metric => metric.status !== "available")))
        throw new Error("INSTAGRAM_INSIGHTS_UNAVAILABLE: 조회 권한과 지표 제공 여부를 확인해주세요.");
      const snapshot = instagramSnapshotSchema.parse({
        schemaVersion: 1,
        id: randomUUID(),
        collectedAt,
        completedAt: new Date().toISOString(),
        apiVersion: client.apiVersion,
        login: settings.login,
        account,
        ownedMediaCount: media.length,
        media: results,
      });
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
            count: results.length,
          },
          ...history,
        ],
        { mode: 0o600 },
      );
    });
    return this.get();
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
