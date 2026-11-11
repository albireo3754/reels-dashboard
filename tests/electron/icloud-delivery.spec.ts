import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  mkdir,
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  rm,
  access,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchApp, closeApp, makeProfile, cleanProfile } from "./helpers";

test("MCP and desktop share delivery state through the real PhotosIndex iCloud endpoint", async () => {
  test.setTimeout(180_000);
  const profile = await realpath(await makeProfile());
  const live = process.env.REELS_ICLOUD_LIVE === "1";
  const cloudParent = live
    ? path.join(
        os.homedir(),
        "Library/Mobile Documents/com~apple~CloudDocs/Naver Clip",
      )
    : path.join(profile, "cloud");
  if (!live) await mkdir(cloudParent);
  const cloud = await realpath(
    await mkdtemp(path.join(cloudParent, "reels-delivery-qa-")),
  );
  const app = await launchApp(profile, false, {
    PHOTOSINDEX_EXPORT_ROOT: cloud,
  });
  let client: Client | undefined, transport: StdioClientTransport | undefined;
  async function connect() {
    client = new Client({ name: "icloud-delivery-qa", version: "1" });
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.resolve("dist-mcp/server.mjs")],
      env: {
        ...(process.env as Record<string, string>),
        REELS_USER_DATA: profile,
      },
    });
    await client.connect(transport);
  }
  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client!.callTool({ name, arguments: args });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent as any;
  }
  try {
    const page = await app.firstWindow();
    await expect
      .poll(async () =>
        access(path.join(profile, "agent/connection.json")).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    await connect();
    const names = (await client!.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "reels_icloud_status",
        "reels_start_icloud_delivery",
        "reels_get_icloud_delivery",
        "reels_set_project_outbound",
      ]),
    );
    await mkdir(path.join(profile, "inputs"));
    const source = path.join(profile, "inputs", "caption.txt");
    await writeFile(source, "Synthetic iCloud delivery QA\n");
    const list = await call("reels_list_projects");
    const content = await call("reels_upsert_content", {
      expectedUpdatedAt: list.dashboard.updatedAt,
      content: {
        id: "icloud-test",
        title: "Synthetic delivery",
        date: "2026-11-11",
        dateBasis: "record",
        stage: "review",
        nextAction: "",
        publicURL: "",
        localNotes: "",
        resources: [{ role: "document", path: source, label: "caption" }],
      },
    });
    const configured = await call("reels_set_project_outbound", {
      projectId: "icloud-test",
      expectedUpdatedAt: content.updatedAt,
      directory: path.join(cloud, "publish"),
    });
    const job = await call("reels_start_icloud_delivery", {
      projectId: "icloud-test",
      expectedUpdatedAt: configured.updatedAt,
      files: [{ sourcePath: source, name: "caption.txt", role: "document" }],
    });
    expect(job.state).toBe("copying");
    expect(
      (await call("reels_get_app_state")).deliveries.some(
        (j: any) => j.id === job.id,
      ),
    ).toBe(true);
    // Reconnect while the desktop continues owning the job.
    await client!.close();
    await transport!.close();
    await connect();
    let last: any;
    await expect
      .poll(
        async () => {
          last = await call("reels_get_icloud_delivery", { jobId: job.id });
          return last.state;
        },
        { timeout: 120_000, intervals: [250, 1000, 2000] },
      )
      .toBe(live ? "completed" : "failed");
    expect(last.upload, last.error).toBeDefined();
    expect(await readFile(source, "utf8")).toBe(
      "Synthetic iCloud delivery QA\n",
    );
    expect(
      await readFile(path.join(cloud, "publish/caption.txt"), "utf8"),
    ).toBe(await readFile(source, "utf8"));
    const ui = await page.evaluate(
      (id) => window.reels!.icloud!.get(id),
      job.id,
    );
    expect(ui.state).toBe(last.state);
    const state = await call("reels_icloud_status", { paths: last.paths });
    expect(state.state).toBe(live ? "completed" : "failed");
    expect(state.files).toHaveLength(1);
    await writeFile(source, "Synthetic iCloud delivery QA version 2\n");
    const current = await call("reels_get_content", {
      projectId: "icloud-test",
    });
    const second = await call("reels_start_icloud_delivery", {
      projectId: "icloud-test",
      expectedUpdatedAt: current.updatedAt,
      files: [{ sourcePath: source, name: "caption.txt", role: "document" }],
    });
    let secondState: any;
    await expect
      .poll(
        async () => {
          secondState = await call("reels_get_icloud_delivery", {
            jobId: second.id,
          });
          return secondState.state;
        },
        { timeout: 120_000, intervals: [250, 1000, 2000] },
      )
      .toBe(live ? "completed" : "failed");
    expect(secondState.upload, secondState.error).toBeDefined();
    expect(second.destination).toBe(job.destination);
    expect(
      await readFile(path.join(cloud, "publish/caption.txt"), "utf8"),
    ).toContain("version 2");
    const receipt = JSON.parse(await readFile(secondState.receiptPath, "utf8"));
    expect(await readFile(receipt.archives[0].backup, "utf8")).toBe(
      "Synthetic iCloud delivery QA\n",
    );
    const persisted = await call("reels_get_content", {
      projectId: "icloud-test",
    });
    expect(persisted.project.outbound.generation).toBe(2);
    const rejected = await client!.callTool({
      name: "reels_icloud_status",
      arguments: { paths: [source] },
    });
    expect(rejected.isError).toBe(true);
    // Only synthetic paths/state: report may be retained in the private QA profile during the run.
    console.log(
      JSON.stringify({
        live,
        state: state.state,
        fileCount: state.files.length,
        uiState: ui.state,
        reconnected: true,
      }),
    );
  } finally {
    await client?.close();
    await transport?.close();
    await closeApp(app);
    await rm(cloud, { recursive: true, force: true });
    await cleanProfile(profile);
  }
});
