# 앱 안에서 개발하고 검증하기

2026-10-28. 사이드바의 **개발 작업공간**에서 앱 소스와 코딩 도구, 로컬 웹 미리보기, 기존 운영 브리핑 사이트를 연결한다. 설치된 Codex CLI와 Claude Code를 사용하는 로컬 기능이며 새 API 키나 호스팅 서비스는 만들지 않는다.

## 구조 선택

[Workdesk](https://github.com/albireo3754/workdesk/tree/a128734c88a647e6ed07bd9c416b4379295eb7c8)의 `backend/terminal.ts`, `shared/api.ts`, 터미널 entity, Claude session feature를 확인했다. 소스 파일을 복사하지 않고 **호스트의 프로세스 관리 / 프로세스 간 계약 / 화면의 세션 표시** 경계를 참고했다. 기존 Reels Dashboard FSD 계층과 MCP·편집 서비스는 유지한다.

| 위치 | 책임 |
| --- | --- |
| `src/shared/workbench.ts` | 도구·단계·세션·이벤트 계약, 단계별 요청문 |
| `src/desktop/workbench.ts` | Electron에 의존하지 않는 PTY 관리자, 소스 검증·설정 저장·프로세스 생명주기 |
| `src/desktop/main.ts` | 폴더 선택·고정 URL 열기·신뢰한 main frame의 IPC만 연결 |
| `src/desktop/preload.ts` | typed WorkbenchBridge, 제한된 명령과 이벤트 구독 |
| `src/features/dev-workspace` | 단계 선택, 도구 선택, 세션 목록, xterm 입출력, 격리된 웹 미리보기 |
| `src/renderer/App.tsx` | desktop bridge가 있을 때만 개발 메뉴 조합; 별도 chunk 로딩 |

터미널은 main 프로세스가 소유한다. 화면을 바꾸거나 세션을 전환해도 프로세스는 유지된다. 재연결 시 구독을 먼저 시작하고 출력 sequence 이후의 이벤트만 적용해 backlog 중복·누락을 막는다. 세션당 최근 256 KiB의 출력을 메모리에 보관하며, 종료 세션을 포함해 최대 12개까지 유지한다. 앱을 종료하면 프로세스도 종료한다. Workdesk의 tmux 영속 세션이나 앱 밖의 기존 대화 연결은 이번 구현에 포함하지 않는다.

## 사용 순서

1. **소스 폴더 연결**에서 이 저장소를 선택한다. 개발 실행은 현재 앱 경로, 패키징 실행은 존재하는 `~/side/reels-dashboard`를 초기 후보로 확인한다. 직접 선택한 경로는 앱 userData의 `workbench.json`에 저장된다. 이 파일은 공유 snapshot과 분리된다.
2. 요청과 완료 기준을 적고 **설계** 또는 **구현** 단계, **Codex / Claude Code**를 선택해 시작한다. 로그인이 필요하면 터미널의 안내를 따른다. 같은 소스의 구현·수정은 한 세션이 담당하도록 한다.
3. **미리보기 서버 시작**의 준비 완료 로그를 확인하고 **미리보기 나란히 보기**를 누른다. `127.0.0.1:4183/?demo=1`의 예시 데이터 화면이며 Vite가 웹 변경을 반영한다. 실제 제작 데이터 화면으로 오해하지 않는다.
4. **검증 실행**은 타입 검사 → FSD 구조 검사 → 단위 테스트 → 웹·desktop 빌드를 순서대로 실행한다. 한 단계가 실패하면 뒤 단계는 실행하지 않고 실제 종료 코드를 표시한다. 기능별 Electron·Swift·편집 엔진 검사는 일반 터미널에서 추가 실행한다.
5. **리뷰**를 선택하고 원래 요청과 구현 결과를 붙여넣어 새 세션을 시작한다. 다른 코딩 도구로 전환해 리뷰할 수 있다. 지적을 **수정·재검증** 요청에 포함해 기존 구현 세션에 전달한다. **현재 세션용 프롬프트 복사**는 붙여넣을 요청문만 만들며 입력을 자동 제출하지 않는다.
6. 운영 화면은 **운영 브리핑 사이트**로 연다. 기존 모바일 브리핑 연결의 URL·로그인·자동 동기화를 그대로 사용한다. 이 버튼은 배포하지 않는다.

단계 이동과 결과 전달은 사용자가 조절한다. 무인으로 다른 에이전트에게 결과를 넘기거나 자동 배포하는 루프는 아니다. Electron main/preload 변경은 빌드만으로 실행 앱에 반영되지 않으므로 새 앱을 별도로 실행해 확인한다.

## 실행 경계

- Codex는 설계·리뷰에 `read-only`, 구현·수정에 `workspace-write`, 승인 정책은 `on-request`를 지정한다. [공식 승인·보안 문서](https://learn.chatgpt.com/docs/agent-approvals-security)와 설치된 CLI 도움말을 확인했다.
- Claude Code는 설계·리뷰에 `plan`, 구현·수정에 `manual`을 사용한다. 설치된 CLI가 해당 옵션을 지원하는 것을 확인했다. 권한 우회 옵션을 추가하지 않는다.
- 일반 터미널과 npm 검사는 사용자 권한의 로컬 셸이다. 작업 폴더 선택은 운영체제 sandbox가 아니다. 입력은 현재 세션에 전달하고 알 수 없는 세션·도구·비정상 크기는 거부한다. 요청문은 셸의 단일 인자로 인코딩한다.
- 실행 중인 세션이 있으면 소스 변경을 거부한다. 미리보기·검증 작업의 중복 실행도 거부한다. 설정이 손상되거나 소스가 이동했으면 다시 연결한다.
- 미리보기 iframe에는 preload/Node/desktop bridge가 없다. 외부 운영 사이트는 시스템 브라우저에서 열고 CLI 인증정보를 웹에 전달하지 않는다. 터미널은 기존 MCP나 공유 웹 API에 노출하지 않는다.
- macOS 앱은 node-pty의 네이티브 모듈을 외부 의존성으로 유지하고 asar에서 풀어 패키징한다. 빌드 단계에서 spawn-helper 실행 권한을 준비한다. xterm은 웹 기본 bundle과 분리한다.

## 리뷰·검증 기록

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
node --import tsx --test tests/unit/workbench.test.ts
npm run test:electron -- tests/electron/workbench.spec.ts
# 로컬에 두 CLI가 설치되어 있을 때만 초기 화면 확인 추가
REELS_CLI_QA=1 npm run test:electron -- tests/electron/workbench.spec.ts
```
