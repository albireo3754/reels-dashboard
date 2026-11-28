# 에이전트 작업 흐름: develop → main(라이브)

이 문서가 Claude·Codex 공통 정본이다(`CLAUDE.md`가 불러온다). 저장소 루트의 `AGENTS.md`는 로컬 전용 비공개 지침이라 추적하지 않는다. 리모트 Codex 세션에는 지시문에 이 문서 경로를 적어 넘긴다.

## 브랜치 두 단계

- **develop**: 기본 브랜치. 모든 개발(로컬·리모트 세션)은 develop에서 브랜치를 따고 develop으로 PR·머지한다. develop 머지는 Mac·사이트에 아무것도 반영하지 않는다.
- **main = 라이브**: main 폴더(`~/side/reels-dashboard`)에서 앱·브리지·autopilot이 실행하는 코드다. `develop → main` PR 머지와 설치는 **로컬 Mac 세션만** 한다. 리모트 세션은 main을 대상으로 PR·머지·push하지 않는다. 같은 GitHub 계정을 쓰므로 기술적으로 막히지 않고 지침으로 지킨다.
- main은 force push·삭제가 막혀 있고 `verify`·`mobile-briefing` 검사를 요구한다. 관리자는 우회할 수 있으니 우회하지 않는다.

## 폴더 역할 — 2026-11-28 사용자 지시

- **main 폴더 `~/side/reels-dashboard`는 항상 `main`에 둔다.** 실행 앱(`release/mac-arm64/Reels Dashboard.app`), 브리지·autopilot LaunchAgent(`scripts/mobile-briefing/bridge.mjs`, `dist-cli/reels.mjs`), vault `.mcp.json`이 모두 이 폴더를 가리킨다. 이 폴더에서 브랜치를 바꾸거나 개발 커밋을 만들지 않는다.
- **개발·임시 빌드는 worktree에서 한다.** `git worktree add ~/side/worktrees/reels-dashboard-<작업> -b <브랜치> origin/develop`로 따서 작업하고 develop으로 PR한다. 확인용 앱 빌드도 그 worktree에서 한다.
- **LaunchAgent 경로를 옮기지 않는다.** `~/side/reels-live`·`releases/<sha>`·`current` 심링크 구조는 쓰지 않는다(이를 만들던 `scripts/live-install.mjs`는 2026-11-28 삭제)(2026-11-28 사용자: "런치에이전트를 왜 옮기는데 … 항상 메인빌드 해서 쓰는거 기준으로만"). plist 경로 전환을 제안·실행하지 않는다.

## 라이브 반영 (로컬 Mac 세션)

1. `develop → main` PR을 만들고 CI 통과 뒤 merge commit으로 머지한다.
2. main 폴더에서 `git switch main && git pull --ff-only`. 실패하면(로컬 main이 갈라짐 등) 원인을 확인하고, 로컬에만 있던 커밋이 원격 브랜치에 있는지 본 뒤에만 `git reset --hard origin/main`한다.
3. **사이트 입력**(`apps/mobile-briefing`, `packages/briefing`, `scripts/mobile-briefing`)이 바뀌었으면 사이트를 먼저 `docs/mobile-briefing.md`「빌드와 배포」대로 배포하고, 새 사이트가 이전 브리지 스냅샷도 받아들이는지 확인한 뒤 브리지를 재시작한다(`launchctl kickstart -k gui/$(id -u)/com.rosy.reels-mobile-bridge`). 사이트보다 브리지를 먼저 올리지 않는다.
4. main 폴더에서 `npm ci` 뒤 `FFMPEG_BIN`·`FFPROBE_BIN`을 `native/editor-engine/.build/media/bin/ffmpeg|ffprobe`로 주고 `npm run package:mac -- --config.directories.output=release/pending/<이름>`으로 빌드한다.
5. 앱에 저장 안 된 편집·실행 중 작업이 없는지(`reels_get_app_state`) 확인 → 앱 정상 종료 → 기존 `release/mac-arm64`를 `release/backups/mac-arm64-before-<이름>`으로 옮김 → 새 빌드를 `release/mac-arm64/`에 넣음 → `/usr/bin/open -n --env REELS_DEV_MODE=1 "release/mac-arm64/Reels Dashboard.app"` → 4319 MCP·`npm run workflow -- validate-definition`으로 확인한다.

## 리모트 세션에 넘길 때

- 지시문에 "`docs/agent-workflow.md`를 먼저 읽고, develop 기반 브랜치에서 작업해 develop으로 PR"을 적는다.
- Mac 전용 검증(Photos, Keychain, LaunchAgent, 서명, 실제 앱·브리지)은 리모트에서 하지 않고 PR 본문에 "Mac 검증 필요"로 남긴다.
- 토큰·Keychain 값·개인 경로·운영 데이터는 지시·커밋·PR에 넣지 않는다. 커밋 전 `npm run audit:public`.
