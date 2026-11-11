# UI 디자인 시스템

2026-11-02 도입, 2026-11-11 Notion 방향으로 재정의(`refactor/notion-ui`). 화면마다 따로 정하던 색·글자·버튼·탭·행·알림·다이얼로그·메뉴를 공용 토큰과 컴포넌트 하나씩으로 모았다.

원칙은 다섯 줄이다.

1. 콘텐츠가 주인공이다. chrome(제목·도구·상태)은 한 줄로 줄인다.
2. 박스로 나누지 않는다. 여백과 제목 위계로 나누고, 꼭 필요할 때만 1px hairline을 쓴다. 박스 안의 박스는 만들지 않는다.
3. 한 화면에 채움(primary) 버튼은 하나다. 나머지는 quiet 버튼이고 hover 때만 배경이 생긴다.
4. 보조 동작은 `⋯` 메뉴, hover 때 나타나는 아이콘, 단축키로 옮긴다. 숨겨도 메뉴·단축키로 도달할 수 있어야 한다.
5. 상태는 회색 한 줄로 조용하게 보여 준다. 색은 오류·경고에만 쓴다.

## 파일

| 파일 | 역할 |
|------|------|
| `src/shared/ui/tokens.css` | 디자인 토큰. 화면 CSS는 hex·px 리터럴 대신 이 값만 쓴다. |
| `src/shared/ui/components.css` | 전역 기본 요소(body, h1–h4, button, input, select, textarea, label, dialog, summary, hr, 스크롤바, 포커스, reduced-motion)와 공용 클래스(`.ui-*`, 예전 이름 `.panel` `.notice` `.error` `.empty` `.eyebrow` 호환). |
| `src/shared/ui/primitives.tsx` | React 래퍼: `Button` `IconButton` `Section` `Card` `SectionHeader` `Toolbar` `Spacer` `Badge` `Dot` `Notice` `StatusText` `EmptyState` `FieldHelp` `Tabs` `Segmented` `Dialog`, 아이콘 `CloseIcon` `MoreIcon` `PlusIcon` `ChevronDownIcon` `HelpIcon`, 유틸 `cx`. |
| `src/shared/ui/Popover.tsx` | 공용 팝오버 `Popover`(`?` 도움말 등)와 `⋯` 메뉴 `Menu`. |
| `src/shared/ui/terminal-theme.ts` | `terminalTheme()`: `--terminal-*` 토큰을 xterm `ITheme` 모양으로 읽는다. |
| `src/shared/ui/{markdown,conversation,execution-logs}.css` | 공용 보고서 Markdown, 대화 피드, 실행 로그. 토큰만 쓴다. |

`src/renderer/main.tsx`가 `tokens.css` → `components.css`를 가장 먼저 불러온다. 화면 CSS는 그 뒤에 로드되므로 배치만 덮어쓴다. 같은 진입점을 쓰는 단독 블로그 에디터(`?blogEditor`)에도 똑같이 적용된다.

## 토큰

### 색

| 토큰 | 값 | 쓰는 곳 |
|------|----|---------|
| `--color-bg` | `#ffffff` | 페이지 배경 |
| `--color-sidebar` | `#f7f7f5` | 사이드바 배경 |
| `--color-surface` | `#ffffff` | 입력·팝오버·다이얼로그 배경 |
| `--color-surface-muted` | `#f7f7f5` | 읽기 전용 입력, 코드·로그 블록 |
| `--color-surface-sunken` | `#f1f1ef` | 배지, 썸네일 자리, 아바타 |
| `--color-border` | `#e9e9e7` | hairline 구분선 |
| `--color-border-strong` | `#d3d2ce` | 입력·secondary 버튼 테두리 |
| `--color-text` | `#37352f` | 본문, 선택된 항목 글자 |
| `--color-text-muted` | `#6b6a66` | 보조 텍스트, quiet 버튼·아이콘 |
| `--color-text-subtle` | `#72716c` | 메타·상태·placeholder. 흰 바탕 4.89:1, 사이드바 4.56:1 |
| `--color-hover` | `rgb(55 53 47 / 6%)` | 버튼·행·탭 hover |
| `--color-selected` | `rgb(55 53 47 / 9%)` | 선택된 탭·행·사이드바 항목, 켜진 토글 |
| `--color-pressed` | `rgb(55 53 47 / 12%)` | 누르는 순간 |
| `--color-backdrop` | `rgb(15 15 15 / 24%)` | 모달 backdrop(블러 없음) |
| `--color-primary` (+`-hover` `-soft` `-text`) | `#386354` | 강조색 하나. primary 버튼, 링크, 체크 |
| `--color-focus` / `--color-focus-soft` | primary 55% / 18% | 키보드 포커스 링 / 입력 포커스 링·텍스트 선택 |
| `--color-danger*` `--color-warning*` `--color-success*` | 기존 값, soft 배경은 더 옅게 | 오류·경고에만. `--color-danger-border`는 danger 알림 테두리 |

반투명 hover·selected는 흰 바탕과 사이드바 어디에 올려도 같은 단계로 보인다. 녹색 기운이 도는 배경·테두리(`#eef1e9` `#dfe6d8` `#e6eee4` 류)는 더 이상 쓰지 않는다.

### 터미널

`--terminal-bg #191919`, `--terminal-fg #e6e6e4`, `--terminal-muted #9b9a97`, `--terminal-selection`, `--terminal-cursor`, `--terminal-cursor-accent`, ANSI 16색 `--terminal-ansi-{black,red,green,yellow,blue,magenta,cyan,white}`와 `--terminal-ansi-bright-*`. xterm은 `new Terminal({ theme: terminalTheme() })`로 읽는다. 터미널 패널 밖에서는 쓰지 않는다.

### 글자·간격·모양

- 글자 크기는 `--text-xs`(11) · `--text-sm`(12) · `--text-base`(13) · `--text-md`(14) · `--text-lg`(16) · `--text-xl`(18) · `--text-2xl`(22) · `--text-3xl`(28)만 쓴다. 11px 미만 UI 텍스트는 만들지 않는다.
- 제목: 페이지 `h1` 22px semibold가 상한, 섹션 `h2` 16px, `h3` 14px, `h4` 13px. 굵기는 semibold(600)가 기본 상한이다.
- 본문·버튼·입력 13px, 목록 행·사이드바 항목 14px, 메타·상태·라벨 12px, 배지 11px.
- 간격은 4px 그리드 `--space-1..10`(4/8/12/16/20/24/32/40).
- radius: 컨트롤 `--radius-sm`(6), 작은 컨트롤·메뉴 항목 `--radius-xs`(4), 팝오버·다이얼로그 `--radius-md`(8). `--radius-lg`·`--radius-xl`은 호환용으로 8px을 가리킨다. 12px 이상 라운드와 pill 버튼은 쓰지 않는다(`--radius-pill`은 배지 전용).
- 그림자: `--shadow-popover`(팝오버·메뉴·토스트), `--shadow-dialog`(다이얼로그)만 쓴다. `--shadow-sm`은 `none`이 됐고 `--shadow-md`·`--shadow-lg`는 위 두 값을 가리킨다. 섹션·카드에는 그림자가 없다.
- 높이: `--control-xs` 24(`button.small`), `--control-sm` 28(기본 버튼·아이콘 버튼·탭), `--control-md` 32(입력·select·`button.large`), `--control-lg` 36, `--row-height` 30(목록 행·사이드바 항목).
- 층: `--z-sticky` 20, `--z-popover` 1000, `--z-toast` 1100.
- 다크 모드는 아직 없다(`color-scheme: light`).

### 호환 별칭

`--green` `--green-dark` `--muted` `--line` `--paper` `--amber` `--text` `--surface` `--border` `--accent`는 새 토큰을 가리키도록 남겨 두었다. 새 코드에서는 쓰지 않는다.

## 컴포넌트

### 버튼

| 모양 | 마크업 | React |
|------|--------|-------|
| quiet(기본): 투명, hover 때 `--color-hover` | `<button>` | `<Button>` |
| quiet, 글자 한 단계 옅게 | `<button class="quiet">` | — |
| secondary: hairline 테두리 | `<button class="secondary">` | `<Button variant="secondary">` |
| primary: 채움, 화면당 1개 | `<button class="primary">` | `<Button variant="primary">` |
| danger: 채움, 파괴 확인 다이얼로그에만 | `<button class="danger">` | `<Button variant="danger">` |
| 아이콘 28px 정사각 | `<button class="icon-button" aria-label="설정" title="설정"><svg/></button>` | `<IconButton label="설정"><svg/></IconButton>` |

- 크기: `.small`(24px, 12px 글자), 기본 28px, `.large`(32px). 입력 옆에 둘 버튼은 `.large`로 높이를 맞춘다.
- 토글 상태: `.icon-button`·`.quiet`에 `aria-pressed="true"`나 `aria-expanded="true"`를 주면 `--color-selected` 배경이 된다. `IconButton`의 `pressed` prop이 같은 일을 한다.
- 아이콘은 16px, `currentColor` stroke 1.5. 공용 아이콘은 `primitives.tsx`에 있다.

### 입력

- `input` `select` `textarea`는 클래스 없이 32px, `--color-border-strong` hairline, `:focus` 때 primary 테두리와 옅은 링을 받는다. 화면 CSS에서 padding·border·배경을 다시 정하지 않는다.
- 숫자·짧은 값은 `class="ui-narrow"`(96px)나 `class="ui-inline"`(내용 폭)으로 좁힌다.
- 체크박스 한 줄: `<label class="ui-check"><input type="checkbox" />모바일에 공유</label>`.
- 라벨은 12px medium 회색이다. 도움말은 상시 문단 대신 placeholder, `title`, `<Popover>`로 둔다. 꼭 필요하면 `.field-help` 한 줄.

### 섹션과 제목

- `<section class="ui-section">`(React `<Section>`)은 테두리·배경·그림자가 없고 아래 여백 32px만 있다. 위쪽 경계가 필요하면 `data-divided`(`<Section divided>`).
- `.panel`·`.ui-card`·`<Card>`도 같은 무테 섹션이 됐다(예전 이름 호환). 화면 CSS에 남은 `.xxx .panel { padding }`은 각 화면이 정리한다.
- `<SectionHeader title actions description />`: 제목 줄 오른쪽에 동작, 아래 회색 메타 한 줄.
- `.eyebrow`·`.ui-eyebrow`는 `display: none`이다. 영문 대문자 라벨을 새로 만들지 않는다.
- 회색 메타 한 줄: `.ui-meta`. 말줄임: `.ui-truncate`. 화면에서만 숨김: `.ui-sr-only`. 단축키 표시: `<kbd class="ui-kbd">⌘K</kbd>`.
- 구분선: `<hr>` 또는 `.ui-divider`(1px `--color-border`).

### 한 줄 상단 바

```html
<div class="ui-toolbar" data-divided>
  <h1>합성 산책 기록</h1>
  <span class="ui-status">저장됨 · 14:02</span>
  <span class="ui-spacer"></span>
  <button>추천 받기</button>
  <button class="primary">검토</button>
  <!-- ⋯ 메뉴: <Menu label="더 보기" items={…} /> -->
</div>
```

React: `<Toolbar divided>…<Spacer />…</Toolbar>`.

### 탭과 세그먼트(한 가지 모양)

텍스트 탭에 선택 시 `--color-selected` 배경. 테두리 버튼형 탭은 쓰지 않는다.

- 탭 패널이 있으면 `<Tabs label="블로그 화면" items={[{value:"projects",label:"프로젝트"},…]} value onChange />`. role=tablist/tab, roving tabIndex, ←→ Home End로 이동하며 선택한다. 패널(role=tabpanel)은 화면이 그린다. `items[].id`·`controls`로 aria 연결.
- 패널 없이 보기만 바꾸면 `<Segmented label="오른쪽 패널" items={[{value:"review",label:"검토"},{value:"chat",label:"채팅"},{value:"memo",label:"메모"}]} value onChange />`(role=group + aria-pressed).
- 직접 마크업할 때는 컨테이너에 `.ui-tabs` 또는 `.ui-segmented`를 달고, 선택 표시는 `aria-selected` `aria-pressed` `aria-current="page"` `.active` 중 하나를 쓴다. `data-size="small"`이면 24px.

### 목록 행

```html
<ul class="ui-list" data-divided>
  <li>
    <button class="ui-row" aria-current="true">
      <svg class="ui-row-icon"/>
      <span class="ui-row-title">합성 산책 기록</span>
      <span class="ui-row-meta">11월 11일</span>
      <span class="ui-row-actions"><!-- 보조 동작 --></span>
    </button>
  </li>
</ul>
```

- 테두리 없는 행 + hover 배경. 선택은 `aria-selected="true"`, `aria-current`, `.selected`.
- `data-divided`면 행 사이 hairline(Notion 데이터베이스 행).
- `.ui-row-actions`는 행 hover·포커스 때만 보인다. `opacity`로 숨기므로 접근 이름과 클릭 대상은 그대로이고, 터치 기기에서는 항상 보인다. 행 밖에서 같은 동작이 필요하면 `.ui-hover-host` 안의 `.ui-hover-reveal`.
- 버튼 안에 버튼을 넣을 수 없으니, 행 전체가 버튼이면서 보조 동작이 있으면 `<div class="ui-row" data-clickable>` 안에 제목 버튼과 `.ui-row-actions`를 나란히 둔다.
- 카드 그리드는 썸네일이 주인공일 때만 쓴다.

### 알림과 상태

- `<Notice>`(`.ui-notice`): 배경 없는 한 줄 텍스트, 앞에 아이콘을 둘 수 있다(`icon` prop). `tone="warning"`은 글자색만 바뀐다. `tone="danger"`만 옅은 배경 + hairline + role=alert. `.notice`·`.error`는 예전 이름 호환이다.
- `<StatusText live busy tone>`(`.ui-status`): "저장됨 · 14:02" 같은 12px 회색 한 줄. `live`면 role=status, `busy`면 작은 스피너(`.ui-spinner`).
- `<Dot tone label>`(`.ui-dot`): 6px 상태 점. 변경이 있거나 실행 중일 때만 그린다.
- `<Badge tone>`(`.ui-badge`): 20px pill. 개수·단계 같은 짧은 값에만.
- 같은 상태를 두 군데 보여 주지 않는다. 성공은 색 없이 회색 문구로 충분하다.

### 빈 상태

`<EmptyState icon title description actions />`: 32px 아이콘(테두리 원 없음), 14px 제목, 12px 회색 한 줄. 설명 문단을 길게 쓰지 않는다.

### 다이얼로그

- 클래스 없는 native `<dialog>`도 흰 배경, 8px radius, `--shadow-dialog`, 24px 안쪽 여백, 옅은 `::backdrop`을 받는다. 화면 CSS에서 blur·큰 그림자·짙은 backdrop을 다시 정하지 않는다.
- 공통 구조: `<dialog class="ui-dialog">` + `.ui-dialog-header`(h2 + 닫기 아이콘 버튼) / `.ui-dialog-body` / `.ui-dialog-footer`(오른쪽 정렬, 주 버튼은 마지막 하나). `data-size="small|large"`로 360/760px.
- React: `<Dialog open onClose title="콘텐츠 기록" footer={<><Button onClick={close}>취소</Button><Button variant="primary" type="submit" form="…">저장</Button></>} aria-label="콘텐츠 기록" data-modal-form>…</Dialog>`. open은 부모 상태가 쥐고, Esc·닫기·backdrop 클릭은 모두 `onClose`로 온다(native cancel은 막는다). 나머지 props는 `<dialog>`에 그대로 붙는다.

### 팝오버와 `⋯` 메뉴

모든 화면이 `src/shared/ui/Popover.tsx` 하나를 쓴다.

```tsx
<Menu
  label="더 보기"                       // 트리거 aria-label·title, 메뉴 접근 이름
  items={[
    { label: "사진 넣기", onSelect: addPhoto, hint: "⌘⇧P" },
    { label: "본문 폭", onSelect: toggleWidth, checked: wide },
    { separator: true },
    { heading: "묶음" },
    { label: "묶음 삭제", tone: "danger", onSelect: remove, disabled: !selected },
  ]}
/>
<Menu label="새 세션" trigger={<PlusIcon />} placement="bottom-start" items={…} />
<Popover label="단축키 도움말">…</Popover>   // 기본 트리거는 `?` 아이콘
```

- 트리거: `aria-haspopup="menu"`(Popover는 `"dialog"`), `aria-expanded`, 열렸을 때 `aria-controls`. `trigger`를 주면 그 내용으로 버튼을 그리고(글자 버튼이면 접근 이름은 `label`), `triggerProps`로 `data-testid` 등을 넘긴다.
- 메뉴: role=menu, 항목 role=menuitem(`checked`가 있으면 menuitemcheckbox). 항목에 `testId`를 주면 `data-testid`가 된다.
- 키보드: 트리거에서 ↓/Enter/Space는 열고 첫 항목, ↑는 마지막 항목으로. 메뉴 안 ↑↓(순환)/Home/End, Esc는 닫고 트리거로 포커스 복귀, Tab은 닫기. 바깥 pointerdown으로 닫힌다. 항목을 고르면 닫고 트리거로 포커스를 돌린 뒤 `onSelect`를 부른다.
- 위치: 트리거 기준 `position: fixed`라 `overflow: hidden` 부모에서도 잘리지 않는다. 아래 공간이 모자라면 위로 뒤집는다(바닥의 터미널 탭바). 조상에 `transform`·`filter`·`contain`이 있으면 fixed 기준이 바뀌므로 그런 컨테이너 안에는 두지 않는다.

### ⌘ 단축키 힌트

`.shortcut-hint`는 ⌘를 누르는 동안만 보이는 작은 어두운 꼬리표다. 정본은 `src/shared/ui/shortcuts`.

## 하지 말 것

- 화면 CSS에 hex 색, rgba 리터럴, 토큰에 없는 px 글자 크기를 새로 쓰지 않는다. 필요한 값이 없으면 토큰을 먼저 제안한다.
- 섹션·카드에 테두리 박스 + 배경 + 그림자를 함께 주지 않는다. 박스 안에 박스를 넣지 않는다.
- 한 화면에 `.primary`를 두 개 이상 두지 않는다. 보조 동작을 테두리 버튼으로 줄 세우지 않는다.
- 상시 안내 문단, 단축키 안내 띠, 영문 대문자 eyebrow, 내부 브랜딩 문구("REELS DASHBOARD / …")를 UI에 넣지 않는다.
- 탭을 테두리 버튼 모양으로 만들지 않는다. 하위 내비게이션은 `.ui-tabs`/`.ui-segmented` 한 가지다.
- 12px 이상 라운드, pill 모양 버튼, 블러 backdrop, 큰 그림자를 쓰지 않는다.
- 녹색 기운이 도는 회색(`#eef1e9` `#f6f7f3` `#dfe6d8` 등)을 배경·테두리에 쓰지 않는다. 강조가 필요하면 `--color-primary` 계열 하나만.
- 성공·정보 상태에 색 배경 띠를 쓰지 않는다. 같은 상태를 두 번 보여 주지 않는다.
- 보조 동작을 숨길 때 `display: none`으로 DOM 접근을 끊지 않는다. `⋯` 메뉴나 `.ui-row-actions`(opacity)를 쓰고 aria-label·data-testid는 유지한다.
- `⋯` 메뉴·팝오버를 화면마다 새로 만들지 않는다. `Menu`/`Popover`를 쓴다.
- 터미널 색을 TSX에 하드코딩하지 않는다. `terminalTheme()`과 `--terminal-*`를 쓴다.
- 다크 모드 블록을 화면 CSS에 따로 만들지 않는다(도입하면 tokens.css에서 한 번에).

## 적용 현황

- 2026-11-11 기반 단계: 토큰·`components.css`·`primitives.tsx`·`Popover.tsx`·`terminal-theme.ts`와 공용 `markdown/conversation/execution-logs.css`를 새 기준으로 바꿨다. 전역 기본 요소 규칙은 모두 `components.css`에 있다(`styles.css`의 reduced-motion 블록도 옮겼다).
- 화면 CSS(`styles.css`, `shell.css`, `content-board`, `canonical-editor.css`, `blog.css`, `workbench.css`, `workflow.css` 등)에는 아직 녹색 계열 hex와 테두리 카드가 남아 있다. 블로그·터미널부터 화면 단계에서 이 문서 기준으로 옮긴다.
