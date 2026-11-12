# 앱 안에서 개발하고 검증하기

현재 진입점은 우측 상단 **터미널** 버튼이다. 콘텐츠 메뉴에 개발 탭을 두지 않는다. [상단 도구와 창 구성](workspace-shell.md)을 따른다.

2026-10-31. 우측 상단의 **터미널**에서 앱 소스와 Codex, 일반 터미널, 로컬 웹 미리보기, 기존 운영 브리핑 사이트를 연결한다. 설치된 Codex CLI를 사용하는 로컬 기능이며 새 API 키나 호스팅 서비스는 만들지 않는다. Codex와 Claude Code를 **Codex 열기·Claude 열기**로 열 수 있고 기본 도구는 Codex다([탭 바 단순화와 Claude 열기](#탭-바-단순화와-claude-열기--2026-11-11)).

## 로컬 개발모드 실행

소스 checkout에서 빌드한 뒤 환경변수를 지정해 실행한다.

```sh
npm run build
REELS_DEV_MODE=1 npm start
```

`REELS_DEV_MODE`가 정확히 `1`일 때만 개발 작업공간을 활성화한다. 미설정·`0`·`false`·`true`는 모두 비활성이다. 일반 실행에서는 메뉴와 preload의 터미널 API가 없고 main의 터미널 IPC도 등록하지 않으며, 작업공간 설정을 읽거나 PTY 관리자를 만들지 않는다. `NODE_ENV`나 웹의 `VITE_*` 설정으로 활성화되지 않는다.

패키징 앱도 실행 프로세스에 같은 환경변수를 전달하면 사용할 수 있다. 이미 실행 중인 앱은 시작할 때의 설정을 유지하므로 다른 모드로 바꾸려면 앱을 종료하고 다시 실행한다.

**설정 토글(2026-11-12):** 환경변수 없이도 **설정 → 터미널 → 터미널 사용**을 켜면 다음 실행부터 개발 작업공간이 활성화된다. 값은 이 Mac의 userData `terminal-settings.json`(`{"enabled": true}`)에만 저장하고, 기본값과 손상·비불리언 값은 꺼짐이다. 시작할 때 한 번만 판단하는 원칙은 그대로라서, 꺼진 실행에서는 여전히 터미널 IPC를 등록하지 않는다. 바꾼 직후 **지금 다시 시작**으로 재실행할 수 있다(진행 중인 작업이나 AI 작업이 있으면 거절). `REELS_DEV_MODE=1`은 저장값과 관계없이 켜고, 설정 화면에 그 사실을 표시한다. 토글을 켜지 않은 Finder 일반 실행은 기본 비활성이다.

Codex가 기본 도구이며 **Codex 열기·Claude 열기**나 설정의 **세션 시작**을 눌렀을 때 선택한 소스 폴더에서 실행한다. 앱 실행만으로 코딩 작업을 자동 제출하지 않는다. 일반 터미널에서도 같은 소스 폴더를 바로 수정할 수 있다. 웹 UI 변경은 미리보기 서버를 통해 확인하고, Electron main·preload 변경은 다시 빌드하고 재실행한다. 이 플래그가 Electron 자동 재시작이나 HMR 런처를 제공하는 것은 아니다.

## 작업공간 탭과 단축키

개발 작업공간은 현재 콘텐츠 화면 위에 여는 하단 패널이다. 우측 상단의 **터미널**이나 `⌘N`으로 열어도 기존 영상·카드뉴스 편집 화면의 상태를 유지한다. 한 줄 탭 바에 세션 탭과 **+**(새 터미널), **▾**(터미널·Codex 열기·Claude 열기·미리보기 서버·검증 실행)가 있고, 오른쪽의 **톱니(터미널 설정)**를 누르면 소스 연결·개선 요청·코딩 도구·세션 유지 설정이 열린다. 탭 바는 설정 영역을 스크롤해도 상단에 유지된다. 단축키는 개발모드에서만 동작한다.

| 키 | 동작 |
| --- | --- |
| `⌘N` | 개발 작업공간 열기 → 접기 → 펼치기 |
| `⌘T` | 탭 바의 **+**와 같다. 연결한 소스 폴더에 새 일반 터미널 탭을 열고 선택 |
| `⌘W` | 패널이 펼쳐져 있으면 현재 세션 종료 후 탭 제거. 빈 패널은 닫기. 패널이 접혀 있거나 닫혀 있으면 앱 창 숨기기 |
| `⌘1–9` | 패널이 펼쳐져 있으면 해당 순서의 세션 탭(탭 바의 N번째 탭), 아니면 사이드바의 해당 메뉴 선택 |
| `⇧⌘C` | 화면 검사 시작 |
| `Esc` | 화면 검사 끝내기. 수정키 없이 누를 때만 동작하고, 댓글 창이 열려 있으면 창과 검사를 함께 닫는다 |

2026-11-04부터 위 키는 `src/shared/keymap.ts`의 중앙 keymap에서 정의한다. `⌘N/T/W/1–9`와 `⇧⌘C`는 개발모드 main의 `before-input-event`가 물리 키(`e.code`)로 판정하고 액션 이름만 renderer에 전달하므로, 미리보기 iframe이나 xterm에 포커스가 있어도 동작한다. 수정키는 정확히 일치해야 한다. 공통 규칙은 [구조 문서의 Shortcuts](architecture.md#shortcuts), 상단 도구의 `⌘K`·`⌘[`/`⌘]`·마우스 뒤로/앞으로 버튼은 [창 구성 문서](workspace-shell.md#단축키--2026-11-04)를 따른다.

- **⌘ 누르고 있기:** 지금 키가 실제로 작용할 위치에 힌트를 표시한다. 패널이 펼쳐져 있으면 세션 탭에 `⌘1–9`, 선택한 탭의 닫기에 `⌘W`(선택한 탭이 없으면 패널 **닫기**)가 붙고, 패널이 닫히거나 접혀 있으면 사이드바 메뉴에 `⌘1–9`가 붙는다. 힌트와 단축키 실행은 같은 `workbenchShortcutTarget` 규칙을 쓴다. 미리보기 iframe에 포커스가 있으면 ⌘ 입력이 상위 화면에 오지 않아 힌트가 표시되지 않는다.
- **화면 검사:** 검사 중 `Esc`는 입력란에 포커스가 있어도 검사를 끝내고, 편집기·콘텐츠 창의 Escape 처리로 전달되지 않는다. 키를 누르고 있어 반복 입력되는 `Esc`와 `⇧Esc`·`⌘Esc`는 처리하지 않는다. 댓글 창에서는 `Enter`로 보내고 `Shift+Enter`로 줄을 바꾼다. 한글 조합 중 `Enter`는 보내지 않으며, 빈 댓글은 보내지 않고, 연속 입력해도 한 번만 보낸다. 댓글 창을 열어도 입력란에 자동으로 포커스가 가지 않는 기존 동작은 유지한다.

탭 전환·패널 접기는 터미널과 프로세스를 유지한다. 패널의 **닫기**도 패널만 숨기며, 탭의 **세션 닫기**는 실행 중인 Codex·셸·미리보기·검증 프로세스를 종료한다. herdr 세션도 단순 detach가 아니라 herdr workspace를 실제로 닫는다. 종료에 실패하면 오류를 표시하고 탭을 유지한다. 앱 종료 시에는 직접 실행 세션과 미리보기·검증이 종료되고, herdr 세션은 유지되어 다음 실행에서 복원된다([herdr 세션 백엔드](#herdr-세션-백엔드--2026-11-10)).

닫은 탭이 선택된 탭이면 오른쪽 탭, 오른쪽이 없으면 왼쪽 탭을 선택한다. 기존 최대 12개 세션 제한을 유지하며 10–12번째 탭은 클릭해서 선택한다. 한글 조합 중 키는 처리하지 않고, 키를 누르고 있어도 새 탭이 반복 생성되지 않는다. 도구 선택·단계·요청문·소스 폴더는 기존 개발 작업 흐름을 사용한다. 사용자별 YAML 단축키 설정과 Workdesk의 업무 메뉴·tmux 백엔드는 이식 범위에 포함하지 않는다. 세션 유지는 tmux 대신 herdr 백엔드로 제공한다.

## 구조 선택

[Workdesk](https://github.com/albireo3754/workdesk/tree/a128734c88a647e6ed07bd9c416b4379295eb7c8)의 `backend/terminal.ts`, `shared/api.ts`, 터미널 entity, Claude session feature를 확인했다. 소스 파일을 복사하지 않고 **호스트의 프로세스 관리 / 프로세스 간 계약 / 화면의 세션 표시** 경계를 참고했다. 기존 Reels Dashboard FSD 계층과 MCP·편집 서비스는 유지한다.

| 위치 | 책임 |
| --- | --- |
| `src/shared/workbench.ts` | 도구·단계·세션·이벤트 계약(`TerminalBackendId`·`TerminalBackendState`·`WorkTerminal.state` 포함), 단계별 요청문 |
| `src/shared/keymap.ts` | 앱 전체 단축키의 유일한 정의: 물리 코드·액션·호스트 범위·힌트 문자열 |
| `src/shared/ui/shortcuts` | renderer 단축키 dispatcher(`ShortcutsProvider`·`useShortcut`)와 ⌘ 힌트(`ShortcutHint`) |
| `src/desktop/development-mode.ts` | 정확한 환경변수 opt-in 판정과 preload capability 이름 |
| `src/desktop/workbench-providers.ts` | Codex 기본값, 활성 도구 목록과 코딩 도구별 실행 인자 |
| `src/desktop/herdr.ts` | Electron에 의존하지 않는 herdr CLI 클라이언트: 세션 이름 검증, label 규칙, workspace 생성·조회·종료, attach 명령, pane 실행 줄 |
| `src/desktop/workbench.ts` | Electron에 의존하지 않는 세션 관리자(node-pty 직접 실행과 herdr attach), 소스 검증·설정 저장·프로세스 생명주기·복원 |
| `src/desktop/main.ts` | 개발모드에서만 관리자·IPC·키 입력 활성화, 상위 renderer로 단축키 전달, 신뢰한 main frame 검사 |
| `src/desktop/preload.ts` | main이 전달한 capability에 따라 typed WorkbenchBridge 노출 |
| `src/features/dev-workspace` | 패널·탭 상태, 호스트 단축키 처리와 `model/shortcut-target.ts` 대상 규칙, `model/backend.ts`의 백엔드 선택·잠금·다시 연결 규칙, 단계·도구 선택, xterm 입출력, 격리된 웹 미리보기 |
| `src/renderer/App.tsx` | desktop bridge가 있을 때만 개발 메뉴 조합; 별도 chunk 로딩 |

터미널 세션 목록은 main 프로세스가 소유한다. 화면을 바꾸거나 세션을 전환해도 프로세스는 유지된다. 재연결 시 구독을 먼저 시작하고 출력 sequence 이후의 이벤트만 적용해 backlog 중복·누락을 막는다. 세션당 최근 256 KiB의 출력을 메모리에 보관하며, 종료 세션을 포함해 최대 12개까지 유지한다. 앱을 종료하면 직접 실행 세션(node-pty가 소유한 프로세스, 미리보기·검증 포함)은 종료된다. herdr 세션은 herdr 서버가 소유하므로 앱 종료 뒤에도 남고 다음 실행에서 탭으로 복원된다. 앱 밖에서 시작한 기존 Codex·Claude 대화를 가져오는 기능은 포함하지 않는다.

## 사용 순서

1. 탭 바의 **톱니(터미널 설정)**를 눌러 설정을 펼친 뒤 **소스 폴더 연결**에서 이 저장소를 선택한다. 개발 실행은 현재 앱 경로, 패키징 실행은 존재하는 `~/side/reels-dashboard`를 초기 후보로 확인한다. 직접 선택한 경로는 앱 userData의 `workbench.json`에 저장된다. 이 파일은 공유 snapshot과 분리된다.
2. 요청과 완료 기준을 적고 **설계** 또는 **구현** 단계에서 기본 도구인 **Codex**(또는 **Claude**)로 시작한다. 요청 입력란에서 **Enter**를 누르면 선택한 도구·단계로 새 세션을 시작하며, **Shift+Enter**는 줄바꿈이다. 빈 요청·한글 조합 중 Enter·키 반복·시작 처리 중에는 제출하지 않는다. 설정의 **세션 시작**이나 탭 바 **▾**의 **Codex 열기·Claude 열기**도 쓸 수 있다. 로그인이 필요하면 터미널의 안내를 따른다. 같은 소스의 구현·수정은 한 세션이 담당하도록 한다.
3. **▾ → 미리보기 서버**를 시작하고 준비 완료 로그를 확인하고 서버가 실행 중일 때 나타나는 **미리보기 나란히 보기**를 누른다. `127.0.0.1:4183/?demo=1`의 예시 데이터 화면이며 Vite가 웹 변경을 반영한다. 실제 제작 데이터 화면으로 오해하지 않는다.
4. **▾ → 검증 실행**은 타입 검사 → FSD 구조 검사 → 단위 테스트 → 웹·desktop 빌드를 순서대로 실행한다. 한 단계가 실패하면 뒤 단계는 실행하지 않고 실제 종료 코드를 표시한다. 기능별 Electron·Swift·편집 엔진 검사는 일반 터미널에서 추가 실행한다.
5. **리뷰**를 선택하고 원래 요청과 구현 결과를 붙여넣어 새 Codex 또는 Claude 세션을 시작한다. 지적을 **수정·재검증** 요청에 포함해 기존 구현 세션에 전달한다. **현재 세션용 프롬프트 복사**는 붙여넣을 요청문만 만들며 입력을 자동 제출하지 않는다.
6. 운영 화면은 **운영 브리핑 사이트**로 연다. 기존 모바일 브리핑 연결의 URL·로그인·자동 동기화를 그대로 사용한다. 이 버튼은 배포하지 않는다.

단계 이동과 결과 전달은 사용자가 조절한다. 무인으로 다른 에이전트에게 결과를 넘기거나 자동 배포하는 루프는 아니다. Electron main/preload 변경은 빌드만으로 실행 앱에 반영되지 않으므로 새 앱을 별도로 실행해 확인한다.

## 실행 경계

- Codex는 설계·리뷰에 `read-only`, 구현·수정에 `workspace-write`, 승인 정책은 `on-request`를 기본으로 지정한다. [공식 승인·보안 문서](https://learn.chatgpt.com/docs/agent-approvals-security)와 설치된 CLI 도움말을 확인했다.
- Claude Code는 2026-11-11부터 활성 도구 목록에 있다. 설계·리뷰 단계는 `--permission-mode plan`, 구현·수정 단계는 `--permission-mode manual`을 기본으로 실행한다. 목록에 없는 도구·종류를 IPC로 요청하면 호스트가 거부한다.
- **승인 없이 실행(YOLO)** — 2026-11-12 사용자 지시로 추가했다. 블로그 **맥락과 함께 수정** 대화상자와 터미널 설정의 체크박스로 세션을 시작할 때마다 고른다(start 계약의 `permission: "ask" | "bypass"`, 생략하면 `ask`). `bypass`는 구현·수정 단계에서만 Codex `--dangerously-bypass-approvals-and-sandbox`, Claude Code `--dangerously-skip-permissions`로 실행하고, 설계·리뷰 단계는 선택과 무관하게 읽기 전용을 유지한다. 마지막 선택은 renderer `localStorage`에 남고 처음 값은 `ask`다. 셸 alias·함수에는 기대지 않는다(`exec`로 실행 파일을 직접 띄운다).
- 일반 터미널과 npm 검사는 사용자 권한의 로컬 셸이다. 작업 폴더 선택은 운영체제 sandbox가 아니다. 입력은 현재 세션에 전달하고 알 수 없는 세션·도구·비정상 크기는 거부한다. 요청문은 셸의 단일 인자로 인코딩한다.
- 실행 중이거나 연결이 끊긴(detached) 세션이 있으면 소스 변경과 세션 백엔드 변경을 거부한다. 미리보기·검증 작업의 중복 실행도 거부한다. 설정이 손상되거나 소스가 이동했으면 다시 연결한다.
- 미리보기 iframe에는 preload/Node/desktop bridge가 없다. 외부 운영 사이트는 시스템 브라우저에서 열고 CLI 인증정보를 웹에 전달하지 않는다. 터미널은 기존 MCP나 공유 웹 API에 노출하지 않는다.
- macOS 앱은 node-pty의 네이티브 모듈을 외부 의존성으로 유지하고 asar에서 풀어 패키징한다. 빌드 단계에서 spawn-helper 실행 권한을 준비한다. xterm은 웹 기본 bundle과 분리한다.

## 이전 리뷰·검증 기록 — 2026-10-28

1차 구현 후 검토에서 발견한 기본 웹 bundle 증가를 lazy chunk로 분리했다. dependency install script가 비활성화된 환경의 spawn-helper 권한 문제를 빌드 단계에서 해결했고, Claude 실행 시 기존 우회 설정을 이어받지 않도록 manual 모드를 명시했다. PTY 출력 snapshot과 이벤트의 순서 경쟁, 세션 전환, 종료 후 자식 서버 잔존 여부를 별도 확인했다.

- 다른 로컬 기능 변경을 포함한 통합 개발 checkout에서 TypeScript 단위 테스트 41개, 타입·FSD 검사, 웹·desktop 빌드 통과.
- GitHub 푸시 전 이번 변경과 사이트 연결의 최소 의존성만 분리한 snapshot에서 단위 테스트 21개, Electron 4개, 타입·FSD·빌드·공개 소스 검사를 다시 통과했다. 다른 채팅의 미커밋 기능 변경은 이 커밋에 포함하지 않았다.
- 패키징 Electron 4개: 실제 키보드 입력·세션 전환/backlog·resize·소스 변경 잠금·종료 코드; 실제 Vite/iframe·서버 종료; 설치된 Codex/Claude 초기 대화 화면; 앱 종료 시 서버 정리.
- 요청문 안의 따옴표·줄바꿈·명령 치환 문자가 인자로 보존되는 단위 검사 통과.
- 패키징 화면에서 터미널·로컬 미리보기 배치를 이미지로 확인했다. CLI smoke check는 작업을 제출하지 않았으며 모델의 실제 코드 수정 성공을 증명하지 않는다.
- 검증 시 임시 userData와 예시 데이터를 사용했다. 실행 중인 기존 앱, 개인 미디어, 운영 브리핑 데이터와 배포는 변경하지 않았다.

앱 산출물: `release/workbench/mac-arm64/Reels Dashboard.app`. 소스 폴더와 CLI 설치는 별도로 필요하다. 기존 앱을 종료하고 이 빌드를 열면 실제 userData를 이어서 사용한다.

```sh
npm run build
node --import tsx --test tests/unit/development-mode.test.ts tests/unit/workbench.test.ts
npm run test:electron -- tests/electron/workbench-mode.spec.ts tests/electron/workbench.spec.ts
# 로컬 Codex가 설치되어 있을 때만 초기 화면 확인 추가
REELS_CLI_QA=1 npm run test:electron -- tests/electron/workbench.spec.ts
```

## 리팩토링 조사·구현·리뷰 — 2026-10-31

상위 에이전트가 범위·계약·통합을 조율하고, 조사 담당이 기존 Workdesk 참조 소스와 Dashboard 경계를 확인했다. 호스트 gate와 provider/UI를 서로 다른 파일 소유권으로 나누어 구현했으며, 별도 QA 담당이 Electron 검사를 추가했다. 조사 담당의 후속 독립 리뷰에서 이번 변경의 결함은 발견되지 않았다. 이 분담은 이번 개발 작업에 사용한 흐름이며 앱 내부에 자동 에이전트 오케스트레이터를 새로 추가한 것은 아니다.

- 타입·FSD 검사, 전체 단위 테스트 64개, 웹·desktop 빌드 통과.
- 개발 Electron 관련 9개 시나리오 통과: 플래그 미설정·`0`·`true`의 메뉴/bridge/실제 IPC 비활성, Codex 기본 선택과 Claude 직접 시작 거부, 임시 소스 폴더에서 PTY 파일 수정, 터미널 재연결·키 입력·소스 변경 잠금·종료, Vite 미리보기와 자식 프로세스 정리, 설치된 Codex CLI 초기 화면.
- 첫 Electron 실행에서 8개가 통과하고 임시 소스 경로 검사가 실패했다. macOS `/var`와 `/private/var`의 정규화 차이를 반영해 테스트 기대값을 `realpath`로 수정한 뒤 해당 시나리오가 통과했다. 제품 코드는 변경하지 않았다.
- 후속 QA 리뷰에서 Claude 거부 검사가 임의 오류도 통과시킬 수 있다는 보강 제안을 반영했다. 정확한 미지원 오류 메시지를 검사하도록 수정하고 해당 검사와 PTY 편집 검사를 다시 통과했다.
- Codex CLI 검사는 모델에 작업을 제출하지 않고 초기 대화 화면까지만 확인했다. 터미널 소스 수정 검사는 합성 checkout에서 수행했다. 실제 모델의 코드 수정이나 새 패키징 앱의 실행은 이번 검증에 포함하지 않았다.
- 기존 실행 앱과 개인 자료를 유지하고 임시 userData를 사용했다. 앱 내부의 단계 전환은 기존처럼 사용자가 담당한다.

## 패키징 앱 갱신 — 2026-10-31 후속 요청

웹·desktop을 다시 빌드하고 기존 native helper/editor runtime을 포함해 `release/dev-mode/mac-arm64/Reels Dashboard.app`를 패키징했다. 별도 프로필과 background QA로 플래그 OFF 3개·Codex 기본/Claude 거부·PTY 파일 수정·설치 Codex 초기 실행 등 패키징 검사 6개가 통과했다.

저장하지 않은 편집과 진행 중 렌더가 없음을 확인한 뒤 기존 앱을 정상 종료했다. 기존 번들을 `release/active-board-before-dev-mode/mac-arm64/Reels Dashboard.app`에 보존하고, 검증한 새 번들을 원래 `release/active-board/mac-arm64/Reels Dashboard.app` 경로에 넣었다. 같은 사용자 프로필로 `REELS_DEV_MODE=1`을 전달해 재실행하고 개발 작업공간·소스 연결·Codex 기본 선택을 실제 화면에서 확인했다. Finder 일반 실행의 플래그 비활성 기본값은 유지한다.

## 탭 구조 이식과 리뷰 루프 — 2026-10-31

Workdesk의 하단 패널·단축키·고정 터미널 인스턴스 구조를 조사하고, 호스트 종료/키 입력과 UI 상태/레이아웃을 분담해 구현했다. 탭 전환에 따라 xterm을 재생성하던 구현을 세션별 인스턴스를 유지하는 구조로 바꿨다. 탭의 종료와 패널 숨김을 구분하고, 종료에 실패하면 탭을 보존한다.

독립 리뷰에서 cross-origin 미리보기에 포커스가 있으면 상위 DOM 키 리스너가 입력을 받지 못하는 문제를 찾았고 실제 Electron 검사로 재현했다. 개발모드 main의 `before-input-event`에서 공통 키 정의로 액션을 판정한 뒤 상위 renderer에 한 번만 전달하도록 수정했다. iframe에는 desktop bridge를 추가하지 않는다. 기존 DOM 리스너는 제거했다.

- 타입·FSD·전체 단위71개 통과. 마지막 수정 후 관련 단위7개·타입·FSD·빌드를 다시 통과했다.
- 개발 Electron 관련13개 통과: 탭/편집기 DOM과 문안 유지, 접힌 터미널 입력·크기 보존, 실제 PID 종료, 인접 탭 선택, 창 숨김, 일반모드, 기존 PTY·Codex 초기 실행·미리보기.
- 키 입력 검사는 `webContents.sendInputEvent`를 사용한다. Playwright CDP `page.keyboard`가 숨김 창의 Electron native hook을 거치지 않는 것은 별도 관찰로 확인했다. IME·반복 키의 native guard도 검사했다.
- 새 `release/workspace-tabs/mac-arm64/Reels Dashboard.app`에서 탭 관련4개 검사 통과. 760px·데스크톱에서 기본 패널과 설정을 펼친 화면을 확인했고, 스크롤 중에도 헤더·탭바를 유지한다.
- 실제 모델에 코딩 작업을 제출하지 않았다. tmux·사용자 지정 단축키 설정은 추가하지 않았다. 앱 재시작 후 터미널 복원은 이 시점에는 없었고 2026-11-10에 herdr 백엔드로 추가했다.

패키징 검증 후, 프로젝트 정리 작업이 저장된 현재 앱(`release/production-projects/mac-arm64/Reels Dashboard.app`)을 정상 종료하고 같은 경로에 새 빌드를 넣었다. 이전 앱은 `release/production-projects-before-workspace-tabs/mac-arm64/Reels Dashboard.app`에 보존했다. 기존 사용자 프로필로 `REELS_DEV_MODE=1`을 전달해 실행하고, 실제 화면에서 새 패널·Codex 시작 버튼과 `⌘N` 접기/펼치기를 확인했다. 콘텐츠 저장소를 교체하거나 병합 결과를 되돌리지 않았다.

## herdr 세션 백엔드 — 2026-11-10

개발 작업공간의 터미널 세션을 앱의 PTY가 아니라 herdr 서버가 소유하게 할 수 있다. 앱은 herdr workspace에 `terminal attach`로 붙는 화면 역할만 한다. 앱을 종료해도 셸·Codex 세션이 남고 다음 실행 때 탭으로 돌아온다. 코드는 `src/desktop/herdr.ts`(CLI 클라이언트), `src/desktop/workbench.ts`(세션 관리·복원), `src/shared/workbench.ts`(계약), `src/features/dev-workspace`(선택 UI·상태 표시)에 있다. Workdesk의 `src/backend/herdr.ts`는 구조만 참고했고 소스를 복사하지 않았다.

### 동작

- 세션 백엔드는 `direct`(기존 node-pty 직접 실행)와 `herdr` 두 가지다. 저장한 선택과 환경변수 override가 없으면 `herdr`를 고른다.
- herdr를 쓰는 종류는 **shell·codex·claude**뿐이다. **미리보기와 검증은 항상 direct**로 실행한다(종료 코드와 자식 프로세스 정리가 필요하다). Claude Code도 같은 herdr 경로로 시작할 수 있다(label 종류 `claude`).
- herdr를 고른 상태라도 실제로 쓰는 백엔드(`effective`)는 herdr가 설치되어 있고(`herdr --version` 성공) 세션 이름이 올바를 때만 `herdr`다. 아니면 `direct`로 실행한다.
- 앱은 herdr 서버를 직접 띄울 수 있다(`herdr --session <이름> server`, detached). 서버는 앱이 종료돼도 남는다. 새 세션을 만들 때와 **다시 연결**을 누를 때만 서버를 띄우고, 시작 시 복원은 서버가 이미 떠 있을 때만 한다.
- 시작할 때 herdr 설치 확인과 복원은 창을 지연시키지 않도록 백그라운드(`Workbench.whenReady()`)에서 돈다. `initialize`는 설정 파일 읽기와 소스 폴더 검증만 기다린다. 조회성 herdr 호출(`--version`, list)의 타임아웃은 4초, workspace 생성·실행·종료는 15초다. 확인 중에는 UI가 "herdr 확인 중이에요."를 표시하고 미설치 안내를 숨기며, `start`·`setTerminalBackend`·`chooseWorkspace`는 확인이 끝날 때까지 기다린 뒤 실행한다.
- 시작 실패 시 정리: workspace 생성이 시간 초과로 실패해도 서버에서는 만들어졌을 수 있으므로 해당 label을 닫는다. 정리까지 실패하면(서버가 꺼진 경우는 제외) 남았을 수 있는 label을 오류 메시지에 붙인다. 생성한 workspace에 실행 줄을 넣지 못하면 그 workspace를 닫고 실패로 처리한다.

### 세션 유지 선택 UI

탭 바의 톱니로 설정을 펼치면 소스 연결 아래에 **세션 유지** 라디오 두 개(`herdr` / `직접 실행`)가 있다.

- `herdr`: 앱을 종료해도 세션이 유지되고 다음 실행 때 탭으로 복원된다. `직접 실행`: 앱을 종료하면 세션도 종료된다.
- 상태 줄에 "새 쉘·코딩 도구 세션: herdr 세션 | 직접 실행"과 herdr 세션 이름·버전, "미리보기·검증 실행은 항상 직접 실행해요."를 표시한다.
- 실행 중이거나 연결이 끊긴 세션이 하나라도 있으면 선택이 잠기고 이유를 표시한다. `REELS_TERMINAL_BACKEND`가 선택을 정한 경우도 잠긴다. 호스트(`setTerminalBackend`)도 같은 조건에서 거부한다.
- herdr를 골랐는데 설치되어 있지 않으면 "herdr 미설치 — 직접 실행 중이에요"와 설치 명령 텍스트(`brew install herdr`)를 보여 준다. 앱이 설치하지 않는다. `REELS_HERDR_SESSION` 형식 오류는 별도로 사유를 표시한다.
- herdr 세션 탭에는 `herdr` 배지가 붙고, 이전 실행에서 복원한 탭은 툴팁으로 구분한다. 연결이 끊긴 탭에는 **다시 연결** 버튼과, 세션 상세에 안내 문구가 나온다.

### 설정과 환경변수

`workbench.json`(앱 userData, 권한 `0600`, 공유 snapshot과 분리)은 `{"workspace": "...", "terminalBackend": "direct" | "herdr"}`를 담는다. `terminalBackend`는 사용자가 라디오로 고른 뒤에만 저장되고, 알 수 없는 값은 기본값(`herdr`)으로 취급한다. 두 환경변수는 앱 실행 프로세스에 지정한다.

| 변수 | 동작 |
| --- | --- |
| `REELS_TERMINAL_BACKEND` | `direct` 또는 `herdr`이면 저장한 선택보다 우선하고 파일에는 쓰지 않는다. UI의 선택은 잠긴다. 다른 값은 무시한다. |
| `REELS_HERDR_SESSION` | 앱이 쓸 herdr 세션 이름. 미지정이거나 빈 값이면 `default`. 형식은 영문·숫자로 시작하고 영문·숫자·`.`·`_`·`-`로 최대 64자. 형식이 틀리면 default로 대체하지 않고 herdr를 쓰지 않으며(`effective=direct`) UI에 이유를 표시한다. 이때 herdr에 어떤 `--session` 명령도 보내지 않는다. |

모든 herdr 호출에 `--session`을 명시하고 `HERDR_*` 환경변수는 제거해서, 앱이 herdr 안에서 실행됐더라도 상속된 소켓이 대상 서버를 바꾸지 못한다.

### label 규칙

앱이 만든 workspace는 `reels-dashboard:<kind>:<uuid>:<sha256(소스 realpath) 앞 12자>` label을 갖는다. 목록·복원·종료는 이 label 형식에 맞는 workspace만 다루므로 사용자의 다른 workspace는 건드리지 않는다.

- `parseHerdrLabel`은 정확히 4개 세그먼트, 알려진 kind, UUID, 소문자 hex 12자일 때만 받는다. 3개 세그먼트인 옛 형식은 앱의 workspace가 아닌 것으로 본다.
- 소유 판정은 pane의 현재 cwd가 아니라 label의 12자 해시다. 셸에서 `cd`로 다른 폴더로 옮겨도 복원된다. 다른 소스 폴더용 workspace는 복원하지 않고 herdr에 남겨 둔다. 소스 폴더를 바꾸는 동작(`chooseWorkspace`)은 복원을 다시 실행하지 않는다.
- 앱에서 쓰는 id(UUID)는 label에서 읽어 오므로, 복원된 탭은 이전 실행의 id를 유지한다.

### 생명주기

| 상황 | 동작 |
| --- | --- |
| 탭 닫기(×, `⌘W`)·세션 종료 | herdr workspace를 실제로 닫는다(이미 없으면 성공으로 본다). 닫은 뒤 attach 프로세스를 정리하고 탭을 `exited`로 둔다. |
| 앱 종료 | attach 프로세스만 끝내고 workspace는 남긴다. 직접 실행 세션과 미리보기·검증은 종료한다. |
| 다음 실행 | 서버가 이미 떠 있으면 현재 소스의 label과 일치하는 shell·codex·claude workspace를 탭으로 복원한다(`restored`). 최대 12개 제한을 지키며 서버를 새로 띄우지 않는다. 앱이 보관하던 최근 출력(256 KiB)은 복원하지 않고, 복원 직후 화면은 attach가 보내는 내용을 따른다. |
| attach 종료 | 앱이 자동으로 다시 붙지 않는다. herdr에 같은 label workspace가 아직 있으면 `detached`, 응답한 서버에 없으면 `exited`다. 서버가 응답하지 않으면(꺼짐·오류) 확인할 수 없으므로 `detached`로 둔다. herdr 서버는 다시 시작하면 label이 붙은 workspace를 복원한다. |
| 다른 클라이언트가 가져감 | attach는 `--takeover`로 붙으므로, 다른 곳에서 같은 터미널을 가져가면 이 앱의 attach가 끝나고 `detached`가 된다. |
| `detached`의 다시 연결 | 탭·세션 상세의 **다시 연결**만이 다시 붙인다. 서버가 꺼져 있으면 서버를 띄운 뒤 label을 다시 찾고, workspace가 있으면 attach, 없으면 `exited`로 바꾸고 오류를 표시한다. 연결이 끊긴 세션에는 입력을 보내지 않고 목록에서 지울 수도 없다. |
| 서버가 꺼진 채 탭 닫기 | workspace를 닫을 수 없으므로 탭을 종료로 확정하지 않고 "herdr 서버가 꺼져 있어 세션을 종료하지 못했어요. 다시 연결한 뒤 종료해주세요." 오류를 표시한다. 서버가 다시 켜지면 workspace가 복원되기 때문이다. |

다시 연결·종료·앱 종료가 동시에 일어나도 늦게 끝난 attach가 이미 종료된 세션을 되살리지 않도록, 비동기 구간 뒤에 종료·정지 상태를 다시 확인한다.

### 환경 경계

- 앱이 herdr 서버를 직접 띄우면 서버는 앱이 거른 환경으로 시작한다. `CLAUDE*`, `CODEX*`, `ELECTRON_*`, `NODE_OPTIONS`, `NODE_INSPECT*`, `REELS_*`, `HERDR_*` 변수는 제거된다(`terminalEnvironment`, `PANE_SCRUBBED_ENV_PREFIXES`).
- 이미 떠 있던 서버(예: Claude Code나 Codex 터미널에서 `herdr`를 실행해 시작된 default 서버)에서 만든 pane은 그 서버의 환경을 따른다. 앱이 이 환경을 바꿀 수 없다.
- **Codex·Claude Code** 세션: workspace를 만든 뒤 명령을 `REELS_WORKBENCH_COMMAND` 환경변수로 넘기고, pane에는 고정된 한 줄을 입력한다. 이 줄은 위 접두사와 일치하는 변수를 모두 unset한 뒤(명령 전달용 변수 포함) `"$SHELL" -c`로 명령을 실행한다. 명령 본문이 입력 줄에 들어가지 않으므로 따옴표·줄바꿈이 그대로 보존된다.
- **shell** 세션: 명령을 입력하지 않으므로 herdr pane의 정상 동작대로 서버 환경을 그대로 쓴다. 따라서 Claude Code 안에서 시작된 herdr 서버를 쓰면 shell 탭에도 `CLAUDECODE` 같은 변수가 보일 수 있다. 피하려면 깨끗한 터미널에서 herdr 서버를 시작하거나 `REELS_HERDR_SESSION`으로 별도 세션을 지정한다.
- 사용자의 default 세션도 대상이 될 수 있다(기본 설정). 앱은 `reels-dashboard:` label이 붙은 workspace만 만들고 닫으며, 개발·QA 검증은 `reels-qa-*` 격리 세션에서 한다.

### 제한

- 실행 줄은 `env`·`sed -E`와 POSIX 계열 셸(zsh, bash, sh)을 전제로 한다. fish는 검증하지 않았다.
- 서버가 꺼진 상태에서는 탭을 닫을 수 없다(위 표). 사용자가 다시 연결한 뒤 닫아야 한다.
- 다시 연결은 필요하면 해당 세션의 herdr 서버를 띄운다. 기본 설정이면 사용자의 default 서버가 될 수 있다.
- `--takeover` 때문에 같은 터미널에 붙어 있던 다른 herdr 클라이언트는 밀려난다.
- 앱이 보관하던 출력 기록은 복원하지 않는다. 직접 실행과 herdr 세션이 섞인 탭은 같은 12개 제한을 공유한다.
- 소스 폴더를 바꾸면 이전 폴더용 herdr workspace는 복원 대상이 아니고 앱이 정리하지도 않는다. 그 폴더를 연결한 채 앱을 다시 시작하면 복원된다.
- `REELS_HERDR_SESSION`을 바꾸면 이전 세션 이름의 workspace는 복원 대상이 아니다. 세션별로 따로 남는다.
- 서버가 이미 띄운 pane의 환경은 앱이 정리할 수 없다(shell 세션 포함, 위 환경 경계).
- 실제 모델에 코딩 작업을 제출하는 검사와 `installed Codex and Claude Code reach an interactive screen`(`REELS_CLI_QA=1`) 검사는 기본 실행에서 건너뛴다.
- 패키징 앱은 만들지 않았고 `brew install`·서비스 설치도 하지 않았다. 검증은 개발 Electron(background QA)에서만 했다.

### 검증 — 2026-11-10

최종 단계에서 처음부터 다시 실행한 결과다(herdr 0.9.5, 설치된 CLI 사용).

| 검사 | 결과 |
| --- | --- |
| `npm run typecheck` | 통과 |
| `npm run check:architecture` | 통과 (테스트 파일 154개 검사) |
| `npm test` | 371개 중 371개 통과, 실패 0. `herdr.test` 12개, `workbench.test` 16개, `workbench-backend-ui` 5개 포함. 실행 줄 테스트는 /bin/zsh, /bin/bash, /bin/sh에서 인자 보존과 변수 제거를 확인한다. |
| `npm run build` | 통과 (chunk 크기 경고만 있음) |
| `npm run test:electron` (`workbench-herdr`·`workbench`·`workbench-mode`·`workbench-tabs`·`ui-inspector`·`desktop` 6개 spec) | 29개 중 27개 통과, 1개 건너뜀, 1개 실패, 2.1분 |

- 건너뜀: `installed Codex reaches an interactive screen`. `REELS_CLI_QA=1`일 때만 실행한다.
- 실패 1건은 이번 범위 밖이다. `desktop.spec.ts:20`이 `window.reels`의 키 목록을 비교하는데, 기대값에 `devBuild`가 없다. 실제 diff는 `Expected - 0 / Received + 1`로 `devBuild` 하나만 더 있다. `devBuild`는 2026-11-03 커밋(`bdd3f48`)에서 preload에 들어왔고 spec 기대값이 갱신되지 않았다. workbench 키는 개발모드에서만 `window.reels.workbench`로 노출되며 이 spec은 개발모드를 켜지 않으므로 이번 변경과 무관하다. 고치지 않았다.
- herdr spec 8개 시나리오 통과: shell 실행·출력 / 앱 재시작 뒤 복원(`cd /` 이후 포함) / 탭 닫기가 자기 workspace만 제거 / 미리보기·검증은 direct / takeover → detached → 다시 연결 / 서버 재시작 → detached → 다시 연결이 서버를 띄워 복원 / 실행 중 백엔드 변경 거부 / `REELS_TERMINAL_BACKEND=direct`. 모두 `reels-qa-*` 격리 세션에서 돌렸다.
- 격리 세션 실험(수정 단계): 서버를 `server stop`한 뒤 다시 띄우면 label이 붙은 workspace가 복원되고, 새 실행 줄을 쓰면 서버 env의 `CLAUDE_*`·`CODEX_*`·`REELS_*`·`NODE_OPTIONS`가 pane 명령에 전달되지 않는다. 느린 환경에서 로그인 zsh가 입력을 읽기까지 19초가 걸린 적이 있어 테스트는 `-42` 출력이 보일 때까지 poll하며 최대 60초 기다린다. 이번 실행에서는 1번 시나리오의 셸 준비가 6.4초였다.
- 종료 후 `herdr session list`에는 사용자의 `default`만 남았고 `reels-qa-*` 세션과 QA attach 프로세스는 없었다.
- 확인하지 못한 것: fish 셸, 느린 환경에서의 Electron 전체 실행, 실제 모델 작업 제출, 패키징 앱.

## 탭 바 단순화와 Claude 열기 — 2026-11-11

패널 머리글의 큰 버튼 줄과 항상 보이던 설명 문구를 없애고 Chrome·iTerm 계열의 **한 줄 탭 바**로 합쳤다. Claude Code도 Codex처럼 열 수 있다.

**구조** — `[탭…][+][▾] ……… [톱니][접기][닫기]`

- 탭: 상태 점(실행 중 초록·연결 끊김 주황·종료 회색) + 제목 + herdr 배지 + 닫기 ×(hover·포커스·선택 시 표시). 가운데 클릭으로도 닫는다. 탭이 많으면 줄바꿈 없이 가로로 스크롤하고 선택한 탭이 보이도록 이동한다. 연결이 끊긴 herdr 탭에는 **다시 연결**이 붙는다.
- **+** = 새 일반 터미널(`⌘T`와 동일). **▾** 메뉴 = 터미널 / Codex 열기 / Claude 열기 / 미리보기 서버 / 검증 실행. 탭이 없을 때의 빈 화면에는 터미널·Codex·Claude 열기 버튼을 크게 둔다.
- **톱니(터미널 설정)** = 소스 연결·운영 브리핑 사이트·세션 유지(herdr/직접)·개선 단계·요청문·코딩 도구 선택·**세션 시작**·**현재 세션용 프롬프트 복사**·실행할 단계 프롬프트. 기본은 접혀 있고, 화면 검사 의견이 요청문에 들어오면 자동으로 펼친다.
- **미리보기 나란히 보기·브라우저에서 열기**는 미리보기 서버가 실행 중일 때 콘솔 아래에 나타난다. 시작은 ▾ 메뉴에서 한다.
- Codex·Claude 열기는 설정의 단계·요청문을 기존 start 계약 그대로 전달한다. 요청문이 비어 있으면 요청 없이 대화형으로 연다.
- 접근성: `tablist`(`터미널 세션`)/`tab`/`tabpanel`, 선택 탭만 tabindex 0, ←→·Home·End로 탭 이동(선택이 따라가고 포커스는 탭에 남는다), Enter·Space·↓는 터미널로 포커스 이동. ▾는 `aria-haspopup="menu"`·`aria-expanded`, 메뉴는 `menu`/`menuitem`이며 ↑↓·Home·End·Esc를 지원한다. 톱니는 `aria-expanded`.
- 선택자: `data-testid` `dev-tabbar`, `dev-new-tab`(aria-label `새 터미널`), `dev-new-menu`(`새 세션 종류 선택`), `dev-start-{shell|codex|claude|preview|checks}`, `dev-empty`, `dev-empty-{id}`, `dev-settings-toggle`(`터미널 설정`), `dev-settings`.

**Claude 실행 인자** — 설치된 CLI(2.1.322)의 `claude --help`는 `--permission-mode <mode>`의 선택지를 `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`으로 안내한다. `default`는 선택지가 아니다. 그래서 설계·리뷰 단계는 `plan`, 구현·수정 단계는 `manual`을 명시해 사용자 설정의 기본 우회 모드를 이어받지 않게 한다. `--dangerously-skip-permissions`는 시작 요청이 `permission: "bypass"`를 넘긴 구현·수정 세션에서만 쓰며 단위 테스트가 명령 문자열을 검사한다.

**검증** — 단위 테스트(Claude 인자·herdr 경로·미지원 종류 거부·탭 키 모델), 개발 Electron(`workbench-tabbar.spec.ts` 신규, 기존 workbench 계열), 웹 `ui-inspector`. 패널 스크린샷은 탭 0·3·12개를 데스크톱 폭과 760px에서 저장한다. 실제 모델에는 작업을 제출하지 않았고 Claude·Codex는 `REELS_CLI_QA=1`에서 초기 화면까지만 확인했다.
