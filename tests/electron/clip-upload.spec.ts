import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { access, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { launchApp, closeApp, makeProfile, cleanProfile } from "./helpers";

test("local signature and ASCII upload bundle work through UI, preload and real MCP without iCloud writes", async ({}, info) => {
  test.setTimeout(180_000);
  const profile = await realpath(await makeProfile());
  const folders: string[] = [];
  const app = await launchApp(profile, false);
  const page = await app.firstWindow();
  const client = new Client({ name: "clip-upload-qa", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist-mcp/server.mjs")],
    env: {
      ...(process.env as Record<string, string>),
      REELS_USER_DATA: profile,
    },
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent as any;
  };
  try {
    await expect
      .poll(() =>
        access(path.join(profile, "agent/connection.json")).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "reels_create_clip_upload_bundle",
        "reels_get_cover_preferences",
        "reels_set_cover_preferences",
      ]),
    );
    await page.getByRole("button", { name: "설정", exact: true }).click();
    await expect(page.getByLabel("계정 서명", { exact: true })).toHaveValue(
      "@your_account 🌹",
    );
    await page.getByLabel("계정 서명", { exact: true }).fill("@example 🌹");
    await page.getByRole("button", { name: "서명 저장", exact: true }).click();
    await expect(
      page.getByText("서명을 저장했어요. 새 미리보기를 만들어 확인해주세요."),
    ).toBeVisible();
    expect(await call("reels_get_cover_preferences")).toEqual({
      signature: "@example 🌹",
    });
    await page.screenshot({ path: info.outputPath("cover-settings.png") });
    await call("reels_set_cover_preferences", { signature: "@sample 🌹" });
    expect(
      await page.evaluate(() => window.reels!.coverPreferences!.get()),
    ).toEqual({ signature: "@sample 🌹" });
    const inputs = path.join(profile, "한글 자료");
    await mkdir(inputs);
    const video = path.join(inputs, "영상 원본.mp4"),
      cover = path.join(inputs, "표지 원본.png");
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=blue:s=720x1280:r=30:d=1.2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      video,
    ]);
    const originalHash = createHash("sha256")
      .update(await readFile(video))
      .digest("hex");
    let edit = await call("reels_import_video", { sourcePath: video });
    edit = await call("reels_update_project", {
      projectId: edit.id,
      expectedUpdatedAt: edit.updatedAt,
      patch: {
        place: { name: "서울" },
        cover: { hook: "함께 걷는\n가을 산책", time: 0.2 },
      },
    });
    const preview = await call("reels_preview_frame", {
      projectId: edit.id,
      expectedUpdatedAt: edit.updatedAt,
      kind: "cover",
    });
    expect(preview.manifest.signature.text).toBe("@sample 🌹");
    const job = await call("reels_start_render", {
      projectId: edit.id,
      expectedUpdatedAt: edit.updatedAt,
      target: "cover",
      outputPath: cover,
    });
    let final: any;
    await expect
      .poll(
        async () => {
          final = await call("reels_get_render_job", { jobId: job.id });
          return final.state;
        },
        { timeout: 60000 },
      )
      .toBe("completed");
    expect(
      JSON.parse(await readFile(final.manifestPaths[0], "utf8")).signature.text,
    ).toBe("@sample 🌹");
    await expect
      .poll(async () => (await call("reels_get_app_state")).context.busy)
      .toBe(false);
    const content = await call("reels_upsert_content", {
      expectedUpdatedAt: (await call("reels_list_projects")).dashboard
        .updatedAt,
      content: {
        id: "clip-qa",
        title: "합성 업로드 묶음",
        date: "2026-11-12",
        dateBasis: "record",
        stage: "review",
        nextAction: "",
        publicURL: "",
        localNotes: "",
        resources: [
          { role: "final", path: video, label: "영상" },
          { role: "cover", path: cover, label: "표지" },
        ],
      },
    });
    const input = {
      projectId: "clip-qa",
      expectedUpdatedAt: content.updatedAt,
      description: "가을 산책 🌳\n\n#서울",
    };
    const before = await readFile(path.join(profile, "dashboard.json"), "utf8");
    const bundle = await call("reels_create_clip_upload_bundle", input);
    folders.push(bundle.directory);
    expect(bundle.directory).toMatch(/^\/tmp\/reels-clip-[A-Za-z0-9]+$/);
    for (const file of [
      ...Object.values(bundle.files),
      bundle.receipt,
    ] as any[]) {
      const data = await readFile(file.path);
      expect(data.length).toBe(file.bytes);
      expect(createHash("sha256").update(data).digest("hex")).toBe(file.sha256);
    }
    expect(bundle.files.video.sha256).toBe(originalHash);
    expect(await readFile(bundle.files.description.path, "utf8")).toBe(
      input.description,
    );
    const coverBytes = await readFile(bundle.files.cover.path);
    expect(coverBytes.subarray(0, 2).toString("hex")).toBe("ffd8");
    const dimensions = await page.evaluate(async (data) => {
      const image = new Image();
      image.src = "data:image/jpeg;base64," + data;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    }, coverBytes.toString("base64"));
    expect(dimensions).toEqual([720, 1280]);
    expect(await readFile(path.join(profile, "dashboard.json"), "utf8")).toBe(
      before,
    );
    await page
      .getByRole("navigation", { name: "주요 메뉴" })
      .getByRole("button", { name: "대시보드", exact: true })
      .click();
    const card = page.locator(".project-card").filter({
      has: page.getByRole("heading", {
        name: "합성 업로드 묶음",
        exact: true,
      }),
    });
    await card.getByText("클립 업로드 묶음", { exact: true }).click();
    await card.getByLabel("클립 설명", { exact: true }).fill(input.description);
    await card
      .getByRole("button", { name: "업로드 묶음 만들기", exact: true })
      .click();
    await expect(
      card.getByText("묶음을 만들었어요. 업로드 후 임시 폴더를 지워주세요."),
    ).toBeVisible();
    const uiFolder = await card
      .locator('div[role="status"] > p.resource-path')
      .textContent();
    folders.push(uiFolder!);
    expect(
      await readFile(path.join(uiFolder!, "description.txt"), "utf8"),
    ).toBe(input.description);
    await card.screenshot({ path: info.outputPath("clip-bundle.png") });
  } finally {
    await client.close();
    await transport.close();
    await closeApp(app);
    for (const folder of folders)
      await rm(folder, { recursive: true, force: true });
    await cleanProfile(profile);
  }
});
