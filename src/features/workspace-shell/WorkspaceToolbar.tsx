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
  const close = () => setPanel(null);
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
        onCancel={close}
        onClose={close}
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
                        onJump(index);
                        close();
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
                  placeholder="메뉴, 콘텐츠 제목, 다음 할 일 검색"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <div className="shell-results">
                  <h3>메뉴</h3>
                  {foundItems.map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => {
                        onNavigate(key);
                        close();
                      }}
                    >
                      {label}
                      <small>화면 열기</small>
                    </button>
                  ))}
                  <h3>콘텐츠 · {foundProjects.length}</h3>
                  {foundProjects.slice(0, 50).map((p) =>
                    onProject ? (
                      <button
                        key={p.id}
                        onClick={() => {
                          onProject(p);
                          close();
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
                  {foundProjects.length > 50 && (
                    <p>처음 50개를 표시해요. 검색어를 더 입력해 주세요.</p>
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
