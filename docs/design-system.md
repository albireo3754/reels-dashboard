# UI 디자인 시스템

2026-11-02 도입. 화면마다 따로 정하던 글자 크기·색·버튼 모양을 공통 토큰과 컴포넌트로 모았다.

## 구성

| 파일 | 역할 |
|------|------|
| `src/shared/ui/tokens.css` | 디자인 토큰(글꼴, 글자 크기, 굵기, 색, 간격, radius, 그림자, 컨트롤 높이). 기존 `--green`·`--muted`·`--line` 등은 호환 별칭으로 남겼다. |
| `src/shared/ui/components.css` | 기본 요소(body, h1–h4, button, input, label)와 공통 클래스(`.panel`, `.eyebrow`, `.notice`, `.error`, `.empty`, `.ui-badge`, `.ui-section-header`, `.ui-segmented`, `.field-help`). |
| `src/shared/ui/primitives.tsx` | React 래퍼: `Button`, `Card`, `SectionHeader`, `Badge`, `Notice`, `EmptyState`, `FieldHelp`. |

`src/renderer/main.tsx`가 두 CSS를 가장 먼저 불러온다. 화면 CSS는 그 뒤에 로드되므로 배치·특수 모양만 덮어쓴다.

## 규칙

- 글자 크기는 `--text-xs`(11) · `--text-sm`(12) · `--text-base`(13) · `--text-md`(14) · `--text-lg`(16) · `--text-xl`(18) · `--text-2xl`(22) · `--text-3xl`(28)만 쓴다. 11px 미만 UI 텍스트를 만들지 않는다. 예외는 템플릿 미리보기(`templates.css`의 `.sample-*`)와 큰 장식 숫자·아이콘이다.
- 본문 단락은 `--text-base` 이상, 메타·도움말은 `--text-sm`, 배지·eyebrow·카운트만 `--text-xs`.
- 굵기는 `--weight-regular/medium/semibold/bold`(400/500/600/700)만 쓴다.
- 글꼴은 `--font-sans`(시스템 글꼴 + Apple SD Gothic Neo)와 `--font-mono`만 쓴다. 화면별 `font-family` 지정은 콘텐츠 미리보기(블로그·템플릿)에 한한다.
- 텍스트 색은 `--color-text`(본문) / `--color-text-muted`(보조) / `--color-text-subtle`(메타). 테두리는 `--color-border`, 카드 배경은 `--color-surface`.
- 버튼은 기본(secondary), `.primary`, `.danger`, `.quiet` 네 가지와 `.small`/`.large` 크기만 쓴다. 높이는 `--control-sm/md/lg`(28/34/40).
- 입력·select 높이는 기본 `--control-md`(34). 화면 CSS에서 padding·border·배경을 다시 정의하지 않는다.
- 한글 줄바꿈은 `word-break: keep-all`이 기본이다.

## 적용 범위와 남은 작업

- 토큰 치환: `styles.css`, `editor.css`, `shared/ui/*.css`, `workspace-shell`, `content-board`, `card-news`, `editor-templates`, `ui-inspector`, `subtitle-files`, `dev-workspace`, `route-map` CSS.
- 이번 브랜치에서 제외: `workflow.css`, `blog.css`, `canonical-editor.css`와 관련 TSX(WorkflowPanel, ExperienceForm, BlogWorkspace, CanonicalBlogEditor). 브랜치를 만들 당시 메인 체크아웃에 커밋하지 않은 변경이 있던 파일이다. 이 화면에도 공통 기본 스타일(본문 크기, 버튼, 입력, 제목)은 적용된다. 각 화면 CSS의 하드코딩 값은 진행 중인 작업이 커밋된 뒤 같은 규칙으로 옮긴다.
- 색 치환은 채도가 낮은 중립색만 자동으로 옮겼다. 상태별 색조(전송 카드의 초록·주황 배경 등)는 그대로 두었다.
