import { editOwner, recordExports } from "../shared/production-project";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  stat,
  copyFile,
  link,
  rm,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  cardPlanSchema,
  templateContent,
  type CardPlan,
  type CardAsset,
  type CardJob,
  type CardNewsBridge,
} from "../shared/card-news";
import { timeline, musicError, videoError } from "../shared/card-news-model";
import type { LocalStore } from "../shared/lib/storage";
import type { Dashboard } from "../shared/contracts";

const execute = promisify(execFile);
type AssetRecord = {
  id: string;
  kind: "image" | "audio" | "video";
  name: string;
  file: string;
  mime: string;
  duration?: number;
};
type Options = {
  root: string;
  runtime: string;
  store: LocalStore;
  chooseAsset(kind: "image" | "audio" | "video"): Promise<string | null>;
  chooseOutput(name: string): Promise<string | null>;
  normalizeImage(data: Buffer): Buffer;
  validateFrame(data: Buffer): void;
  reveal(file: string): void;
  changed(dashboard: Dashboard): void;
};
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value))
    throw new Error("알 수 없는 카드뉴스 ID예요.");
  return value;
}
export class CardNewsService implements CardNewsBridge {
  private queue: Promise<unknown> = Promise.resolve();
  private jobs = new Map<string, CardJob>();
  private child?: ChildProcess;
  private current?: CardJob;
  private pending = false;
  private cancelRequested = new Set<string>();
  private get directory() {
    return path.join(this.options.root, "card-news");
  }
  get busy() {
    return this.pending || Boolean(this.current);
  }
  constructor(private options: Options) {}
  private async initialize() {
    for (const name of ["plans", "assets", "jobs"])
      await mkdir(path.join(this.directory, name), {
        recursive: true,
        mode: 0o700,
      });
  }
  private planFile(value: string) {
    return path.join(this.directory, "plans", `${id(value)}.json`);
  }
  private async record(value: string): Promise<AssetRecord> {
    const record: AssetRecord = JSON.parse(
      await readFile(
        path.join(this.directory, "assets", `${id(value)}.json`),
        "utf8",
      ),
    );
    if (record.id !== value || path.basename(record.file) !== record.file)
      throw new Error("잘못된 미디어 기록이에요.");
    return record;
  }
  private assetPath(record: AssetRecord) {
    return path.join(this.directory, "assets", record.file);
  }
  private async asset(record: AssetRecord): Promise<CardAsset> {
    return {
      id: record.id,
      name: record.name,
      kind: record.kind,
      duration: record.duration,
      url: `data:${record.mime};base64,${(await readFile(this.assetPath(record))).toString("base64")}`,
    };
  }
  async list() {
    await this.initialize();
    const plans = await Promise.all(
      (await readdir(path.join(this.directory, "plans")))
        .filter((n) => n.endsWith(".json"))
        .map(async (name) => {
          const p = cardPlanSchema.parse(
            JSON.parse(
              await readFile(path.join(this.directory, "plans", name), "utf8"),
            ),
          );
          return { id: p.id, title: p.title, updatedAt: p.updatedAt };
        }),
    );
    return plans.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async load(value: string) {
    const plan = cardPlanSchema.parse(
      JSON.parse(await readFile(this.planFile(value), "utf8")),
    );
    const ids = new Set(
      [
        ...plan.cards.flatMap((c) => [c.imageId, c.overlayId]),
        plan.music.assetId,
      ].filter((v): v is string => Boolean(v)),
    );
    return {
      plan,
      assets: await Promise.all(
        [...ids].map(async (value) => this.asset(await this.record(value))),
      ),
    };
  }
  private async validateAssets(plan: CardPlan) {
    for (const card of plan.cards) {
      templateContent(card);
      if (card.imageId) {
        const asset = await this.record(card.imageId);
        if (asset.kind === "audio")
          throw new Error("사진 또는 영상을 선택해주세요.");
        if (asset.kind === "video") {
          const error = videoError(card, asset.duration);
          if (error) throw new Error(error);
        }
      }
      if (
        card.overlayId &&
        (await this.record(card.overlayId)).kind !== "image"
      )
        throw new Error("오버레이는 PNG 이미지를 선택해주세요.");
      if (
        card.overlayId &&
        (!card.imageId || (await this.record(card.imageId)).kind !== "video")
      )
        throw new Error("오버레이는 영상 배경에서 사용해주세요.");
    }
    if (
      plan.music.assetId &&
      (await this.record(plan.music.assetId)).kind !== "audio"
    )
      throw new Error("음악 파일을 선택해주세요.");
  }
  async save(input: CardPlan): Promise<CardPlan> {
    const plan = cardPlanSchema.parse(input);
    const operation = this.queue.then(async () => {
      await this.initialize();
      await this.validateAssets(plan);
      let previous: CardPlan | undefined;
      try {
        previous = cardPlanSchema.parse(
          JSON.parse(await readFile(this.planFile(plan.id), "utf8")),
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if ((previous?.updatedAt ?? "") !== plan.updatedAt)
        throw new Error(
          "다른 창에서 변경된 구성입니다. 다시 열어 확인해주세요.",
        );
      const next = {
        ...plan,
        updatedAt: new Date(
          Math.max(
            Date.now(),
            Date.parse(previous?.updatedAt || "1970-01-01") + 1,
          ),
        ).toISOString(),
      };
      await this.options.store.atomic(this.planFile(plan.id), next);
      return next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async chooseAsset(kind: "image" | "audio" | "video") {
    if (!["image", "audio", "video"].includes(kind))
      throw new Error("지원하지 않는 미디어예요.");
    const source = await this.options.chooseAsset(kind);
    if (!source) return null;
    await this.initialize();
    const info = await stat(source);
    if (
      !info.isFile() ||
      info.size > (kind === "video" ? 512 : 40) * 1024 * 1024
    )
      throw new Error(
        kind === "video"
          ? "512MB 이하의 영상을 선택해주세요."
          : "40MB 이하의 파일을 선택해주세요.",
      );
    const assetId = randomUUID();
    const ext = path.extname(source).toLowerCase();
    let record: AssetRecord;
    if (kind === "video") {
      if (![".mp4", ".mov", ".m4v"].includes(ext))
        throw new Error("MP4·MOV·M4V 영상을 선택해주세요.");
      const probe = JSON.parse(
        (
          await execute(
            path.join(this.options.runtime, "bin/ffprobe"),
            [
              "-v",
              "error",
              "-select_streams",
              "v:0",
              "-show_entries",
              "stream=color_transfer:format=duration",
              "-of",
              "json",
              source,
            ],
            { timeout: 30000 },
          )
        ).stdout,
      );
      const duration = Number(probe.format?.duration);
      if (
        !probe.streams?.length ||
        !Number.isFinite(duration) ||
        duration <= 0 ||
        duration > 600
      )
        throw new Error("10분 이내의 재생 가능한 영상을 선택해주세요.");
      record = {
        id: assetId,
        kind,
        name: path.basename(source),
        file: `${assetId}.mp4`,
        mime: "video/mp4",
        duration,
      };
      const hdr = ["smpte2084", "arib-std-b67"].includes(
        probe.streams[0].color_transfer,
      );
      const tone = hdr
        ? "zscale=t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,"
        : "";
      try {
        await execute(
          path.join(this.options.runtime, "bin/ffmpeg"),
          [
            "-n",
            "-v",
            "error",
            "-i",
            source,
            "-vf",
            tone +
              "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1,fps=30,format=yuv420p",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-movflags",
            "+faststart",
            this.assetPath(record),
          ],
          { timeout: 600000 },
        );
        if ((await stat(this.assetPath(record))).size > 80 * 1024 * 1024)
          throw new Error(
            "미리보기 영상이 너무 커요. 짧은 구간을 선택해주세요.",
          );
      } catch (e) {
        await rm(this.assetPath(record), { force: true });
        throw e;
      }
    } else if (kind === "image") {
      const data = this.options.normalizeImage(await readFile(source));
      record = {
        id: assetId,
        kind,
        name: path.basename(source),
        file: `${assetId}.png`,
        mime: "image/png",
      };
      await writeFile(this.assetPath(record), data, {
        flag: "wx",
        mode: 0o600,
      });
    } else {
      if (![".mp3", ".m4a", ".wav", ".aac"].includes(ext))
        throw new Error("MP3·M4A·WAV·AAC 파일을 선택해주세요.");
      const probe = JSON.parse(
        (
          await execute(
            path.join(this.options.runtime, "bin/ffprobe"),
            [
              "-v",
              "error",
              "-select_streams",
              "a:0",
              "-show_entries",
              "stream=index:format=duration",
              "-of",
              "json",
              source,
            ],
            { timeout: 30000 },
          )
        ).stdout,
      );
      const duration = Number(probe.format?.duration);
      if (
        !probe.streams?.length ||
        !Number.isFinite(duration) ||
        duration <= 0 ||
        duration > 86400
      )
        throw new Error("길이를 읽을 수 있는 음악 파일을 선택해주세요.");
      record = {
        id: assetId,
        kind,
        name: path.basename(source),
        file: `${assetId}${ext}`,
        mime:
          ext === ".wav"
            ? "audio/wav"
            : ext === ".m4a"
              ? "audio/mp4"
              : ext === ".aac"
                ? "audio/aac"
                : "audio/mpeg",
        duration,
      };
      await copyFile(source, this.assetPath(record), constants.COPYFILE_EXCL);
    }
    await writeFile(
      path.join(this.directory, "assets", `${assetId}.json`),
      JSON.stringify(record),
      { flag: "wx", mode: 0o600 },
    );
    return this.asset(record);
  }
  private async templateFrames(plan: CardPlan, work: string) {
    const cards = await Promise.all(
      plan.cards.map(async (card) => {
        const asset = card.imageId
          ? await this.record(card.imageId)
          : undefined;
        return {
          content: templateContent(card),
          background: asset?.kind === "image" ? this.assetPath(asset) : null,
        };
      }),
    );
    const request = path.join(work, "template-request.json");
    await writeFile(
      request,
      JSON.stringify({ cards, darkness: plan.style.darkness }),
      { mode: 0o600 },
    );
    await execute(
      path.join(this.options.runtime, "reels-editor"),
      ["card-frames", request, work],
      { timeout: 60000 },
    );
    return Promise.all(
      plan.cards.map(
        async (_, i) =>
          "data:image/png;base64," +
          (await readFile(path.join(work, `${i}.png`))).toString("base64"),
      ),
    );
  }
  async preview(input: CardPlan) {
    const plan = cardPlanSchema.parse(input);
    await this.initialize();
    await this.validateAssets(plan);
    const work = path.join(this.directory, "jobs", randomUUID());
    await mkdir(work, { mode: 0o700 });
    try {
      return await this.templateFrames(plan, work);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }
  async export(input: CardPlan, frames: string[]): Promise<CardJob | null> {
    if (this.busy)
      throw new Error("진행 중인 카드뉴스 내보내기를 먼저 마쳐주세요.");
    this.pending = true;
    let work: string | undefined;
    try {
      const plan = cardPlanSchema.parse(input);
      await this.validateAssets(plan);
      const saved = cardPlanSchema.parse(
        JSON.parse(await readFile(this.planFile(plan.id), "utf8")),
      );
      if (JSON.stringify(saved) !== JSON.stringify(plan))
        throw new Error("최신 구성을 저장한 뒤 내보내주세요.");
      if (
        plan.cards.some(
          (c) => (!c.imageOnly && !c.overlayId && !c.text.trim()) || !c.imageId,
        )
      )
        throw new Error("모든 카드에 사진 또는 영상과 문구를 넣어주세요.");
      if (!Array.isArray(frames) || frames.length !== plan.cards.length)
        throw new Error("카드 미리보기가 준비되지 않았어요.");
      // Never trust caller-rendered PNGs: regenerate from the fixed template contract.
      const generated = await this.preview(plan);
      const buffers = generated.map((frame) => {
        if (
          typeof frame !== "string" ||
          frame.length > 16 * 1024 * 1024 ||
          !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(frame)
        )
          throw new Error("잘못된 카드 이미지예요.");
        const data = Buffer.from(frame.split(",")[1], "base64");
        this.options.validateFrame(data);
        return data;
      });
      if (
        buffers.reduce((size, data) => size + data.length, 0) >
        100 * 1024 * 1024
      )
        throw new Error("카드 이미지 합계가 너무 커요. 카드 수를 줄여주세요.");
      const music = plan.music.assetId
        ? await this.record(plan.music.assetId)
        : undefined;
      const invalid = musicError(plan, music?.duration);
      if (invalid) throw new Error(invalid);
      const output = await this.options.chooseOutput(
        `${plan.title.replace(/[\\/:*?"<>|]/g, "_")}.mp4`,
      );
      if (!output) return null;
      if (path.extname(output).toLowerCase() !== ".mp4")
        throw new Error("MP4 파일 이름을 지정해주세요.");
      try {
        await stat(output);
        throw new Error("기존 파일을 덮어쓰지 않아요. 새 이름을 지정해주세요.");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const job: CardJob = { id: randomUUID(), state: "running", progress: 0 };
      work = path.join(this.directory, "jobs", job.id);
      await mkdir(work, { mode: 0o700 });
      const segments = timeline(plan.cards),
        total = segments.at(-1)!.end;
      for (let i = 0; i < buffers.length; i++)
        await writeFile(path.join(work, `${i}.png`), buffers[i], {
          mode: 0o600,
        });
      await writeFile(
        path.join(work, "plan.json"),
        JSON.stringify(plan, null, 2),
        { mode: 0o600 },
      );
      this.jobs.set(job.id, job);
      this.current = job;
      void this.render(job, plan, total, work, output, music);
      return { ...job };
    } catch (e) {
      if (work) await rm(work, { recursive: true, force: true });
      throw e;
    } finally {
      this.pending = false;
    }
  }
  private async render(
    job: CardJob,
    plan: CardPlan,
    total: number,
    work: string,
    output: string,
    music?: AssetRecord,
  ) {
    // Encode to a private temp first, then publish exclusively. Never overwrite an output.
    const temporary = path.join(path.dirname(output), `.reels-${job.id}.mp4`);
    let published = false;
    try {
      const args = ["-n", "-v", "error", "-filter_complex_threads", "1"];
      const filters: string[] = [];
      let input = 0;
      for (let i = 0; i < plan.cards.length; i++) {
        const card = plan.cards[i];
        const asset = await this.record(card.imageId!);
        const duration = Math.round(card.seconds * 30) / 30;
        if (asset.kind === "video") {
          args.push(
            "-ss",
            String(card.videoStart ?? 0),
            "-t",
            String(duration),
            "-i",
            this.assetPath(asset),
          );
          const video = input++;
          args.push(
            "-loop",
            "1",
            "-framerate",
            "30",
            "-i",
            path.join(work, `${i}.png`),
          );
          const overlay = input++;
          filters.push(
            `[${video}:v]fps=30,trim=duration=${duration},setpts=PTS-STARTPTS,setsar=1[v${i}]`,
          );
          filters.push(
            `[v${i}][${overlay}:v]overlay=0:0:shortest=1,trim=duration=${duration},setpts=PTS-STARTPTS,format=yuv420p[s${i}]`,
          );
        } else {
          args.push(
            "-loop",
            "1",
            "-framerate",
            "30",
            "-i",
            path.join(work, `${i}.png`),
          );
          filters.push(
            `[${input++}:v]trim=duration=${duration},setpts=PTS-STARTPTS,setsar=1,format=yuv420p[s${i}]`,
          );
        }
      }
      filters.push(
        plan.cards.map((_, i) => `[s${i}]`).join("") +
          `concat=n=${plan.cards.length}:v=1:a=0[v]`,
      );
      if (music) {
        if (plan.music.loop) args.push("-stream_loop", "-1");
        args.push(
          "-ss",
          String(plan.music.offset),
          "-i",
          this.assetPath(music),
        );
        filters.push(
          `[${input}:a]asetpts=PTS-STARTPTS,volume=${plan.music.volume},afade=t=out:st=${Math.max(0, total - 0.25)}:d=0.25,apad[a]`,
        );
      }
      args.push("-filter_complex", filters.join(";"), "-map", "[v]");
      if (music) args.push("-map", "[a]", "-c:a", "aac", "-b:a", "192k");
      else args.push("-an");
      args.push(
        "-t",
        String(total),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        temporary,
      );
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          path.join(this.options.runtime, "bin/ffmpeg"),
          args,
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        this.child = child;
        let errors = "",
          progress = "";
        const timeout = setTimeout(() => child.kill("SIGKILL"), 15 * 60 * 1000);
        child.stderr.on("data", (chunk) => {
          errors = (errors + chunk).slice(-4000);
        });
        child.stdout.on("data", (chunk) => {
          progress += chunk;
          const lines = progress.split("\n");
          progress = lines.pop()!;
          for (const line of lines)
            if (line.startsWith("out_time_us="))
              job.progress =
                Math.min(
                  99,
                  Math.round((Number(line.split("=")[1]) / 1e6 / total) * 100),
                ) || 0;
        });
        child.on("error", (e) => {
          clearTimeout(timeout);
          reject(e);
        });
        child.on("close", (code) => {
          clearTimeout(timeout);
          code === 0
            ? resolve()
            : reject(new Error(errors || "영상 내보내기에 실패했어요."));
        });
      });
      if (this.cancelRequested.has(job.id)) {
        job.state = "cancelled";
        return;
      }
      await link(temporary, output);
      published = true;
      job.outputPath = output;
      const dashboard = await this.options.store.update((current) => {
        const edit = { kind: "card-news" as const, id: plan.id };
        const existing = editOwner(current, edit);
        const next = {
          ...existing,
          id: existing?.id ?? plan.id,
          title: existing?.title ?? plan.title,
          date: existing?.date ?? new Date().toISOString().slice(0, 10),
          dateBasis: existing?.dateBasis ?? ("record" as const),
          stage:
            existing?.stage === "published"
              ? ("published" as const)
              : ("review" as const),
          nextAction:
            existing?.stage === "published"
              ? existing.nextAction
              : "카드뉴스 MP4 확인",
          publicURL: existing?.publicURL ?? "",
          shared: existing?.shared ?? false,
          resources: [
            ...(existing?.resources ?? []).filter(
              (r) => !(r.path === output && r.role === "draft"),
            ),
            { role: "draft" as const, path: output, label: "카드뉴스 MP4" },
          ],
        };
        const item = {
          ...next,
          production: recordExports(
            next,
            edit,
            [{ role: "draft", path: output, label: "카드뉴스 MP4" }],
            new Date().toISOString(),
            randomUUID,
          ),
        };
        return {
          ...current,
          projects: existing
            ? current.projects.map((p) => (p.id === item.id ? item : p))
            : [...current.projects, item],
        };
      });
      this.options.changed(dashboard);
      job.state = "completed";
      job.progress = 100;
    } catch (e) {
      if (published) {
        job.state = "completed";
        job.progress = 100;
        job.error = "MP4는 저장됐지만 보드 연결에 실패했어요.";
      } else if (this.cancelRequested.has(job.id)) {
        job.state = "cancelled";
      } else {
        job.state = "failed";
        job.error = e instanceof Error ? e.message : String(e);
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
      await rm(work, { recursive: true, force: true }).catch(() => {});
      this.child = undefined;
      this.current = undefined;
      this.cancelRequested.delete(job.id);
    }
  }
  async job(value: string) {
    const job = this.jobs.get(id(value));
    if (!job) throw new Error("내보내기 작업을 찾을 수 없어요.");
    return { ...job };
  }
  async cancel(value: string) {
    const job = this.jobs.get(id(value));
    if (job?.state === "running" && this.current?.id === value) {
      this.cancelRequested.add(job.id);
      this.child?.kill("SIGKILL");
    }
  }
  async reveal(value: string) {
    const job = await this.job(value);
    if (job.state !== "completed" || !job.outputPath)
      throw new Error("완료된 파일이 없어요.");
    this.options.reveal(job.outputPath);
  }
}
