import { readFile } from "node:fs/promises";
import path from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { parse as parseHtml } from "node-html-parser";
import { z } from "zod";
import type { ContentLibrary } from "../features/content-library";
import { parse as parseManuscript } from "../shared/blog-markup";
import { parsePostUrl } from "../shared/blog-restore";
import { readJsonFile } from "../shared/lib/fs";
import type { LocalStore } from "../shared/lib/storage";
import { seoulDate } from "../shared/planning";
import { publicationOn } from "../shared/publications";
import type { BlogPost } from "./blog-publish-webhook";
import { linkedManuscripts } from "./blog-projects";

const ownerConfig = z.strictObject({ blogId: z.string().regex(/^[\w-]{1,50}$/) });
const normalize = (text: string) =>
  text
    .normalize("NFC")
    .replace(/[\u200b\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const maxBytes = 4 * 1024 * 1024;

async function readPublic(url: string) {
  const response = await fetch(url, {
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`Naver HTTP ${response.status}`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("Naver response is too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function postUrl(value: string) {
  try {
    const url = new URL(value);
    // Tracking parameters on a pretty URL must never override its actual path.
    if (url.pathname !== "/PostView.naver") {
      if (!/^\/[\w-]+\/\d+\/?$/.test(url.pathname)) return;
      url.search = "";
    }
    return parsePostUrl(url.href);
  } catch {
    return;
  }
}

function feedItems(xml: string, owner: string) {
  const invalid = () => {
    throw new Error("Invalid Naver RSS");
  };
  if (/<!DOCTYPE/i.test(xml)) invalid();
  const doc = new DOMParser({ errorHandler: invalid }).parseFromString(xml, "application/xml");
  const children = (parent: Element, tag: string) =>
    Array.from(parent.childNodes).filter((n): n is Element => n.nodeType === 1 && n.nodeName === tag);
  const field = (element: Element, tag: string) => {
    const nodes = children(element, tag);
    return nodes.length === 1 ? (nodes[0].textContent?.trim() ?? "") : invalid();
  };
  const channels = children(doc.documentElement, "channel");
  if (doc.documentElement.tagName !== "rss" || channels.length !== 1) invalid();
  const channel = channels[0];
  const link = new URL(field(channel, "link"));
  if (link.origin !== "https://blog.naver.com" || link.pathname !== "/" + owner) invalid();
  return children(channel, "item").map((item) => ({
    title: normalize(field(item, "title")),
    author: field(item, "author"),
    post: postUrl(field(item, "link")),
    date: field(item, "pubDate"),
  }));
}

function confirmsPost(html: string, url: string, source: string, title: string, at: Date) {
  const doc = parseHtml(html);
  const meta = (key: string) => {
    const tags = doc.querySelectorAll(`head meta[property="og:${key}"]`);
    return tags.length === 1 ? (tags[0].getAttribute("content") ?? "") : "";
  };
  if (postUrl(meta("url"))?.url !== url || normalize(meta("title")) !== title) return false;
  const dates = doc.querySelectorAll(".se_publishDate");
  const bodies = doc.querySelectorAll(".se-main-container");
  if (dates.length !== 1 || bodies.length !== 1) return false;
  const date = dates[0].text.trim().match(/^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{1,2}):(\d{2})$/);
  if (!date) return false;
  const [, y, m, d, h, min] = date;
  const pageTime = Date.parse(
    `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${h.padStart(2, "0")}:${min}:00+09:00`,
  );
  if (pageTime !== Math.floor(at.getTime() / 60_000) * 60_000) return false;

  const manuscript = parseManuscript(source);
  if (typeof manuscript.metadata?.title !== "string" || normalize(manuscript.metadata.title) !== title)
    return false;
  const lines = manuscript.bundles
    .flatMap((b) => b.nodes.flatMap((n) => (n.kind === "paragraph" ? n.lines : [])))
    // The public page shows only a link's label (same rule as the markup preview).
    .map((line) => normalize(line.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1")))
    .filter(Boolean);
  if (new Set(lines).size < 2) return false;
  const paragraphs = bodies[0].querySelectorAll("p.se-text-paragraph").map((p) => normalize(p.text));
  let cursor = 0;
  for (const line of lines) {
    const index = paragraphs.indexOf(line, cursor);
    if (index < 0) return false;
    cursor = index + 1;
  }
  return true;
}

export interface ReconcileOptions {
  /** Limits the pass to these cards. */
  only?: ReadonlySet<string>;
  /** Why a due booking stayed scheduled. */
  held?: (projectId: string, reason: string) => void;
  /** Called right after each card is recorded as published. */
  published?: (post: BlogPost) => Promise<void>;
}

/** A pass reads public evidence outside the store queue, then uses the revision it actually inspected. */
export async function reconcileScheduledBlogs(
  store: LocalStore,
  setPublication: ContentLibrary["setPublication"],
  read = readPublic,
  now = Date.now(),
  { only, held = () => {}, published }: ReconcileOptions = {},
) {
  const { projects, updatedAt } = await store.load();
  const due = projects.flatMap((project) => {
    const entry = publicationOn(project, "blog");
    return entry?.status === "scheduled" &&
      entry.scheduledAt &&
      Date.parse(entry.scheduledAt) <= now &&
      (!only || only.has(project.id))
      ? [{ project, scheduledAt: entry.scheduledAt, url: entry.url }]
      : [];
  });
  if (!due.length) return 0;
  const config = await readJsonFile(
    path.join(store.root, "naver-blog-owner.json"),
    (v) => ownerConfig.parse(v),
    () => null,
  );
  if (!config) {
    for (const { project } of due) held(project.id, "naver-blog-owner.json 설정이 없습니다.");
    return 0;
  }

  const items = await read(`https://rss.blog.naver.com/${config.blogId}.xml`).then((xml) =>
    feedItems(xml, config.blogId),
  );
  const files = new Map<string, { title: string; file: string }>();
  const titleCounts = new Map<string, number>();
  const claimed = new Map<string, string>();
  for (const project of projects) {
    const url = postUrl(publicationOn(project, "blog")?.url ?? "")?.url;
    if (url) claimed.set(url, claimed.has(url) ? "" : project.id);
    let readable = true;
    const manuscripts = await linkedManuscripts(project, () => {
      readable = false;
    });
    for (const manuscript of manuscripts) {
      if (typeof manuscript.title !== "string") continue;
      const title = normalize(manuscript.title);
      titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
      if (readable && manuscripts.length === 1 && title)
        files.set(project.id, { title, file: manuscript.file });
    }
  }

  let revision = updatedAt;
  let confirmed = 0;
  for (const { project, scheduledAt, url } of due) {
    const manuscript = files.get(project.id);
    const hold = (reason: string) => held(project.id, reason);
    if (!manuscript || titleCounts.get(manuscript.title) !== 1) {
      hold("연결한 정본 원고가 하나가 아니거나 제목이 겹칩니다.");
      continue;
    }
    const matches = items.filter((item) => item.title === manuscript.title);
    if (matches.length !== 1) {
      hold(matches.length ? "RSS에 같은 제목의 글이 여러 개입니다." : "RSS에 원고 제목의 글이 없습니다.");
      continue;
    }
    const { author, post, date } = matches[0];
    if (author !== config.blogId || post?.blogId !== config.blogId) {
      hold("RSS 글의 작성자나 주소가 설정한 계정과 다릅니다.");
      continue;
    }
    if (
      (url && postUrl(url)?.url !== post.url) ||
      (claimed.has(post.url) && claimed.get(post.url) !== project.id)
    ) {
      hold("카드의 글 주소와 다르거나 다른 카드가 쓰는 주소입니다.");
      continue;
    }
    if (!/\d{2}:\d{2}:\d{2} (?:[+-]\d{4}|GMT)$/.test(date)) {
      hold("RSS 게시 시각을 읽지 못했습니다.");
      continue;
    }
    const at = new Date(date);
    if (
      at.getTime() > now ||
      Math.floor(at.getTime() / 60_000) !== Math.floor(Date.parse(scheduledAt) / 60_000)
    ) {
      hold("RSS 게시 시각이 예약 시각과 다릅니다.");
      continue;
    }
    try {
      const html = await read(
        `https://blog.naver.com/PostView.naver?blogId=${post.blogId}&logNo=${post.logNo}`,
      );
      // Read the current manuscript after the network wait so a changed draft cannot confirm an old post.
      const current = await linkedManuscripts(project, (reason) => {
        throw new Error(reason);
      });
      if (current.length !== 1 || current[0].file !== manuscript.file) {
        hold("확인 중에 연결 원고가 바뀌었습니다.");
        continue;
      }
      const source = await readFile(manuscript.file, "utf8");
      if (!confirmsPost(html, post.url, source, manuscript.title, at)) {
        hold("공개 페이지의 제목·시각·본문이 정본 원고와 다릅니다.");
        continue;
      }
    } catch (error) {
      hold(`공개 페이지 또는 원고를 확인하지 못했습니다: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    const result = await setPublication({
      projectId: project.id,
      expectedUpdatedAt: revision,
      channel: "blog",
      status: "published",
      url: post.url,
      publishedAt: seoulDate(at),
    });
    revision = result.updatedAt;
    claimed.set(post.url, project.id);
    confirmed++;
    await published?.({ url: post.url, title: manuscript.title, pubDate: seoulTime(at) });
  }
  return confirmed;
}

const seoulTime = (at: Date) => new Date(at.getTime() + 9 * 3_600_000).toISOString().slice(0, 19) + "+09:00";

const minute = 60_000;
/** Minutes after the booked time: +10, +20, +40, then hourly up to 24 hours. */
const attemptMinutes = [10, 20, 40, ...Array.from({ length: 23 }, (_, i) => 100 + i * 60), 24 * 60];
const checkState = z.record(
  z.string(),
  z.object({
    lastAttemptAt: z.iso.datetime(),
    /** null: no automatic attempt left until the next app start or wake. */
    nextAttemptAt: z.iso.datetime().nullable(),
    reason: z.string(),
  }),
);

/**
 * Checks each booking ten minutes after its time. Call `tick` at least once a minute:
 * the card file is re-read every time, so bookings written by any session are picked up.
 * `catchUp` (app start, wake) checks every overdue booking at once.
 */
export function blogBookingChecker(
  store: LocalStore,
  setPublication: ContentLibrary["setPublication"],
  { read = readPublic, published }: { read?: typeof readPublic; published?: ReconcileOptions["published"] } = {},
) {
  const file = path.join(store.root, "blog-publication-check.json");
  return async function tick(now = Date.now(), catchUp = false) {
    const { projects } = await store.load();
    const state = await readJsonFile(file, (v) => checkState.parse(v), () => ({}) as z.infer<typeof checkState>);
    const next: typeof state = {};
    const due = new Map<string, { key: string; at: number }>();
    let wakeAt = Infinity;
    for (const project of projects) {
      const entry = publicationOn(project, "blog");
      if (entry?.status !== "scheduled" || !entry.scheduledAt) continue;
      const at = Date.parse(entry.scheduledAt);
      const key = `${project.id}|${entry.scheduledAt}`;
      const seen = state[key];
      if (seen) next[key] = seen;
      const planned = seen
        ? seen.nextAttemptAt === null ? Infinity : Date.parse(seen.nextAttemptAt)
        : at + attemptMinutes[0] * minute;
      if (planned <= now || (catchUp && at + attemptMinutes[0] * minute <= now)) due.set(project.id, { key, at });
      else wakeAt = Math.min(wakeAt, planned);
    }
    if (due.size) {
      const reasons = new Map<string, string>();
      try {
        await reconcileScheduledBlogs(store, setPublication, read, now, {
          only: new Set(due.keys()),
          held: (id, reason) => reasons.set(id, reason),
          published,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // Logged here too: a card already recorded as published keeps no check state.
        console.warn("[blog-publications]", reason);
        for (const id of due.keys()) if (!reasons.has(id)) reasons.set(id, reason);
      }
      const after = (await store.load()).projects;
      for (const [id, { key, at }] of due) {
        const project = after.find((p) => p.id === id);
        const entry = project && publicationOn(project, "blog");
        if (entry?.status !== "scheduled" || `${id}|${entry.scheduledAt}` !== key) {
          delete next[key];
          continue;
        }
        const offset = attemptMinutes.find((m) => at + m * minute > now);
        const nextAt = offset === undefined ? null : at + offset * minute;
        const reason = reasons.get(id) ?? "확인하지 못했습니다.";
        console.warn(
          `[blog-publications] ${id}: ${reason} ${nextAt === null ? "자동 재시도를 마쳤습니다." : `다음 확인 ${seoulTime(new Date(nextAt))}`}`,
        );
        next[key] = {
          lastAttemptAt: new Date(now).toISOString(),
          nextAttemptAt: nextAt === null ? null : new Date(nextAt).toISOString(),
          reason,
        };
        if (nextAt !== null) wakeAt = Math.min(wakeAt, nextAt);
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(state)) await store.atomic(file, next);
    return wakeAt;
  };
}
