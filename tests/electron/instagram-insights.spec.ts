import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchApp, closeApp, makeProfile, cleanProfile } from "./helpers";

test("Instagram token stays in main while MCP collection, private history and UI share the same service", async ({}, info) => {
  test.setTimeout(120000);
  const profile = await makeProfile();
  const credential = path.join(profile, "credential");
  const token = "synthetic-private-credential-" + "x".repeat(60);
  await writeFile(credential, token, { mode: 0o600 });
  let app = await launchApp(profile, false, { REELS_QA_STUBBED_DIALOGS: "1" });
  let page = await app.firstWindow();
  const client = new Client({ name: "instagram-qa", version: "1" });
  try {
    await app.evaluate(
      ({ dialog }, { credential, profile }) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [credential],
        })) as typeof dialog.showOpenDialog;
        dialog.showSaveDialog = (async () => ({
          canceled: false,
          filePath: profile + "/public-snapshot.json",
        })) as typeof dialog.showSaveDialog;
        globalThis.fetch = async (input: any) => {
          const url = new URL(String(input));
          if (url.origin !== "https://graph.facebook.com")
            throw new Error("Unexpected origin");
          if (url.pathname.endsWith("/assigned_instagram_accounts"))
            return Response.json({
              data: [{ id: "10001", username: "creator_demo" }],
            });
          if (url.pathname.endsWith("/10001"))
            return Response.json({
              id: "10001",
              username: "creator_demo",
              followers_count: 200,
              media_count: 1,
            });
          if (url.pathname.endsWith("/media"))
            return Response.json({
              data: [
                {
                  id: "101",
                  permalink: "https://www.instagram.com/reel/Example101/",
                  media_type: "VIDEO",
                  media_product_type: "REELS",
                  timestamp: "2026-09-24T12:00:00+0000",
                  caption: "Synthetic private insight",
                },
              ],
            });
          await new Promise((resolve) => setTimeout(resolve, 300));
          return Response.json({
            data: [
              "views",
              "reach",
              "likes",
              "comments",
              "saved",
              "shares",
            ].map((name) => ({
              name,
              values: [
                { value: name === "reach" ? 100 : name === "views" ? 500 : 10 },
              ],
            })),
          });
        };
      },
      { credential, profile },
    );
    await page
      .getByRole("navigation", { name: "주요 메뉴" })
      .getByRole("button", { name: "Instagram 인사이트", exact: true })
      .click();
    await page.getByLabel("Instagram 사용자 이름").fill("creator_demo");
    await page
      .getByRole("button", { name: "조회 토큰 파일 연결", exact: true })
      .click();
    await expect(
      page.getByText("@creator_demo", { exact: true }),
    ).toBeVisible();
    const before = await page.evaluate(() => window.reels!.loadDashboard());
    await expect
      .poll(() =>
        access(path.join(profile, "agent/connection.json")).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("dist-mcp/server.mjs")],
        env: {
          ...(process.env as Record<string, string>),
          REELS_USER_DATA: profile,
        },
      }),
    );
    const call = async (name: string, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).not.toBe(true);
      return result.structuredContent as any;
    };
    await call("reels_refresh_instagram_insights");
    await expect
      .poll(async () => {
        const s = await call("reels_get_instagram_insights");
        return {
          busy: s.busy,
          count: s.snapshot?.media.length,
          error: s.lastError,
        };
      })
      .toEqual({ busy: false, count: 1, error: null });
    await expect(
      page.getByRole("table").getByText("500", { exact: true }),
    ).toBeVisible();
    await call("reels_set_instagram_topics", { topics: { 101: "체험" } });
    await expect(page.getByLabel("101 주제")).toHaveValue("체험");
    const state = await page.evaluate(() =>
      window.reels!.instagramInsights!.get(),
    );
    expect(JSON.stringify(state)).not.toContain(token);
    expect(JSON.stringify(state)).not.toContain(credential);
    expect(await page.evaluate(() => window.reels!.loadDashboard())).toEqual(
      before,
    );
    await page.evaluate(() => window.reels!.exportSnapshot());
    const exported = await readFile(
      path.join(profile, "public-snapshot.json"),
      "utf8",
    );
    expect(exported).not.toContain("creator_demo");
    expect(exported).not.toContain(token);
    expect(Object.keys(JSON.parse(exported)).sort()).toEqual([
      "generatedAt",
      "projects",
      "schemaVersion",
    ]);
    await page.screenshot({
      path: info.outputPath("instagram-desktop.png"),
      fullPage: true,
    });
    await client.close();
    await closeApp(app);
    app = await launchApp(profile, false);
    page = await app.firstWindow();
    const reopened = await page.evaluate(() =>
      window.reels!.instagramInsights!.get(),
    );
    expect(reopened.snapshot?.id).toBe(state.snapshot?.id);
    expect(reopened.topics["101"]).toBe("체험");
  } finally {
    await client.close();
    await closeApp(app);
    await cleanProfile(profile);
  }
});

test("Electron demo mode never reads a real profile's Instagram connection or cache", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { fixtureSnapshot } = await import("../fixtures/instagram-insights");
  const profile = await makeProfile();
  const snapshot = fixtureSnapshot();
  const credential = path.join(profile, "private-token");
  const privateSettings = {
    username: "creator_demo",
    login: "unified",
    tokenFile: credential,
    topics: { 101: "private-topic" },
  };
  await mkdir(path.join(profile, "instagram-snapshots"), { recursive: true });
  await writeFile(credential, "synthetic-credential-" + "x".repeat(60), {
    mode: 0o600,
  });
  await writeFile(
    path.join(profile, "instagram-connection.json"),
    JSON.stringify(privateSettings),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(profile, "instagram-history.json"),
    JSON.stringify([
      {
        id: snapshot.id,
        username: snapshot.account.username,
        collectedAt: snapshot.collectedAt,
        count: snapshot.media.length,
      },
    ]),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(profile, "instagram-snapshots", snapshot.id + ".json"),
    JSON.stringify(snapshot),
    { mode: 0o600 },
  );
  const app = await launchApp(profile, true);
  try {
    const page = await app.firstWindow();
    const state = await page.evaluate(async () => ({
      get: await window.reels!.instagramInsights!.get(),
      refresh: await window.reels!.instagramInsights!.refresh(),
    }));
    expect(state.get.connection).toBeNull();
    expect(state.get.snapshot).toBeNull();
    expect(state.get.history).toEqual([]);
    expect(state.refresh.snapshot).toBeNull();
    expect(
      JSON.parse(
        await readFile(path.join(profile, "instagram-connection.json"), "utf8"),
      ),
    ).toEqual(privateSettings);
  } finally {
    await closeApp(app);
    await cleanProfile(profile);
  }
});
