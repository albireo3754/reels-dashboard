import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { scanBlogProjects } from "../../src/desktop/blog-projects";
import { blogBookingChecker, reconcileScheduledBlogs } from "../../src/desktop/scheduled-blog-publications";
import { ContentLibrary } from "../../src/features/content-library";
import type { Project } from "../../src/shared/contracts";
import { LocalStore } from "../../src/shared/lib/storage";
import { emptyPlanning, weekPlan } from "../../src/shared/planning";
import { publicationOn } from "../../src/shared/publications";

const booking = "2026-11-19T00:10:00+09:00";
const after = Date.parse("2026-11-22T10:00:00+09:00");
const title = "여행 & 산책";
const url = "https://blog.naver.com/example_owner/123456789";
const item = `<item><title><![CDATA[${title}]]></title><author>example_owner</author>
  <link><![CDATA[${url}?fromRss=true&trackingCode=rss]]></link><pubDate>Wed, 18 Nov 2026 15:10:00 GMT</pubDate></item>`;
const feed = (items = item) =>
  `<rss><channel><link>https://blog.naver.com/example_owner</link>${items}</channel></rss>`;
const page = `<html><head><meta property="og:title" content="여행 &amp; 산책">
  <meta property="og:url" content="${url}"></head><body><span class="se_publishDate">2026. 11. 19. 0:10</span>
  <div class="se-main-container"><p class="se-text-paragraph">숲길에서 만난 <span>풍경</span></p>
  <p class="se-text-paragraph">돌아오는 길의 풍경</p></div></body></html>`;
const manuscript = `---
markup: 1
title: "${title}"
media: ./media
---
<Bundle id="B01" name="산책" question="어땠나">
¶ P1
숲길에서 만난 풍경
돌아오는 길의 풍경
</Bundle>
`;

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "scheduled-blog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new LocalStore(root);
  const changes: string[] = [];
  const library = new ContentLibrary(store, (dashboard) => changes.push(dashboard.updatedAt));
  const file = path.join(root, "manuscript.md");
  const owner = path.join(root, "naver-blog-owner.json");
  await writeFile(file, manuscript);
  await writeFile(owner, JSON.stringify({ blogId: "example_owner" }));
  const card: Project = {
    id: "card",
    title: "카드용 짧은 제목",
    stage: "review",
    date: "2026-10-24",
    shared: false,
    publicURL: "",
    nextAction: "다음 영상 준비",
    resources: [{ role: "document", path: file, label: "원고" }],
    publications: [
      { channel: "instagram", status: "draft", url: "" },
      { channel: "blog", status: "scheduled", scheduledAt: booking, url: "" },
    ],
  };
  await store.update((d) => ({ ...d, projects: [card] }));
  const set = library.setPublication.bind(library);
  const run = (read: (url: string) => Promise<string>, now = after) =>
    reconcileScheduledBlogs(store, set, read, now);
  return {
    store,
    changes,
    library,
    card,
    file,
    owner,
    run,
    bytes: () => readFile(path.join(root, "dashboard.json"), "utf8"),
  };
}

test("an overdue booking becomes public on the card, calendar and blog list using anonymous Naver evidence", async (t) => {
  const f = await fixture(t);
  const requests: string[] = [];
  const read = async (address: string) => {
    requests.push(address);
    return address.startsWith("https://rss.") ? feed() : page;
  };
  assert.equal(await f.run(read), 1);
  assert.deepEqual(requests, [
    "https://rss.blog.naver.com/example_owner.xml",
    "https://blog.naver.com/PostView.naver?blogId=example_owner&logNo=123456789",
  ]);
  const { projects } = await f.store.load();
  assert.deepEqual(projects[0], {
    ...f.card,
    publications: [
      f.card.publications![0],
      { channel: "blog", status: "published", publishedAt: "2026-11-19", url },
    ],
  });
  const week = weekPlan(emptyPlanning(), projects, "2026-11-15", "blog");
  assert.deepEqual([week.published, week.scheduled, week.posts[0].day], [1, 0, "2026-11-19"]);
  assert.equal((await scanBlogProjects(f.store.root)).projects[0].published, true);
  const before = await f.bytes();
  assert.equal(await f.run(read), 0);
  assert.equal(requests.length, 2);
  assert.equal(await f.bytes(), before);
  assert.equal(f.changes.length, 1);
});

test("missing owner, future bookings and other channel states make no network request", async (t) => {
  const f = await fixture(t);
  const unexpected = async () => {
    assert.fail("unexpected Naver request");
  };
  assert.equal(await f.run(unexpected, Date.parse(booking) - 1), 0);
  await rm(f.owner);
  assert.equal(await f.run(unexpected), 0);
  await writeFile(f.owner, '{"blogId":"example_owner"}');
  for (const status of ["planned", "draft", "published"] as const) {
    await f.library.setPublication({
      projectId: "card",
      channel: "blog",
      expectedUpdatedAt: (await f.store.load()).updatedAt,
      status,
    });
    assert.equal(await f.run(unexpected), 0);
  }
});

test("holds the booking byte-for-byte on absent, ambiguous, foreign, private or contradictory evidence", async (t) => {
  const f = await fixture(t);
  const before = await f.bytes();
  const scenarios = [
    [feed(""), page],
    [feed(item + item.replace("123456789", "987654321")), page],
    [feed(item.replace("<author>example_owner", "<author>other")), page],
    [
      feed(
        item.replace(
          url,
          url.replace("example_owner", "other") + "?blogId=example_owner&amp;logNo=123456789",
        ),
      ),
      page,
    ],
    [feed(item.replace(url, url.replace("blog.naver.com", "example.com"))), page],
    [feed(item.replace("15:10", "15:09")), page],
    [feed(item.replace(" GMT", "")), page],
    [feed(), "<html>비공개 글입니다</html>"],
    [feed(), page.replace(url, url + "0")],
    [feed(), page.replace("여행 &amp; 산책", "비슷한 제목")],
    [feed(), page.replace("0:10", "0:11")],
    [feed(), page.replace("돌아오는 길의 풍경", "다른 글")],
  ];
  for (const [rss, html] of scenarios) {
    assert.equal(await f.run(async (address) => (address.includes("rss.") ? rss : html)), 0);
    assert.equal(await f.bytes(), before);
  }
  await assert.rejects(
    f.run(async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  await assert.rejects(f.run(async () => feed().replace("</channel>", "</broken>")));
  assert.equal(
    await f.run(async (address) => {
      if (address.includes("rss.")) return feed();
      throw new Error("HTTP 403");
    }),
    0,
  );
  assert.equal(await f.bytes(), before);
  assert.deepEqual(f.changes, []);
});

test("a second local manuscript with that title or a claimed post URL prevents assignment", async (t) => {
  const f = await fixture(t);
  const second = path.join(f.store.root, "second.md");
  await writeFile(second, manuscript);
  await f.store.update((d) => ({
    ...d,
    projects: [
      ...d.projects,
      { ...f.card, id: "second", resources: [{ role: "document", label: "두 번째 원고", path: second }] },
    ],
  }));
  const read = async (address: string) => {
    assert.match(address, /^https:\/\/rss\./);
    return feed();
  };
  assert.equal(await f.run(read), 0);
  await f.store.update((d) => {
    d.projects[1].resources = [];
    d.projects[1].publications = [
      { channel: "blog", status: "published", url: url.replace("//blog", "//m.blog") },
    ];
    return d;
  });
  assert.equal(await f.run(read), 0);
  assert.deepEqual(f.changes, []);
});

test("a concurrent rebooking wins, including the other channel and the new revision", async (t) => {
  const f = await fixture(t);
  const newBooking = "2026-11-25T10:00:00+09:00";
  await assert.rejects(
    f.run(async (address) => {
      if (address.includes("rss.")) return feed();
      await f.library.setPublication({
        projectId: "card",
        channel: "blog",
        status: "scheduled",
        scheduledAt: newBooking,
        expectedUpdatedAt: (await f.store.load()).updatedAt,
      });
      return page;
    }),
    /STALE_DASHBOARD/,
  );
  const p = (await f.store.load()).projects[0];
  assert.equal(publicationOn(p, "blog")?.scheduledAt, newBooking);
  assert.deepEqual(p.publications![0], f.card.publications![0]);
  assert.equal(f.changes.length, 1);
});

test("a concurrent edit just after the first of two commits cannot be adopted as the second booking's revision", async (t) => {
  const f = await fixture(t);
  const second = path.join(f.store.root, "second.md");
  await writeFile(second, manuscript.replace(title, "다음 산책"));
  await f.store.update((d) => ({
    ...d,
    projects: [
      ...d.projects,
      { ...f.card, id: "second", resources: [{ role: "document", label: "원고", path: second }] },
    ],
  }));
  const secondItem = item.replace(title, "다음 산책").replace("123456789", "987654321");
  const read = async (address: string) => {
    if (address.includes("rss.")) return feed(item + secondItem);
    return address.endsWith("987654321")
      ? page.replace("여행 &amp; 산책", "다음 산책").replace("123456789", "987654321")
      : page;
  };
  let concurrent: Promise<unknown> | undefined;
  const library = new ContentLibrary(f.store, () => {
    if (!concurrent)
      concurrent = f.store.update((d) => {
        d.projects[1].publications = [{ channel: "blog", status: "draft", url: "" }];
        return d;
      });
  });
  await assert.rejects(
    reconcileScheduledBlogs(f.store, library.setPublication.bind(library), read, after),
    /STALE_DASHBOARD/,
  );
  await concurrent;
  const [first, next] = (await f.store.load()).projects;
  assert.equal(publicationOn(first, "blog")?.status, "published");
  assert.equal(publicationOn(next, "blog")?.status, "draft");
});

test("a manuscript changed during the public-page request cannot confirm the old body", async (t) => {
  const f = await fixture(t);
  const before = await f.bytes();
  assert.equal(
    await f.run(async (address) => {
      if (address.includes("rss.")) return feed();
      await writeFile(f.file, manuscript.replace("돌아오는 길의 풍경", "원고에 새로 들어간 문장"));
      return page;
    }),
    0,
  );
  assert.equal(await f.bytes(), before);
});

test("one inaccessible public page leaves that card scheduled while another verified booking commits", async (t) => {
  const f = await fixture(t);
  const second = path.join(f.store.root, "another.md");
  await writeFile(second, manuscript.replace(title, "두 번째 글"));
  await f.store.update((d) => ({
    ...d,
    projects: [
      ...d.projects,
      { ...f.card, id: "second", resources: [{ role: "document", label: "원고", path: second }] },
    ],
  }));
  const read = async (address: string) => {
    if (address.includes("rss."))
      return feed(item + item.replace(title, "두 번째 글").replace("123456789", "987654321"));
    if (address.endsWith("123456789")) throw new Error("HTTP 403");
    return page.replace("여행 &amp; 산책", "두 번째 글").replace("123456789", "987654321");
  };
  assert.equal(await f.run(read), 1);
  const [first, next] = (await f.store.load()).projects;
  assert.deepEqual(first, f.card);
  assert.equal(publicationOn(next, "blog")?.url, url.replace("123456789", "987654321"));
});

test("a markdown link line matches its label on the public page, not a different label", async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.file,
    manuscript.replace("돌아오는 길의 풍경", "1차 후기 👉 [숲길 카페](https://blog.naver.com/example_owner/111111111)"),
  );
  const body = (label: string) =>
    page.replace("돌아오는 길의 풍경", `1차 후기 👉 <a href="https://blog.naver.com/example_owner/111111111">${label}</a>`);
  const read = (label: string) => async (address: string) => (address.includes("rss.") ? feed() : body(label));
  assert.equal(await f.run(read("다른 가게")), 0);
  assert.equal(await f.run(read("숲길 카페")), 1);
});

test("each booking is checked ten minutes after its time, retried, and caught up on start or wake", async (t) => {
  const f = await fixture(t);
  const at = Date.parse(booking);
  const min = (n: number) => at + n * 60_000;
  let feeds = 0;
  let online = false;
  const posts: unknown[] = [];
  const read = async (address: string) => {
    if (!address.includes("rss.")) return page;
    feeds++;
    if (!online) throw new Error("offline");
    return feed();
  };
  const set = f.library.setPublication.bind(f.library);
  const published = async (post: unknown) => void posts.push(post);
  const tick = blogBookingChecker(f.store, set, { read, published });
  const state = async () =>
    JSON.parse(await readFile(path.join(f.store.root, "blog-publication-check.json"), "utf8"))[`card|${booking}`];

  assert.equal(await tick(min(10) - 1, true), min(10));
  assert.equal(feeds, 0);
  assert.equal(await tick(min(10)), min(20));
  assert.deepEqual([feeds, (await state()).reason], [1, "offline"]);
  assert.equal(await tick(min(19)), min(20));
  assert.equal(await tick(min(20)), min(40));
  assert.equal(await tick(min(40)), min(100));
  assert.equal(await tick(min(100)), min(160));
  assert.equal(feeds, 4);
  // A restart keeps the schedule, and its catch-up checks at once.
  const reopened = blogBookingChecker(new LocalStore(f.store.root), set, { read, published });
  assert.equal(await reopened(min(101)), min(160));
  assert.equal(feeds, 4);
  await reopened(min(101), true);
  assert.equal(feeds, 5);
  assert.equal(await reopened(min(24 * 60)), Infinity);
  assert.equal((await state()).nextAttemptAt, null);
  await reopened(min(24 * 60 + 60));
  assert.equal(feeds, 6);
  online = true;
  await reopened(min(48 * 60), true);
  assert.deepEqual(posts, [{ url, title, pubDate: "2026-11-19T00:10:00+09:00" }]);
  assert.equal(publicationOn((await f.store.load()).projects[0], "blog")?.status, "published");
  assert.equal(await state(), undefined);
});

test("a rebooked card gets a fresh schedule", async (t) => {
  const f = await fixture(t);
  const offline = async () => {
    throw new Error("offline");
  };
  const tick = blogBookingChecker(f.store, f.library.setPublication.bind(f.library), { read: offline });
  await tick(Date.parse(booking) + 25 * 60 * 60_000);
  const moved = "2026-11-30T10:00:00+09:00";
  await f.library.setPublication({
    projectId: "card",
    channel: "blog",
    status: "scheduled",
    scheduledAt: moved,
    expectedUpdatedAt: (await f.store.load()).updatedAt,
  });
  assert.equal(await tick(Date.parse(moved)), Date.parse(moved) + 10 * 60_000);
});
