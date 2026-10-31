# PhotosIndex 이관 워크플로우

이 워크플로우의 완료 범위는 **PhotosIndex 전체 기능을 제공하는 Electron·React 앱**, Sites와 공유할 수 있는 웹 화면·데이터 경계, 원본 테스트의 보존, 웹 렌더러 테스트, 별도 Electron QA, 요청한 공개 GitHub 저장소의 검증이에요. 기존 PhotosIndex 설치에 연결되는 데모만으로 완료하지 않아요.

## 실행 순서와 소유권

| 단계 | 담당·수정 범위 | 다음 단계로 넘어갈 근거 |
| --- | --- | --- |
| 명세 | 테스트 담당: `docs/photosindex-test-spec.md`, `docs/photosindex-test-inventory.json`; UI 담당: `docs/photosindex-ui-spec.md` | 원본의 모든 테스트 함수·실제 UI·CLI 동작을 대조한 명세 감사 |
| 저장소 | 통합 담당: 루트 설정, `src/shared/`, 라이선스, ignore 규칙 | 독립 Git 루트, 공통 adapter 계약, 테스트·빌드 명령 확정 |
| 네이티브 이관 | native 담당: `native/photosindex/`, `scripts/build-native.mjs` | Swift 전체 테스트 통과, 기존 기능·안전 조건·CLI 보존 |
| Electron 연결 | desktop 담당: `src/desktop/`, `scripts/build-desktop.mjs`, desktop 단위 테스트 | 제한된 IPC, 번들 helper 실행, 전 명령 연결, 영속 상태 |
| 공통 화면 | React 담당: `src/renderer/`, renderer 단위 테스트 | PhotosIndex 전 기능 UI, 모바일 레이아웃, 명시적인 웹 읽기 전용 경계 |
| 통합 | 통합 담당: 교차 경계 수정, 빌드·배포 설정 | 타입 검사·단위 테스트·빌드, 기능별 acceptance matrix |
| 웹 QA | 별도 담당: `tests/web/`, `playwright.web.config.ts`, `docs/web-qa.md` | 실제 웹 렌더러에서 사용자 흐름과 실패 상태 검증 |
| Electron QA | 별도 담당: `tests/electron/`, `playwright.electron.config.ts`, `docs/electron-qa.md` | 실제 Electron 실행, preload/IPC, helper, 재시작·패키징 확인 |
| 완료 감사 | 통합 담당 후 독립 읽기 전용 감사 | 모든 요구사항의 현재 증거, 실제 검증 명령 성공, 미해결 필수 항목 없음 |
| 공개 | 단일 배포 담당만 수행 | 공개 파일 검사, 정확한 원격 저장소, 로컬·원격 commit 일치, PUBLIC 상태 |

병렬 담당자는 자신의 파일만 수정해요. 공통 타입은 병렬 구현 전에 정하고, 필요한 변경은 통합 담당자에게 전달해요. QA는 제품 코드를 임의로 바꾸거나 실패 테스트를 제거하지 않고 재현 결과를 전달해요. 통합 수정 후 관련 QA를 다시 실행해요.

## 범위와 검증 기준

- 상태·권한, 날짜 색인, coarse/fine 그룹, 상세 메타데이터, 페이지별 미리보기·OCR·얼굴 감지·민감 텍스트 처리, 완전한 include/exclude 판단, 복사 내보내기, 검증된 이동과 복구를 모두 포함해요.
- Swift의 기존 테스트를 전부 보존해요. 빈 모듈 확인 테스트와 실제 행동 테스트를 구분하고, 함수별 명세에서 새 구현과 검증으로 연결해요.
- Swift helper·CLI는 배포 앱에 포함해요. 예전 앱 설치·개발자 소스 경로·전역 CLI에 의존하는 상태는 대체 완료가 아니에요.
- React는 adapter를 통해 기능을 호출해요. Sites/웹 모드에서 로컬 Photos 접근이 가능한 것처럼 표시하지 않아요. 공유 데이터는 선택한 요약으로 제한하고 원본 파일·Photos 내부 ID·정밀 위치·로컬 경로를 제외해요.
- 웹 테스트는 fixture를 사용하는 것을 표시하고 상태 변화·사용자 입력·오류·페이지 이동·반응형 화면을 검증해요. 스크린샷만으로 동작을 증명하지 않아요.
- Electron QA는 실제 프로세스를 실행해요. 합성 데이터 기반 전 흐름과 실제 번들 helper의 상태·프로토콜 검사를 구분해요. PhotoKit 접근 허용과 실사진 처리까지 검증하지 않았다면 그 범위는 별도로 남겨요.
- 삭제가 포함되는 이동 흐름은 격리된 fixture로 검증해요. QA를 위해 실제 사진을 삭제하거나 macOS 권한을 초기화하지 않아요.
- 기존 원본 PhotosIndex 프로젝트는 읽기 전용으로 취급해요. 이관을 위해 원본 프로젝트나 사진 보관함을 변경하지 않아요.
- 이번 이관에 전체 영상 편집기 신규 개발을 끼워 넣지 않아요. 향후 Python·FFmpeg 연결에 사용할 구조를 유지하되, 현재 PhotosIndex 대체 기능을 축소하지 않아요.

## 재실행

[`workflows/photosindex-migration.mjs`](../workflows/photosindex-migration.mjs)는 Codex Dynamic Workflow 런타임의 `phase`, `parallel`, `agent` API를 사용해요. 런타임은 별도로 설치되어 있어야 해요. 소스와 런타임의 경로는 실행 환경에서 지정하며 저장소에 개인 경로를 기록하지 않아요.

```sh
export WORKFLOW_RUNTIME=/path/to/codex-dynamic-workflow.mjs
export PHOTOSINDEX_SOURCE=/path/to/original/photosindex-macos

# 계획·분담 구조만 확인해요. 실제 agent와 검사·공개는 실행하지 않아요.
node "$WORKFLOW_RUNTIME" --dry-run --cwd "$PWD" \
  --runs-dir /tmp/reels-dashboard-workflow-runs \
  workflows/photosindex-migration.mjs -- \
  --source "$PHOTOSINDEX_SOURCE"

# 로컬 이관·테스트·감사까지 실행해요.
node "$WORKFLOW_RUNTIME" --cwd "$PWD" \
  --runs-dir /tmp/reels-dashboard-workflow-runs \
  workflows/photosindex-migration.mjs -- \
  --source "$PHOTOSINDEX_SOURCE"

# 사용자가 공개를 지시한 저장소에만 --publish를 명시해요.
node "$WORKFLOW_RUNTIME" --cwd "$PWD" \
  --runs-dir /tmp/reels-dashboard-workflow-runs \
  workflows/photosindex-migration.mjs -- \
  --source "$PHOTOSINDEX_SOURCE" --repo OWNER/REPOSITORY --publish
```

`--publish`는 공개 동작을 선택하는 실행 옵션이며 사용자 승인 자체를 대신하지 않아요. 이 프로젝트의 최초 공개는 사용자가 명시적으로 요청했어요. 향후 다른 저장소·다른 공개 범위에는 해당 실행의 승인 범위를 적용해요. 병렬 작업자는 commit·push·배포하지 않으며 마지막 담당자만 검증한 파일을 공개해요.

런타임의 `--run-id`는 같은 프롬프트 결과를 재사용할 수 있어요. 코드나 요구사항이 바뀐 뒤에는 새 run ID를 쓰세요. 최종 검증 명령은 캐시된 agent 응답과 별도로 실행하지만, QA 감사 결과 자체가 오래된 상태를 가리키지 않도록 해야 해요. 실행 로그에는 로컬 경로가 들어갈 수 있으므로 공개 저장소 밖이나 ignored 경로에 보관해요.

## 실제 완료 게이트

워크플로우는 QA와 수정 뒤 아래 명령을 직접 실행하고 종료 코드·시각·로그를 기록해요. 명령이 없거나 실패하면 중단해요. dry-run은 이 명령들을 실행하지 않으며 실제 검증 결과로 취급하지 않아요.

```sh
swift test --package-path native/photosindex
npm run typecheck
npm test
npm run build
npm run test:web
npm run test:electron
npm run package:mac
npm run audit:public
```

테스트 통과만으로 전체 완료를 선언하지 않아요. `docs/acceptance-matrix.md`에 명세 항목별 구현·테스트·수동 확인 결과를 연결하고, `docs/release-audit.md`에 실제 검증 범위와 남은 항목을 기록해요. 필요한 동작이 mock에서만 성공하거나 패키징 앱의 helper·권한 동작이 확인되지 않았다면 해당 항목은 완료가 아니에요.

공개 단계에서는 저장소 루트가 현재 프로젝트인지, 검토한 commit과 원격 commit이 일치하는지, GitHub에서 PUBLIC으로 보이는지 확인해요. 공개 URL이나 성공 메시지 하나만으로 모든 기능·테스트·배포가 완료됐다고 판단하지 않아요.

## 네이티브 재빌드·설치 회귀 게이트

`test:native-rebuild`와 `test:native-install`도 완료 검사에 포함해요. 실행 중인 helper의 응답·PID를 유지한 채 서명된 파일을 교체하고 새 CLI를 실행하며, 임시 한글·공백 설치 경로에서 실제 production NativeClient의 종료를 확인해요. 디스크의 codesign 검사만으로 실행 가능성을 판정하지 않아요. 테스트용 임시 설치를 사용하고 실제 사용자 설치를 변경하지 않아요. 로컬 QA도 Developer ID Application 서명을 사용해요. 인증서가 없는 CI에서만 `CI=true PHOTOSINDEX_SIGNING_MODE=ci-adhoc`를 지정해요.
