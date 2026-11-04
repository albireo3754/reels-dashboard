import { useEffect, useRef, useState } from "react";
import type { Project } from "../../shared/contracts";
import { canBack, canForward, type Navigation } from "./model/navigation";
import { formatKey } from "../../shared/keymap";
import { ShortcutHint, useKeymap, useShortcut } from "../../shared/ui/shortcuts";
import "./shell.css";

type Item = [string, string];
/** An in-progress content form or a UI inspect session owns the keyboard. */
const modalOpen = () =>
  Boolean(document.querySelector("dialog[open][data-modal-form]")) ||
  document.documentElement.classList.contains("reels-inspecting");
export function WorkspaceToolbar({
  navigation,
  items,
  projects,
  onNavigate,
  onJump,
  onProject,
  terminal,
  onTerminal,
  settingsActive,
  desktop,
  devBuild,
  inspecting,
  onInspect,
}: {
  navigation: Navigation<string>;
  items: Item[];
  projects: Project[];
  onNavigate: (key: string) => void;
  onJump: (index: number) => void;
  onProject?: (project: Project) => void;
  terminal?: string;
  onTerminal?: () => void;
  settingsActive: boolean;
  desktop: boolean;
  devBuild?: boolean;
  inspecting?: boolean;
  onInspect?: () => void;
}) {
  const keymap = useKeymap();
  const key = (action: "quickOpen" | "inspectUi" | "toggleDrawer") =>
    formatKey(keymap[action][0]);
  const [panel, setPanel] = useState<"history" | "search" | null>(null);
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (panel) {
      dialog.current?.showModal();
      if (panel === "search") dialog.current?.querySelector("input")?.focus();
    } else dialog.current?.close();
  }, [panel]);
  useEffect(() => {
    if (devBuild && !document.title.endsWith(" Dev"))
      document.title = `${document.title} Dev`;
  }, [devBuild]);
  useShortcut(
    "quickOpen",
    () => {
      setQuery("");
      setPanel((p) => (p === "search" ? null : "search"));
    },
    (_action, event) =>
      // Keep an in-progress content form and terminal editing shortcuts intact.
      !modalOpen() &&
      !(
        event instanceof KeyboardEvent &&
        (event.altKey ||
          (event.ctrlKey &&
            event.target instanceof Element &&
            event.target.closest(".dev-terminal")))
      ),
  );
  const back = () => onJump(navigation.index - 1);
  const forward = () => onJump(navigation.index + 1);
  // History keys and mouse side buttons must not swap the screen behind an open
  // content form or an inspect session (the inspector does not suppress mouseup).
  useShortcut("goBack", back, () => !modalOpen() && canBack(navigation));
  useShortcut("goForward", forward, () => !modalOpen() && canForward(navigation));
  const normalized = query.trim().toLocaleLowerCase();
  const matches = (text: string) =>
    text.toLocaleLowerCase().includes(normalized);
  const foundItems = items.filter(([, label]) => matches(label));
  const foundProjects = projects.filter((p) =>
    matches(`${p.title} ${p.nextAction}`),
  );
  const close = () => {
    // Control state here, not in the queued native `close` event: that event
    // may arrive after the user has already reopened this dialog.
    dialog.current?.close();
    setPanel(null);
  };
  return (
    <>
      <header
        className={`workspace-toolbar ${desktop ? "native-toolbar" : ""}`}
        aria-label="작업공간 도구"
      >
        <div className="shell-tools-left">
          {devBuild && (
            <span
              className="dev-build-badge"
              title="소스에서 실행한 개발 빌드예요. 설치된 앱과 별개로 동작해요."
            >
              DEV
            </span>
          )}
          <button
            className="shell-icon"
            aria-label="뒤로"
            title="뒤로"
            disabled={!canBack(navigation)}
            onClick={back}
          >
            ‹
            <ShortcutHint action={canBack(navigation) ? "goBack" : undefined} />
          </button>
          <button
            className="shell-icon"
            aria-label="앞으로"
            title="앞으로"
            disabled={!canForward(navigation)}
            onClick={forward}
          >
            ›
            <ShortcutHint
              action={canForward(navigation) ? "goForward" : undefined}
            />
          </button>
          <button
            aria-label="히스토리"
            title="최근 화면 히스토리"
            onClick={() => setPanel("history")}
          >
            <Glyph name="history" />
            <span>히스토리</span>
          </button>
          <button
            aria-label="검색"
            title={`검색 (${keymap.quickOpen.map(formatKey).join(" / ")})`}
            onClick={() => {
              setQuery("");
              setPanel("search");
            }}
          >
            <Glyph name="search" />
            <span>검색</span>
            <kbd>{key("quickOpen")}</kbd>
            <ShortcutHint action="quickOpen" />
          </button>
        </div>
        <div className="shell-tools-right">
          {onInspect && (
            <button
              aria-label="화면 검사"
              aria-pressed={Boolean(inspecting)}
              title={`화면 검사 (${key("inspectUi")})`}
              onClick={onInspect}
            >
              <Glyph name="inspect" />
              <span>화면 검사</span>
              <ShortcutHint action="inspectUi" />
            </button>
          )}
          {onTerminal && (
            <button
              aria-label="터미널"
              aria-expanded={terminal === "open"}
              title={`터미널 (${key("toggleDrawer")})`}
              onClick={onTerminal}
            >
              <Glyph name="terminal" />
              <span>터미널</span>
              <ShortcutHint action="toggleDrawer" />
            </button>
          )}
          <button
            aria-label="설정"
            aria-current={settingsActive ? "page" : undefined}
            onClick={() => onNavigate("settings")}
          >
            <Glyph name="settings" />
            <span>설정</span>
          </button>
        </div>
      </header>
      <dialog
        ref={dialog}
        className="shell-dialog"
        aria-labelledby="shell-dialog-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            event.altKey ||
            event.metaKey ||
            event.ctrlKey
          )
            return;
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          const input = dialog.current?.querySelector("input");
          const results = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              ".shell-results button",
            ),
          ];
          const index = results.indexOf(target as HTMLButtonElement);
          if (target !== input && index < 0) return;
          if (target === input && event.key === "Enter" && results.length) {
            event.preventDefault();
            results[0].click();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!results.length) return;
            const next =
              index < 0
                ? event.key === "ArrowDown"
                  ? 0
                  : results.length - 1
                : event.key === "ArrowDown"
                  ? index + 1
                  : index - 1;
            if (index >= 0 && (next < 0 || next >= results.length) && input)
              input.focus();
            else results[(next + results.length) % results.length].focus();
          } else if (
            index >= 0 &&
            (event.key === "Home" || event.key === "End")
          ) {
            event.preventDefault();
            results[event.key === "Home" ? 0 : results.length - 1]?.focus();
          }
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            const r = e.currentTarget.getBoundingClientRect();
            if (
              e.clientX < r.left ||
              e.clientX > r.right ||
              e.clientY < r.top ||
              e.clientY > r.bottom
            )
              close();
          }
        }}
      >
        {panel && (
          <>
            <div className="shell-dialog-heading">
              <h2 id="shell-dialog-title">
                {panel === "history" ? "최근 화면 히스토리" : "작업공간 검색"}
              </h2>
              <button onClick={close} aria-label="검색·히스토리 닫기">
                닫기
              </button>
            </div>
            {panel === "history" ? (
              <div className="shell-results">
                {navigation.entries
                  .map((key, index) => (
                    <button
                      key={index}
                      aria-current={
                        index === navigation.index ? "page" : undefined
                      }
                      onClick={() => {
                        close();
                        onJump(index);
                      }}
                    >
                      <span>
                        {items.find(([id]) => id === key)?.[1] ?? key}
                      </span>
                      <small>
                        {index === navigation.index
                          ? "현재 화면"
                          : `${index + 1}`}
                      </small>
                    </button>
                  ))
                  .reverse()}
              </div>
            ) : (
              <>
                <input
                  autoFocus
                  aria-label="메뉴·콘텐츠 검색"
                  aria-describedby="shell-search-help"
                  aria-controls="shell-search-results"
                  placeholder="메뉴, 콘텐츠 제목, 다음 할 일 검색"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <p id="shell-search-help" className="shell-search-help">
                  ↑↓ 이동 · Enter 열기 · Esc 닫기
                </p>
                <div className="shell-results" id="shell-search-results">
                  <h3>메뉴 · {foundItems.length}</h3>
                  {foundItems.slice(0, 8).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => {
                        close();
                        onNavigate(key);
                      }}
                    >
                      {label}
                      <small>화면 열기</small>
                    </button>
                  ))}
                  {foundItems.length > 8 && (
                    <p className="shell-search-help">
                      메뉴 {foundItems.length}개 중 8개를 표시해요. 검색어로
                      좁혀 주세요.
                    </p>
                  )}
                  <h3>콘텐츠 · {foundProjects.length}</h3>
                  {foundProjects.slice(0, 8).map((p) =>
                    onProject ? (
                      <button
                        key={p.id}
                        onClick={() => {
                          close();
                          onProject(p);
                        }}
                      >
                        <span>
                          {p.title}
                          <small>{p.nextAction}</small>
                        </span>
                        <small>{p.date}</small>
                      </button>
                    ) : (
                      <article key={p.id}>
                        <strong>{p.title}</strong>
                        <p>{p.nextAction}</p>
                        <small>{p.date}</small>
                      </article>
                    ),
                  )}
                  {!foundItems.length && !foundProjects.length && (
                    <p role="status">검색 결과가 없어요.</p>
                  )}
                  {foundProjects.length > 8 && (
                    <p className="shell-search-help">
                      콘텐츠 {foundProjects.length}개 중 8개를 표시해요.
                      검색어로 좁혀 주세요.
                    </p>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </dialog>
    </>
  );
}
function Glyph({ name }: { name: string }) {
  const paths: Record<string, string> = {
    history: "M3 10a9 9 0 1 1 1 7 M3 4v6h6 M12 7v5l3 2",
    search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    terminal: "M4 6l6 6-6 6 M12 18h8",
    settings: "M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6",
    inspect: "M8 3H3v5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5 M9 9l9 4-5 1-1 5z",
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
