import test from "node:test";
import assert from "node:assert/strict";
import {
  conversationRows,
  conversationDay,
  safeMarkdownUrl,
  type ConversationMessage,
} from "../../src/shared/lib/conversation";
const message = (
  id: string,
  at: string,
  sender = "codex",
): ConversationMessage => ({
  id,
  at,
  sender,
  senderLabel: sender,
  avatar: "C",
  body: id,
});

test("conversation groups adjacent same-sender messages within five minutes without crossing days", () => {
  const rows = conversationRows([
    message("1", "2026-10-30T23:58:00"),
    message("2", "2026-10-30T23:59:00"),
    message("3", "2026-10-31T00:00:00"),
    message("4", "2026-10-31T00:01:00", "result"),
    message("5", "2026-10-31T00:06:00", "result"),
    message("6", "2026-10-31T00:06:01", "result"),
  ]);
  assert.deepEqual(
    rows.map((r) => r.grouped),
    [false, true, false, false, false, true],
  );
  assert.deepEqual(
    rows.map((r) => r.showDay),
    [true, false, true, false, false, false],
  );
});

test("clock reversal or invalid dates never merge distinct rows or throw", () => {
  const rows = conversationRows([
    message("1", "2026-10-31T12:00:00"),
    message("2", "2026-10-31T11:59:00"),
    message("3", "unknown"),
    message("4", "2026-10-31T12:01:00"),
  ]);
  assert.ok(rows.every((r) => !r.grouped));
  assert.equal(conversationDay("unknown"), "날짜 미확인");
  assert.equal(
    conversationDay("2026-11-01T00:01:00", new Date("2026-11-01T23:59:00")),
    "오늘",
  );
  assert.equal(
    conversationDay("2026-10-31T23:59:00", new Date("2026-11-01T00:01:00")),
    "어제",
  );
  assert.match(
    conversationDay("2025-11-01T12:00:00", new Date("2026-11-01T00:01:00")),
    /2025/,
  );
});

test("Markdown links permit explicit web/mail URLs and reject local or executable schemes", () => {
  for (const url of [
    "https://example.com/path",
    "http://localhost:4173/",
    "mailto:hello@example.com",
  ])
    assert.equal(safeMarkdownUrl(url), url);
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///tmp/content",
    "/api/workflows",
    "//example.com",
    "./private",
    "vbscript:x",
  ])
    assert.equal(safeMarkdownUrl(url), undefined);
});
