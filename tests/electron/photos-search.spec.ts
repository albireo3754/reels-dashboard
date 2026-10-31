import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";
import { access, writeFile, readFile } from "node:fs/promises";
import { sendNative } from "../../src/desktop/native";
import { launchApp, closeApp, makeProfile, cleanProfile } from "./helpers";

test("MCP Photos search reaches the native helper without changing the date index", async () => {
  test.skip(process.env.REELS_PHOTOS_SEARCH_LIVE !== "1", "Explicit read-only Photos QA opt-in required");
  test.setTimeout(360_000);
  const profile = await makeProfile();
  const app = await launchApp(profile, false);
  const client = new Client({ name: "photos-search-qa", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("dist-mcp/server.mjs")], env: { ...process.env as Record<string,string>, REELS_USER_DATA: profile } });
  try {
    await expect.poll(async () => { try { await access(path.join(profile,"agent/connection.json")); return true; } catch { return false; } }).toBe(true);
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.some(t => t.name === "reels_photos_search")).toBe(true);
    expect(tools.tools.some(t => t.name === "reels_photos_search_page")).toBe(true);
    const call = async (name:string, args:Record<string,unknown>={}) => {
      const r = await client.callTool({name,arguments:args},{timeout:120000});
      expect(r.isError, JSON.stringify(r.content)).not.toBe(true);
      return r.structuredContent as any;
    };
    let status = await call("reels_photos_status");
    if (status.permission === "not-determined" && process.env.REELS_PHOTOS_SEARCH_AUTHORIZE === "1") {
      const instance = JSON.parse(await readFile(path.join(profile,"native/helper-instance.json"),"utf8"));
      await sendNative(instance.socketPath,"authorize",{});
      status = await call("reels_photos_status");
    }
    console.log("Photos search permission:",status.permission);
    if (!["authorized","limited"].includes(status.permission)) {
      const result = await client.callTool({name:"reels_photos_search",arguments:{text:"태백관"}});
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("photos-permission-required");
      test.skip(true,"New helper has no existing Photos permission; permission rejection verified, personal search not run");
    }
    const before = await call("reels_photos_groups", {level:"coarse"});
    const location = JSON.parse(process.env.REELS_PHOTOS_SEARCH_LOCATION ?? '{"latitude":0,"longitude":0,"radiusMeters":1}');
    const first = await call("reels_photos_search",{location,pageSize:10});
    console.log("Location candidates:", first.candidateCount);
    const pages = [first];
    // Bound live QA; never exhaust an entire library automatically.
    while (pages.at(-1).nextOffset !== null && pages.length < 10) {
      pages.push(await call("reels_photos_search_page",{searchId:first.searchId,offset:pages.at(-1).nextOffset,pageSize:10}));
    }
    if (process.env.REELS_PHOTOS_SEARCH_REPORT) await writeFile(process.env.REELS_PHOTOS_SEARCH_REPORT,JSON.stringify({status,pages,ocrPages:[]},null,2),{mode:0o600});
    const ocr = await call("reels_photos_search",{location,text:process.env.REELS_PHOTOS_SEARCH_TEXT ?? "TEST",pageSize:10});
    const ocrPages = [ocr];
    while (ocrPages.at(-1).nextOffset !== null && ocrPages.length < 10) {
      ocrPages.push(await call("reels_photos_search_page",{searchId:ocr.searchId,offset:ocrPages.at(-1).nextOffset,pageSize:10}));
    }
    const after = await call("reels_photos_groups", {level:"coarse"});
    expect(after).toEqual(before);
    if (process.env.REELS_PHOTOS_SEARCH_REPORT) await writeFile(process.env.REELS_PHOTOS_SEARCH_REPORT,JSON.stringify({status,pages,ocrPages},null,2),{mode:0o600});
    console.log(JSON.stringify({candidateCount:first.candidateCount,locationPages:pages.length,ocrMatches:ocrPages.flatMap(p=>p.matches).length,ocrFailures:ocrPages.flatMap(p=>p.failures).length}));
  } finally {
    await client.close(); await transport.close(); await closeApp(app); await cleanProfile(profile);
  }
});
