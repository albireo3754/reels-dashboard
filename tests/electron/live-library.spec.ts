import { expect, test, type ElectronApplication } from "@playwright/test";
import { cleanProfile, closeApp, launchApp, makeProfile } from "./helpers";

test.describe("explicit bounded live metadata QA", () => {
  test.skip(
    process.env.REELS_LIVE_LIBRARY_QA !== "1",
    "Requires explicit permission and an environment-supplied capture date.",
  );
  let app: ElectronApplication | undefined;
  let profile: string;

  test.beforeEach(async () => {
    profile = await makeProfile();
    app = await launchApp(profile, false);
  });
  test.afterEach(async () => {
    await closeApp(app);
    app = undefined;
    await cleanProfile(profile);
  });

  test("validates one approved capture group and decodes one private preview", async ({}, testInfo) => {
    const primary = process.env.REELS_LIVE_LIBRARY_DATE;
    const fallback = process.env.REELS_LIVE_LIBRARY_FALLBACK_DATE;
    expect(primary).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    if (fallback) expect(fallback).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const dates = [primary!, ...(fallback ? [fallback] : [])];
    const page = await app!.firstWindow();
    await expect
      .poll(() => page.evaluate(() => window.reels?.mode))
      .toBe("desktop");
    const result = await page.evaluate(async (dates) => {
      const bridge = window.reels!;
      const status = await bridge.request<{ permission: string }>("status");
      if (status.permission !== "authorized")
        throw new Error(
          "Full Photos authorization is required for this opt-in live check",
        );
      const attempts: {
        date: string;
        assetCount: number;
        groupCount: number;
      }[] = [];
      for (const date of dates) {
        const sync = await bridge.request<{
          indexRunID: string;
          localDate: string;
          assetCount: number;
          fineGroupCount: number;
        }>("sync", { date });
        const groups = await bridge.request<{
          indexRunID: string;
          level: string;
          groups: { id: string; localDate: string; assetIDs: string[] }[];
        }>("groups.list", { date, level: "fine" });
        if (
          sync.localDate !== date ||
          groups.indexRunID !== sync.indexRunID ||
          groups.level !== "fine"
        )
          throw new Error("Live sync/list identity mismatch");
        if (groups.groups.length !== sync.fineGroupCount)
          throw new Error("Live fine-group count mismatch");
        const groupedIDs = groups.groups.flatMap((group) => group.assetIDs);
        if (
          groupedIDs.length !== sync.assetCount ||
          new Set(groupedIDs).size !== groupedIDs.length
        )
          throw new Error("Live grouped asset count or uniqueness mismatch");
        attempts.push({
          date,
          assetCount: sync.assetCount,
          groupCount: groups.groups.length,
        });
        if (!groups.groups.length) continue;
        const first = groups.groups[0]!;
        const detail = await bridge.request<{
          indexRunID: string;
          group: { id: string; assetIDs: string[] };
          assets: { id: string }[];
        }>("groups.show", { id: first.id, "index-run": sync.indexRunID });
        if (
          detail.indexRunID !== sync.indexRunID ||
          detail.group.id !== first.id ||
          first.localDate !== date
        )
          throw new Error("Live group detail identity mismatch");
        const expected = [...first.assetIDs].sort();
        const actual = detail.assets.map((asset) => asset.id).sort();
        if (
          JSON.stringify(expected) !== JSON.stringify(actual) ||
          JSON.stringify(expected) !==
            JSON.stringify([...detail.group.assetIDs].sort())
        )
          throw new Error("Live group detail asset consistency mismatch");
        const inspection = await bridge.request<{
          indexRunID: string;
          groupID: string;
          sampleFiles: string[];
          page: { pageNumber: number; pageSize: number; assetIDs: string[] };
          packet: { warnings: string[] };
        }>("groups.inspect", {
          id: first.id,
          "index-run": sync.indexRunID,
          page: "1",
          "page-size": "1",
          samples: "1",
        });
        if (
          inspection.indexRunID !== sync.indexRunID ||
          inspection.groupID !== first.id
        )
          throw new Error("Live preview identity mismatch");
        if (
          inspection.page.pageNumber !== 1 ||
          inspection.page.pageSize !== 1 ||
          inspection.page.assetIDs.length !== 1 ||
          inspection.sampleFiles.length !== 1
        )
          throw new Error("Live preview exceeded the one-asset evidence bound");
        if (
          inspection.packet.warnings.some((warning) =>
            /^(?:analysis-failed|sample-generation-failed|partial-evidence)(?::|$)/.test(
              warning,
            ),
          )
        )
          throw new Error("Live evidence analysis failed or was incomplete");
        const imageURL = await bridge.imageURL(inspection.sampleFiles[0]!);
        if (
          !imageURL.startsWith("data:image/jpeg;base64,") ||
          imageURL.length <= "data:image/jpeg;base64,".length
        )
          throw new Error("Live preview did not produce nonempty JPEG data");
        const preview = new Image();
        preview.src = imageURL;
        await preview.decode();
        if (preview.naturalWidth < 1 || preview.naturalHeight < 1)
          throw new Error("Live preview JPEG could not be decoded");
        preview.src = "";
        // Return aggregates only. Actual IDs, filenames, paths and asset metadata
        // never leave this page evaluation or get attached to the test report.
        return {
          permission: status.permission,
          matched: true,
          attempts,
          detailAssetCount: detail.assets.length,
          previewCount: 1,
          previewDecoded: true,
          analysisSucceeded: true,
        };
      }
      return {
        permission: status.permission,
        matched: false,
        attempts,
        detailAssetCount: 0,
      };
    }, dates);
    await testInfo.attach("private-live-aggregate", {
      body: JSON.stringify(result),
      contentType: "application/json",
    });
    expect(result.permission).toBe("authorized");
    expect(
      result.matched,
      "No capture groups were found within the two explicitly approved dates",
    ).toBe(true);
    expect(result.detailAssetCount).toBeGreaterThan(0);
    expect(result.previewCount).toBe(1);
    expect(result.previewDecoded).toBe(true);
    expect(result.analysisSucceeded).toBe(true);
  });
});
