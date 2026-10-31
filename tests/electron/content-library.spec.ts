import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { writeFile, access } from "node:fs/promises";
import path from "node:path";
import { launchApp, closeApp, makeProfile, cleanProfile } from "./helpers";

test("MCP registers local content, refreshes UI, rejects stale writes and restores links", async () => {
  const profile = await makeProfile();
  let app = await launchApp(profile, false);
  const client = new Client({ name: "content-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist-mcp/server.mjs")],
    env: {
      ...(process.env as Record<string, string>),
      REELS_USER_DATA: profile,
    },
  });
  async function call(name: string, args: Record<string, unknown> = {}) {
    const r = await client.callTool({ name, arguments: args });
    expect(r.isError, JSON.stringify(r.content)).not.toBe(true);
    return r.structuredContent as any;
  }
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
    await call("reels_get_app_state");
    const source = path.join(profile, "완성 영상.mp4");
    await writeFile(source, "synthetic link fixture");
    const before = await call("reels_list_projects");
    const content = {
      id: "content-example",
      title: "기존 완성 콘텐츠",
      date: "2026-10-27",
      dateBasis: "publication",
      stage: "published",
      nextAction: "기존 게시 기록",
      publicURL: "https://example.com/reel",
      localNotes: "local-only",
      resources: [{ role: "final", path: source, label: "확정 영상" }],
    };
    const saved = await call("reels_upsert_content", {
      content,
      expectedUpdatedAt: before.dashboard.updatedAt,
    });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "전체 콘텐츠 보기", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: content.title }),
    ).toBeVisible();
    await page.locator("summary").filter({ hasText: "연결 자료 1개" }).click();
    await expect(page.getByText("완성본 · 확정 영상")).toBeVisible();
    const stale = await client.callTool({
      name: "reels_upsert_content",
      arguments: {
        content: { ...content, title: "stale" },
        expectedUpdatedAt: before.dashboard.updatedAt,
      },
    });
    expect(stale.isError).toBe(true);
    expect((await call("reels_list_projects")).editorProjects).toHaveLength(0);
    expect(saved.resources[0].available).toBe(true);
    await closeApp(app);
    app = await launchApp(profile, false);
    await expect
      .poll(async () => {
        try {
          return (await call("reels_get_content", { projectId: content.id }))
            .project.title;
        } catch {
          return "offline";
        }
      })
      .toBe(content.title);
    expect(
      (await call("reels_get_content", { projectId: content.id })).resources[0]
        .available,
    ).toBe(true);
  } finally {
    await client.close();
    await transport.close();
    await closeApp(app);
    await cleanProfile(profile);
  }
});
