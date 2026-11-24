import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { copyFile, mkdir, writeFile, readFile, realpath, stat } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { cleanProfile, closeApp, editorRuntime, launchApp, makeProfile } from "./helpers";

test("촬영 원본에서 단어 시각을 추출해 같은 회차 카드와 작업 폴더에 연결한다", async () => {
  test.skip(process.env.REELS_EPISODE_STT_QA !== "1", "Mac에 캐시된 MLX 모델 사용");
  test.setTimeout(240_000);
  const profile = await realpath(await makeProfile());
  const episode = path.join(profile, "EP04");
  const source = path.join(episode, "source", "sample.mov");
  const work = path.join(episode, "work");
  const exec = promisify(execFile);
  let app: Awaited<ReturnType<typeof launchApp>> | undefined;
  try {
    await mkdir(path.dirname(source), { recursive: true });
    const voice = path.join(profile, "speech.aiff");
    await exec("/usr/bin/say", ["-v", "Yuna", "-o", voice, "안녕하세요. 오늘은 한국어 영상을 편집하는 방법을 알아보겠습니다."]);
    await exec(path.join(editorRuntime(), "bin/ffmpeg"), ["-v", "error", "-f", "lavfi", "-i", "color=s=160x90:r=5", "-i", voice,
      "-shortest", "-c:v", "libx264", "-c:a", "aac", source]);
    await writeFile(path.join(profile, "dashboard.json"), JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(),
      projects: [{ id: "episode", title: "후라이윤 EP04 테스트", stage: "editing", nextAction: "촬영 원본 전사", date: "2026-11-25", shared: false, publicURL: "",
        resources: [{ role: "footage", path: source, label: "촬영 원본" }] }] }));
    app = await launchApp(profile, false);
    const page = await app.firstWindow();
    const card = page.locator(".project-card").filter({ hasText: "후라이윤 EP04 테스트" });
    await card.getByRole("button", { name: "원본 전사", exact: true }).click();
    await expect(card.getByRole("status")).toContainText("전사를 마쳤어요", { timeout: 160_000 });
    const data = JSON.parse(await readFile(path.join(work, "transcript.json"), "utf8"));
    const words = JSON.parse(await readFile(path.join(work, "words.json"), "utf8"));
    expect(words.length).toBeGreaterThan(0);
    const rounded = (n: number) => Math.round(n * 1000) / 1000;
    expect(words).toEqual(data.segments.flatMap((s: { words: { word: string; start: number; end: number; probability: number }[] }) =>
      s.words.map(w => ({ word: w.word, start: rounded(w.start), end: rounded(w.end), p: rounded(w.probability) }))));
    expect(await readFile(path.join(work, "transcript.md"), "utf8")).toContain("사람 확인 전");
    const originalTime = (await stat(path.join(work, "transcript.json"))).mtimeMs;
    await card.getByRole("button", { name: "원본 전사", exact: true }).click();
    await expect(card.getByRole("status")).toContainText("기존 전사", { timeout: 30_000 });
    expect((await stat(path.join(work, "transcript.json"))).mtimeMs).toBe(originalTime);
    const saved = JSON.parse(await readFile(path.join(profile, "dashboard.json"), "utf8"));
    expect(saved.projects[0].resources).toHaveLength(4);

    const second = path.join(path.dirname(source), "other.mov");
    await copyFile(source, second);
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, second);
    await card.getByLabel("전사할 원본").selectOption("");
    await card.getByRole("button", { name: "원본 전사", exact: true }).click();
    await expect(card.getByRole("status")).toContainText("전사를 마쳤어요", { timeout: 90_000 });
    const after = JSON.parse(await readFile(path.join(profile, "dashboard.json"), "utf8"));
    expect(after.projects[0].resources).toHaveLength(8);
    const secondWords = after.projects[0].resources.find((r: {label: string}) => r.label === "other.mov · words.json");
    expect(secondWords.path.startsWith(path.join(work, "원본전사") + path.sep)).toBe(true);
    expect((await stat(path.join(work, "transcript.json"))).mtimeMs).toBe(originalTime);
  } finally { await closeApp(app); await cleanProfile(profile); }
});
