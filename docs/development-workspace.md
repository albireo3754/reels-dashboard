# 앱 안에서 개발하고 검증하기

현재 진입점은 우측 상단 **터미널** 버튼이다. 콘텐츠 메뉴에 개발 탭을 두지 않는다. [상단 도구와 창 구성](workspace-shell.md)을 따른다.

2026-10-31. 우측 상단의 **터미널**에서 앱 소스와 Codex, 일반 터미널, 로컬 웹 미리보기, 기존 운영 브리핑 사이트를 연결한다. 설치된 Codex CLI를 사용하는 로컬 기능이며 새 API 키나 호스팅 서비스는 만들지 않는다. Claude Code는 추후 선택을 위한 실행 어댑터만 보존하며 현재 선택하거나 시작할 수 없다.

## 로컬 개발모드 실행

소스 checkout에서 빌드한 뒤 환경변수를 지정해 실행한다.

```sh
npm run build
REELS_DEV_MODE=1 npm start
```

`REELS_DEV_MODE`가 정확히 `1`일 때만 개발 작업공간을 활성화한다. 미설정·`0`·`false`·`true`는 모두 비활성이다. 일반 실행에서는 메뉴와 preload의 터미널 API가 없고 main의 터미널 IPC도 등록하지 않으며, 작업공간 설정을 읽거나 PTY 관리자를 만들지 않는다. `NODE_ENV`나 웹의 `VITE_*` 설정으로 활성화되지 않는다.

패키징 앱도 실행 프로세스에 같은 환경변수를 전달하면 사용할 수 있다. 이미 실행 중인 앱은 시작할 때의 설정을 유지하므로 다른 모드로 바꾸려면 앱을 종료하고 다시 실행한다. Finder에서 일반 실행하면 기본 비활성이다.

Codex가 기본 도구이며 **세션 시작**을 눌렀을 때 선택한 소스 폴더에서 실행한다. 앱 실행만으로 코딩 작업을 자동 제출하지 않는다. 일반 터미널에서도 같은 소스 폴더를 바로 수정할 수 있다. 웹 UI 변경은 미리보기 서버를 통해 확인하고, Electron main·preload 변경은 다시 빌드하고 재실행한다. 이 플래그가 Electron 자동 재시작이나 HMR 런처를 제공하는 것은 아니다.

## 작업공간 탭과 단축키

개발 작업공간은 현재 콘텐츠 화면 위에 여는 하단 패널이다. 우측 상단의 **터미널**이나 `⌘N`으로 열어도 기존 영상·카드뉴스 편집 화면의 상태를 유지한다. 상단의 **Codex 시작**으로 선택한 단계·요청문을 전달하고, **새 터미널**로 일반 셸을 연다. **소스 연결 · 개선 요청 · 코딩 도구**를 펼치면 기존 설정과 요청문을 편집할 수 있다. 탭바는 설정 영역을 스크롤해도 상단에 유지된다. 단축키는 개발모드에서만 동작한다.

| 키 | 동작 |
| --- | --- |
| `⌘N` | 개발 작업공간 열기 → 접기 → 펼치기 |
| `⌘T` | 연결한 소스 폴더에 새 일반 터미널 탭을 열고 선택 |
| `⌘W` | 패널이 펼쳐져 있으면 현재 세션 종료 후 탭 제거. 빈 패널은 닫기. 패널이 접혀 있거나 닫혀 있으면 앱 창 숨기기 |
| `⌘1–9` | 패널이 펼쳐져 있으면 해당 순서의 세션 탭, 아니면 사이드바의 해당 메뉴 선택 |

탭 전환·패널 접기는 터미널과 프로세스를 유지한다. 패널의 **닫기**도 패널만 숨기며, 탭의 **세션 닫기**는 실행 중인 Codex·셸·미리보기·검증 프로세스를 종료한다. Workdesk의 tmux 세션과 달리 Codex 탭 닫기가 단순 detach는 아니다. 종료에 실패하면 오류를 표시하고 탭을 유지한다. 앱 종료 시 모든 세션을 종료하는 기존 동작은 유지한다.

닫은 탭이 선택된 탭이면 오른쪽 탭, 오른쪽이 없으면 왼쪽 탭을 선택한다. 기존 최대 12개 세션 제한을 유지하며 10–12번째 탭은 클릭해서 선택한다. 한글 조합 중 키는 처리하지 않고, 키를 누르고 있어도 새 탭이 반복 생성되지 않는다. 도구 선택·단계·요청문·소스 폴더는 기존 개발 작업 흐름을 사용한다. 사용자별 YAML 단축키 설정과 Workdesk의 업무 메뉴·tmux는 이식 범위에 포함하지 않는다.

## 구조 선택

[Workdesk](https://github.com/albireo3754/workdesk/tree/a128734c88a647e6ed07bd9c416b4379295eb7c8)의 `backend/terminal.ts`, `shared/api.ts`, 터미널 entity, Claude session feature를 확인했다. 소스 파일을 복사하지 않고 **호스트의 프로세스 관리 / 프로세스 간 계약 / 화면의 세션 표시** 경계를 참고했다. 기존 Reels Dashboard FSD 계층과 MCP·편집 서비스는 유지한다.

| 위치 | 책임 |
| --- | --- |
| `src/shared/workbench.ts` | 도구·단계·세션·이벤트 계약, 단계별 요청문 |
| `src/shared/workbench-shortcuts.ts` | 단축키 물리 코드·액션·힌트의 공통 정의 |
| `src/desktop/development-mode.ts` | 정확한 환경변수 opt-in 판정과 preload capability 이름 |
| `src/desktop/workbench-providers.ts` | Codex 기본값, 활성 도구 목록과 코딩 도구별 실행 인자 |
| `src/desktop/workbench.ts` | Electron에 의존하지 않는 PTY 관리자, 소스 검증·설정 저장·프로세스 생명주기 |
| `src/desktop/main.ts` | 개발모드에서만 관리자·IPC·키 입력 활성화, 상위 renderer로 단축키 전달, 신뢰한 main frame 검사 |
| `src/desktop/preload.ts` | main이 전달한 capability에 따라 typed WorkbenchBridge 노출 |
| `src/features/dev-workspace` | 패널·탭 상태, 호스트 단축키 구독, 단계·도구 선택, xterm 입출력, 격리된 웹 미리보기 |
| `src/renderer/App.tsx` | desktop bridge가 있을 때만 개발 메뉴 조합; 별도 chunk 로딩 |

터미널은 main 프로세스가 소유한다. 화면을 바꾸거나 세션을 전환해도 프로세스는 유지된다. 재연결 시 구독을 먼저 시작하고 출력 sequence 이후의 이벤트만 적용해 backlog 중복·누락을 막는다. 세션당 최근 256 KiB의 출력을 메모리에 보관하며, 종료 세션을 포함해 최대 12개까지 유지한다. 앱을 종료하면 프로세스도 종료한다. Workdesk의 tmux 영속 세션이나 앱 밖의 기존 대화 연결은 이번 구현에 포함하지 않는다.

## 사용 순서

1. **소스 연결 · 개선 요청 · 코딩 도구**를 펼친 뒤 **소스 폴더 연결**에서 이 저장소를 선택한다. 개발 실행은 현재 앱 경로, 패키징 실행은 존재하는 `~/side/reels-dashboard`를 초기 후보로 확인한다. 직접 선택한 경로는 앱 userData의 `workbench.json`에 저장된다. 이 파일은 공유 snapshot과 분리된다.
2. 요청과 완료 기준을 적고 **설계** 또는 **구현** 단계에서 기본 도구인 **Codex**로 시작한다. 로그인이 필요하면 터미널의 안내를 따른다. 같은 소스의 구현·수정은 한 세션이 담당하도록 한다.
3. **미리보기 서버 시작**의 준비 완료 로그를 확인하고 **미리보기 나란히 보기**를 누른다. `127.0.0.1:4183/?demo=1`의 예시 데이터 화면이며 Vite가 웹 변경을 반영한다. 실제 제작 데이터 화면으로 오해하지 않는다.
4. **검증 실행**은 타입 검사 → FSD 구조 검사 → 단위 테스트 → 웹·desktop 빌드를 순서대로 실행한다. 한 단계가 실패하면 뒤 단계는 실행하지 않고 실제 종료 코드를 표시한다. 기능별 Electron·Swift·편집 엔진 검사는 일반 터미널에서 추가 실행한다.
5. **리뷰**를 선택하고 원래 요청과 구현 결과를 붙여넣어 새 Codex 세션을 시작한다. 지적을 **수정·재검증** 요청에 포함해 기존 구현 세션에 전달한다. **현재 세션용 프롬프트 복사**는 붙여넣을 요청문만 만들며 입력을 자동 제출하지 않는다.
6. 운영 화면은 **운영 브리핑 사이트**로 연다. 기존 모바일 브리핑 연결의 URL·로그인·자동 동기화를 그대로 사용한다. 이 버튼은 배포하지 않는다.

단계 이동과 결과 전달은 사용자가 조절한다. 무인으로 다른 에이전트에게 결과를 넘기거나 자동 배포하는 루프는 아니다. Electron main/preload 변경은 빌드만으로 실행 앱에 반영되지 않으므로 새 앱을 별도로 실행해 확인한다.

## 실행 경계

- Codex는 설계·리뷰에 `read-only`, 구현·수정에 `workspace-write`, 승인 정책은 `on-request`를 지정한다. [공식 승인·보안 문서](https://learn.chatgpt.com/docs/agent-approvals-security)와 설치된 CLI 도움말을 확인했다.
- Claude Code의 기존 실행 어댑터는 보존하지만 현재 활성 도구 목록에 포함하지 않는다. 직접 IPC로 시작을 요청해도 호스트에서 거부한다. 이후 지원 시 도구 목록과 어댑터를 함께 검증한다.
- 일반 터미널과 npm 검사는 사용자 권한의 로컬 셸이다. 작업 폴더 선택은 운영체제 sandbox가 아니다. 입력은 현재 세션에 전달하고 알 수 없는 세션·도구·비정상 크기는 거부한다. 요청문은 셸의 단일 인자로 인코딩한다.
- 실행 중인 세션이 있으면 소스 변경을 거부한다. 미리보기·검증 작업의 중복 실행도 거부한다. 설정이 손상되거나 소스가 이동했으면 다시 연결한다.
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
- 실제 모델에 코딩 작업을 제출하지 않았다. tmux·앱 재시작 후 터미널 복원·사용자 지정 단축키 설정은 추가하지 않았다.

패키징 검증 후, 프로젝트 정리 작업이 저장된 현재 앱(`release/production-projects/mac-arm64/Reels Dashboard.app`)을 정상 종료하고 같은 경로에 새 빌드를 넣었다. 이전 앱은 `release/production-projects-before-workspace-tabs/mac-arm64/Reels Dashboard.app`에 보존했다. 기존 사용자 프로필로 `REELS_DEV_MODE=1`을 전달해 실행하고, 실제 화면에서 새 패널·Codex 시작 버튼과 `⌘N` 접기/펼치기를 확인했다. 콘텐츠 저장소를 교체하거나 병합 결과를 되돌리지 않았다.
