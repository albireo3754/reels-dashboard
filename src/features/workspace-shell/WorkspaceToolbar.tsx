import { useEffect, useRef, useState } from "react";
import type { Project } from "../../shared/contracts";
import type { Navigation } from "./navigation";
import "./shell.css";

type Item = [string, string];
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
  inspecting?: boolean;
  onInspect?: () => void;
}) {
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
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || event.altKey) return;
      // Keep an in-progress content form and terminal editing shortcuts intact.
      if (document.querySelector(".modal-backdrop")) return;
      if (
        event.ctrlKey &&
        event.target instanceof Element &&
        event.target.closest(".dev-terminal")
      )
        return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setQuery("");
        setPanel((p) => (p === "search" ? null : "search"));
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const normalized = query.trim().toLocaleLowerCase();
  const matches = (text: string) =>
    text.toLocaleLowerCase().includes(normalized);
  const foundItems = items.filter(([, label]) => matches(label));
  const foundProjects = projects.filter((p) =>
    matches(`${p.title} ${p.nextAction}`),
  );
  const close = () => {
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
          <button
            className="shell-icon"
            aria-label="뒤로"
            title="뒤로"
            disabled={navigation.index === 0}
            onClick={() => onJump(navigation.index - 1)}
          >
            ‹
          </button>
          <button
            className="shell-icon"
            aria-label="앞으로"
            title="앞으로"
            disabled={navigation.index === navigation.entries.length - 1}
            onClick={() => onJump(navigation.index + 1)}
          >
            ›
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
            title="검색 (⌘K / Ctrl+K)"
            onClick={() => {
              setQuery("");
              setPanel("search");
            }}
          >
            <Glyph name="search" />
            <span>검색</span>
            <kbd>⌘K</kbd>
          </button>
        </div>
        <div className="shell-tools-right">
          {onInspect && (
            <button
              aria-label="화면 검사"
              aria-pressed={Boolean(inspecting)}
              title="화면 검사 (⌘⇧C)"
              onClick={onInspect}
            >
              <Glyph name="inspect" />
              <span>화면 검사</span>
            </button>
          )}
          {onTerminal && (
            <button
              aria-label="터미널"
              aria-expanded={terminal === "open"}
              title="터미널 (⌘N)"
              onClick={onTerminal}
            >
              <Glyph name="terminal" />
              <span>터미널</span>
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
        onCancel={() => setPanel(null)}
        onClose={() => setPanel(null)}
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
