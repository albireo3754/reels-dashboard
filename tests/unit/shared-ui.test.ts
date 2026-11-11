import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Button,
  IconButton,
  Notice,
  Segmented,
  StatusText,
  Tabs,
} from "../../src/shared/ui/primitives";
import { Menu, Popover } from "../../src/shared/ui/Popover";
import {
  terminalTheme,
  terminalThemeFallback,
} from "../../src/shared/ui/terminal-theme";

const tokens = readFileSync("src/shared/ui/tokens.css", "utf8");
const token = (name: string) =>
  tokens.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();

test("terminal theme fallback matches the --terminal-* tokens", () => {
  assert.equal(token("--terminal-bg"), terminalThemeFallback.background);
  assert.equal(token("--terminal-fg"), terminalThemeFallback.foreground);
  assert.equal(
    token("--terminal-selection"),
    terminalThemeFallback.selectionBackground,
  );
  for (const name of [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
  ] as const) {
    assert.equal(token(`--terminal-ansi-${name}`), terminalThemeFallback[name]);
    const bright = `bright${name[0].toUpperCase()}${name.slice(1)}` as keyof typeof terminalThemeFallback;
    assert.equal(
      token(`--terminal-ansi-bright-${name}`),
      terminalThemeFallback[bright],
    );
  }
  // Outside a DOM the helper falls back to the same values.
  assert.deepEqual(terminalTheme(null), terminalThemeFallback);
});

test("neutral palette keeps the brief's core tokens and legacy aliases", () => {
  assert.equal(token("--color-bg"), "#ffffff");
  assert.equal(token("--color-sidebar"), "#f7f7f5");
  assert.equal(token("--color-primary"), "#386354");
  assert.ok(token("--color-hover"));
  assert.ok(token("--color-selected"));
  for (const alias of ["--green", "--muted", "--line", "--paper", "--accent"])
    assert.match(token(alias) ?? "", /^var\(--color-/);
});

test("button variants map to the shared classes (quiet is the default)", () => {
  const html = (variant?: "quiet" | "secondary" | "primary") =>
    renderToStaticMarkup(createElement(Button, { variant }, "저장"));
  assert.equal(html(), '<button type="button">저장</button>');
  assert.match(html("secondary"), /class="secondary"/);
  assert.match(html("primary"), /class="primary"/);
  const icon = renderToStaticMarkup(
    createElement(IconButton, { label: "설정", pressed: true }, "x"),
  );
  assert.match(icon, /aria-label="설정"/);
  assert.match(icon, /title="설정"/);
  assert.match(icon, /aria-pressed="true"/);
  assert.match(icon, /class="icon-button"/);
});

test("tabs use roving tabindex and segmented uses aria-pressed", () => {
  const items = [
    { value: "a", label: "검토" },
    { value: "b", label: "채팅" },
  ];
  const tabs = renderToStaticMarkup(
    createElement(Tabs<string>, {
      items,
      value: "b",
      onChange: () => {},
      label: "패널",
    }),
  );
  assert.match(tabs, /role="tablist" aria-label="패널" class="ui-tabs"/);
  assert.match(tabs, /aria-selected="false"[^>]*tabindex="-1"[^>]*>검토/);
  assert.match(tabs, /aria-selected="true"[^>]*tabindex="0"[^>]*>채팅/);
  const seg = renderToStaticMarkup(
    createElement(Segmented<string>, {
      items,
      value: "a",
      onChange: () => {},
      label: "패널",
    }),
  );
  assert.match(seg, /role="group" aria-label="패널" class="ui-segmented"/);
  assert.match(seg, /aria-pressed="true"[^>]*>검토/);
});

test("menu and popover triggers expose the popup contract while closed", () => {
  const menu = renderToStaticMarkup(
    createElement(Menu, {
      label: "더 보기",
      items: [{ label: "사진 넣기", onSelect: () => {} }],
      triggerProps: { "data-testid": "more" },
    }),
  );
  assert.match(menu, /aria-haspopup="menu"/);
  assert.match(menu, /aria-expanded="false"/);
  assert.match(menu, /aria-label="더 보기"/);
  assert.match(menu, /data-testid="more"/);
  assert.doesNotMatch(menu, /role="menu"/);
  const popover = renderToStaticMarkup(
    createElement(Popover, { label: "단축키 도움말", children: "⌘S 저장" }),
  );
  assert.match(popover, /aria-haspopup="dialog"/);
  assert.match(popover, /aria-label="단축키 도움말"/);
});

test("notice and status keep their live-region roles", () => {
  assert.match(
    renderToStaticMarkup(createElement(Notice, { tone: "danger" }, "실패")),
    /role="alert"/,
  );
  assert.doesNotMatch(
    renderToStaticMarkup(createElement(Notice, {}, "안내")),
    /role=/,
  );
  const status = renderToStaticMarkup(
    createElement(StatusText, { live: true, busy: true }, "저장 중"),
  );
  assert.match(status, /role="status"/);
  assert.match(status, /ui-spinner/);
});
