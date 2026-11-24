# 에이전트 작업 흐름: develop → main(라이브)

이 문서가 Claude·Codex 공통 정본이다(`CLAUDE.md`가 불러온다). 저장소 루트의 `AGENTS.md`는 로컬 전용 비공개 지침이라 추적하지 않는다. 리모트 Codex 세션에는 지시문에 이 문서 경로를 적어 넘긴다.

## 브랜치 두 단계

- **develop**: 기본 브랜치. 모든 개발(로컬·리모트 세션)은 develop에서 브랜치를 따고 develop으로 PR·머지한다. develop 머지는 Mac·사이트에 아무것도 반영하지 않는다.
- **main = 라이브**: Mac에서 돌아가는 브리지·autopilot이 실행하는 코드다. `develop → main` PR 머지와 설치는 **로컬 Mac 세션만** 한다. 리모트 세션은 main을 대상으로 PR·머지·push하지 않는다. 같은 GitHub 계정을 쓰므로 기술적으로 막히지 않고 지침으로 지킨다.
- main은 force push·삭제가 막혀 있고 `verify`·`mobile-briefing` 검사를 요구한다. 관리자는 우회할 수 있으니 우회하지 않는다.

## 라이브 폴더 구조

`~/side/reels-live`(`REELS_LIVE_ROOT`):
- `repo.git`: origin의 bare 미러.
- `releases/<sha>/`: 설치한 커밋마다 하나씩 만드는 detached worktree. 그 안에서 빌드하고 이후 편집하지 않는다. 현재·마지막 확인 릴리스와 최근 것까지 3개를 남기고, 하루가 안 됐거나 그 폴더에서 실행 중인 프로세스가 있으면 지우지 않는다.
- `current` → `releases/<sha>`: LaunchAgent가 실행하는 경로. 설치는 이 심링크를 원자적으로 바꾸고, 확인에 실패하면 직전 릴리스로 되돌린다. 어떤 체크아웃도 reset·clean하지 않는다.
- `install.json`: `good`(브리지가 확인한 마지막 릴리스)과 설치 기록(직전 30회). 되돌리기 기준은 `current`가 아니라 `good`이다. `install.lock`: 동시 실행 방지.

개발용 체크아웃(`~/side/reels-dashboard`, worktree들)은 라이브와 분리된다. 거기서 일해도 라이브에 영향이 없다.

## 라이브 반영 (로컬 Mac 세션)

1. `develop → main` PR을 만들고 CI 통과 뒤 merge commit으로 머지한다.
2. **사이트 입력**(`apps/mobile-briefing`, `packages/briefing`)이 바뀌었으면 사이트를 먼저 배포한다. 머지된 main SHA를 체크아웃한 깨끗한 worktree(예: `~/side/reels-live/releases/<sha>`를 먼저 만들려면 `--dry-run` 뒤 빌드)에서 `docs/mobile-briefing.md`「빌드와 배포」대로 내보내고 배포·확인한다. 새 사이트가 아직 이전 브리지의 스냅샷도 받아들이는지 확인한다.
3. `node scripts/live-install.mjs --dry-run`으로 계획을 보고 `node scripts/live-install.mjs [--site-deployed=<SHA>]`로 설치한다(어느 체크아웃에서 실행해도 같다). 사이트 입력이 바뀌었으면 배포한 SHA가 목표와 같아야 진행한다.
   - 하는 일: 잠금 → 미러 fetch → `releases/<sha>` 생성 → `npm ci` → 브리지 단위 검사 → `build:desktop` → `current` 전환 → 브리지 재시작 → 새 프로세스가 목표 SHA로 연결되고, 그 프로세스가 실행 중인 앱에서 새로 만든 스냅샷을 서버가 수락했는지 확인. 앱이 꺼져 있어 캐시 스냅샷만 있으면 실패한다(`--allow-cached`로 허용).
   - 빌드가 실패하면 전환하지 않는다. 확인이 실패하면 직전 릴리스로 되돌리고 브리지를 다시 확인한다. 결과는 `install.json`의 `result`(`installed`·`build_failed`·`restored`·`needs_manual`)다.
   - autopilot은 멈추지 않는다. CLI가 시작할 때 자기 경로를 실제 릴리스 폴더로 고정하므로, 이미 돌고 있는 tick과 그 실행기는 시작한 릴리스로 끝까지 돌고 다음 tick부터 새 릴리스를 쓴다.
4. 출력에 `app inputs CHANGED`가 있으면 앱 재설치까지 해야 라이브 반영이 끝난다. 앱 패키지 위치를 릴리스 폴더로 옮기는 것은 아직 정하지 않았다. 그때까지는 기존 규칙(앱 종료 → `npm run package:mac` → 같은 환경으로 재실행 → MCP 확인)을 main SHA와 같은 깨끗한 체크아웃에서 한다.

## 최초 전환 (1회, 로컬 Mac 세션)

1. `node scripts/live-install.mjs --dry-run` 뒤 `--no-services`로 첫 릴리스를 빌드하고 `current`를 만든다(서비스는 아직 이전 경로를 쓴다).
2. 두 LaunchAgent plist의 경로를 `~/side/reels-live/current/...`로 바꾼다. 브리지는 `WorkingDirectory`와 `bridge.mjs` 경로, autopilot은 `dist-cli/reels.mjs` 경로다. 브리지 plist `EnvironmentVariables`에 릴리스 폴더 밖의 실행 파일 세 개를 절대 경로로 넣는다(설치 스크립트가 존재·실행 가능 여부를 검사한다).
   - `REELS_BRIDGE_KEYCHAIN_HELPER`: 기존 Keychain 도우미. 옮기거나 다시 빌드하면 Keychain 접근을 다시 허락해야 할 수 있어 그대로 둔다.
   - `REELS_PREVIEW_FFMPEG`, `REELS_PREVIEW_FFPROBE`: 저화질 미리보기 런타임(`build:editor` 결과). 릴리스 폴더에는 빌드하지 않는다.
3. `launchctl bootout` 후 `bootstrap`으로 두 에이전트를 다시 올리고 `node scripts/live-install.mjs`를 실행해 브리지 확인까지 통과하는지 본다. 실패하면 plist를 원래 경로로 되돌린다.

## 리모트 세션에 넘길 때

- 지시문에 "`docs/agent-workflow.md`를 먼저 읽고, develop 기반 브랜치에서 작업해 develop으로 PR"을 적는다.
- Mac 전용 검증(Photos, Keychain, LaunchAgent, 서명, 실제 앱·브리지)은 리모트에서 하지 않고 PR 본문에 "Mac 검증 필요"로 남긴다.
- 토큰·Keychain 값·개인 경로·운영 데이터는 지시·커밋·PR에 넣지 않는다. 커밋 전 `npm run audit:public`.
