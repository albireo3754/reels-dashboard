/*
 * xterm 테마를 tokens.css의 --terminal-* 값에서 읽는다. 터미널 색을 화면 코드에 하드코딩하지 않는다.
 * new Terminal({ theme: terminalTheme() }) 처럼 쓴다. 반환 키는 xterm ITheme과 같다.
 */

const ansi = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;

type AnsiName = (typeof ansi)[number];
type BrightName = `bright${Capitalize<AnsiName>}`;

export type TerminalTheme = {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
} & Record<AnsiName | BrightName, string>;

/** 토큰을 읽을 수 없을 때(테스트·SSR) 쓰는 값. tokens.css와 같게 유지한다. */
export const terminalThemeFallback: TerminalTheme = {
  background: "#191919",
  foreground: "#e6e6e4",
  cursor: "#e6e6e4",
  cursorAccent: "#191919",
  selectionBackground: "#ffffff33",
  black: "#3a3937",
  red: "#e5736a",
  green: "#7fb894",
  yellow: "#d9b462",
  blue: "#6fa6de",
  magenta: "#c592d6",
  cyan: "#62bcc3",
  white: "#d4d4d2",
  brightBlack: "#85847f",
  brightRed: "#f19087",
  brightGreen: "#9cd0ae",
  brightYellow: "#ecca80",
  brightBlue: "#8fbcef",
  brightMagenta: "#d8aae6",
  brightCyan: "#82d3d9",
  brightWhite: "#ffffff",
};

const capitalize = (name: string) => name[0].toUpperCase() + name.slice(1);

export function terminalTheme(
  element: Element | null = typeof document === "undefined"
    ? null
    : document.documentElement,
): TerminalTheme {
  if (!element || typeof getComputedStyle === "undefined")
    return { ...terminalThemeFallback };
  const style = getComputedStyle(element);
  const read = (token: string, fallback: string) =>
    style.getPropertyValue(token).trim() || fallback;
  const theme: TerminalTheme = {
    ...terminalThemeFallback,
    background: read("--terminal-bg", terminalThemeFallback.background),
    foreground: read("--terminal-fg", terminalThemeFallback.foreground),
    cursor: read("--terminal-cursor", terminalThemeFallback.cursor),
    cursorAccent: read(
      "--terminal-cursor-accent",
      terminalThemeFallback.cursorAccent,
    ),
    selectionBackground: read(
      "--terminal-selection",
      terminalThemeFallback.selectionBackground,
    ),
  };
  for (const name of ansi) {
    theme[name] = read(`--terminal-ansi-${name}`, terminalThemeFallback[name]);
    const bright = `bright${capitalize(name)}` as BrightName;
    theme[bright] = read(
      `--terminal-ansi-bright-${name}`,
      terminalThemeFallback[bright],
    );
  }
  return theme;
}
