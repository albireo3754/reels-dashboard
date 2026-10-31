# 앱 안에서 개발하고 검증하기

현재 진입점은 우측 상단 **터미널** 버튼이다. 콘텐츠 메뉴에 개발 탭을 두지 않는다. [상단 도구와 창 구성](workspace-shell.md)을 따른다.

## 실행

```sh
npm run build
REELS_DEV_MODE=1 npm start
```

`REELS_DEV_MODE`가 정확히 `1`일 때만 개발 작업공간을 켠다. 미설정·`0`·`true`·`false`는 비활성이다. 비활성 상태에서는 Workbench를 초기화하거나 설정을 읽지 않으며, 터미널 IPC와 preload API도 노출하지 않는다. 웹 빌드에는 터미널 기능이 없다.

패키징 앱도 실행 프로세스에 같은 환경변수를 전달하면 사용할 수 있다. 모드를 바꾸려면 실행 중인 앱을 종료하고 다시 실행한다. Finder 일반 실행은 비활성이다. `NODE_ENV`·`VITE_*`로 활성화하지 않는다.

Codex는 설치된 로컬 CLI를 사용한다. 앱을 켜거나 패널을 여는 것만으로 모델에 작업을 제출하지 않는다. Claude Code 실행 어댑터는 보존하되 현재 활성 목록에서 제외하고 직접 시작 요청도 거부한다. 이후 제공자를 활성화할 때는 실행 옵션과 UI·호스트 검증을 함께 수행한다.

## 탭과 단축키

개발 작업공간은 현재 콘텐츠 화면 위에 여는 하단 패널이다. 우측 상단의 **터미널**이나 `⌘N`으로 열어도 기존 편집 화면의 상태를 유지한다. 상단의 **Codex 시작**은 선택한 단계·요청문을 전달하고, **새 터미널**은 일반 셸을 연다. **소스 연결 · 개선 요청 · 코딩 도구**를 펼치면 소스 폴더·단계·요청문을 편집할 수 있다. 헤더와 탭바는 본문을 스크롤해도 유지된다.

| 키 | 동작 |
| --- | --- |
| `⌘N` | 패널 열기 → 접기 → 펼치기 |
| `⌘T` | 연결한 소스 폴더에 새 일반 터미널 탭 열기 |
| `⌘W` | 펼친 패널의 현재 세션 종료 후 탭 제거. 빈 패널은 닫기. 접힌/닫힌 패널이면 창만 숨기기 |
| `⌘1–9` | 패널이 펼쳐져 있으면 세션 탭, 아니면 해당 순서의 사이드바 메뉴 선택 |

탭 전환·접기·패널 닫기는 세션을 유지한다. 탭의 **세션 닫기**는 해당 Codex·셸·미리보기·검증 프로세스를 종료한다. 종료 실패·시간 초과 시 오류를 표시하고 탭을 보존한다. 선택한 탭을 닫으면 오른쪽, 없으면 왼쪽 탭을 선택한다. 최대 12개 세션을 유지하며 10–12번째 탭은 클릭해서 선택한다. 앱 종료는 모든 세션을 종료한다. 숨긴 창은 Dock이나 앱 다시 열기로 복원할 수 있다.

한글 조합 중 키는 처리하지 않고, 키 반복은 새 액션을 만들지 않는다. 키 정의와 표시 힌트는 같은 계약을 사용한다. 터미널·입력창·cross-origin 미리보기에서도 같은 단축키를 사용한다.

## 개발 흐름

1. 설정 영역의 **소스 폴더 연결**에서 Reels Dashboard checkout을 선택한다. 개발 실행은 앱 경로, 패키징 실행은 존재하는 `~/side/reels-dashboard`를 초기 후보로 확인한다. 선택한 경로는 앱 userData의 `workbench.json`에 저장하고 공유 snapshot에서 제외한다.
2. 요청과 완료 기준을 적고 **설계** 또는 **구현** 단계에서 Codex를 시작한다. 로그인과 승인 요청은 터미널에서 처리한다. 같은 파일의 구현·수정은 한 세션이 담당한다.
3. **미리보기 서버 시작** 후 준비 로그를 확인하고 **미리보기 나란히 보기**를 연다. `127.0.0.1:4183/?demo=1`의 예시 데이터이며 웹 변경은 Vite가 반영한다.
4. **검증 실행**은 타입 → FSD → 단위 테스트 → 웹·desktop 빌드 순서다. 실패하면 다음 단계를 실행하지 않는다. 기능별 Electron·Swift·편집 엔진 검사는 터미널에서 추가 실행한다.
5. **리뷰** 단계의 새 세션에 원래 요청과 구현 결과를 전달하고, 지적은 **수정·재검증** 요청에 포함한다. 프롬프트 복사는 입력을 자동 제출하지 않는다.
6. **운영 브리핑 사이트**는 기존 설정의 URL을 시스템 브라우저에서 연다. 배포 작업이 아니다.

단계 전환과 결과 전달은 사용자가 담당한다. 무인 오케스트레이션이나 자동 배포는 포함하지 않는다. Electron main/preload 변경은 다시 빌드하고 앱을 재실행해야 한다. 이 실행 플래그는 Electron HMR이나 자동 재시작 기능이 아니다.

## 구조와 실행 경계

[Workdesk](https://github.com/albireo3754/workdesk/tree/a128734c88a647e6ed07bd9c416b4379295eb7c8)의 호스트 PTY·공통 계약·터미널 탭 경계를 참고해 기존 FSD 구조 안에서 구현했다.

| 위치 | 책임 |
| --- | --- |
| `src/shared/workbench.ts` | 세션·이벤트·bridge와 단계별 프롬프트 |
| `src/shared/workbench-shortcuts.ts` | 단축키 코드·액션·힌트 |
| `src/desktop/development-mode.ts` | 명시적 환경변수 opt-in |
| `src/desktop/workbench-providers.ts` | 기본/활성 제공자와 실행 인자 |
| `src/desktop/workbench.ts` | 소스 검증·설정 저장·PTY 생명주기 |
| `src/desktop/main.ts` / `preload.ts` | 신뢰한 상위 프레임의 제한된 IPC·단축키 전달 |
| `src/features/dev-workspace` | 패널/선택 상태·고정 xterm 인스턴스·미리보기 |
| `src/renderer/App.tsx` | 콘텐츠 화면과 패널 조합 |

- Codex 설계·리뷰는 `read-only`, 구현·수정은 `workspace-write`, 승인은 `on-request`를 사용한다. 권한 우회 플래그를 추가하지 않는다.
- 일반 셸과 npm 명령은 사용자 권한으로 실행한다. 소스 선택이 운영체제 sandbox를 뜻하지는 않는다. 요청문은 셸 단일 인자로 인코딩하고 제어문자를 거부한다.
- 실행 중 세션이 있으면 소스 변경을 거부하고 미리보기·검증의 중복 실행을 막는다.
- 접기·탭 전환 시 xterm을 재생성하지 않는다. 비활성 터미널은 blur하고 입력·resize를 전달하지 않는다. 재연결 시 이벤트 구독과 출력 sequence로 backlog 중복/누락을 막는다.
- `before-input-event`에서 개발 단축키만 처리하고 상위 renderer에 전달한다. 기존 DOM 키 리스너와 이중 실행하지 않으며, 미리보기 iframe에 desktop bridge를 노출하지 않는다. 터미널 API는 MCP나 공유 웹에 추가하지 않는다.
- 세션당 최근 256 KiB 출력을 메모리에 유지한다. tmux·앱 재시작 후 세션 복원·사용자별 YAML 단축키 설정은 포함하지 않는다.

## 검증

```sh
npm run typecheck
npm run check:architecture
npm test
npm run build
npm run test:electron -- tests/electron/workbench-mode.spec.ts tests/electron/workbench-tabs.spec.ts tests/electron/workbench.spec.ts
# 설치된 Codex의 초기 화면까지만 검사
REELS_CLI_QA=1 npm run test:electron -- tests/electron/workbench.spec.ts --grep 'installed Codex'
```

Electron QA는 임시 프로필과 숨긴 비활성 창을 사용한다. `REELS_ELECTRON_HEADED=1`은 창 표시가 명시적으로 필요한 수동 검사에서만 사용한다. 단축키 검사는 Electron native 입력을 통과하는 `webContents.sendInputEvent`로 실행한다. 숨긴 창의 CDP 키 입력이 native hook을 건너뛰는 것은 별도 관찰로 확인했다.

독립 리뷰에서 iframe 포커스의 단축키 누락을 발견하고 실제 검사로 재현한 뒤 호스트 입력 처리로 수정했다. 통합 checkout에서 개발 Electron13개와 패키징 탭4개가 통과했고, 데스크톱/760px에서 탭바·본문 스크롤·접힘을 확인했다. Codex 검사는 초기 화면까지만 확인하며 모델에 실제 코드 수정 작업을 제출하지 않는다. 관련 변경만 분리한 PR checkout에서도 타입·FSD·명세 보존·단위28개·빌드·Electron13개·공개 소스 검사를 통과했다.
