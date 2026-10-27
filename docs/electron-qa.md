# Electron QA

Electron QA는 공통 React 화면의 웹 테스트와 별도로 실행해요. fixture 테스트와 실제 native helper 테스트를 구분하며, fixture 성공을 Photos 권한·실제 라이브러리 접근의 증거로 사용하지 않아요.

## 재현 명령

```sh
npm run build
npm run test:electron
```

기본 실행은 `REELS_DEMO=1`을 지정한 실제 Electron 앱을 사용해요. 테스트마다 임시 user-data 디렉터리를 만들고 종료 후 정리해요. renderer가 dev server 대신 빌드된 `dist`에서 로드되는지도 확인해요.

```sh
npm run build:native
REELS_NATIVE_QA=1 npm run test:electron -- tests/electron/native.spec.ts
```

native 테스트는 이 빌드에 포함된 실행 파일의 실제 프로세스 경로를 확인해요. 기존에 설치된 PhotosIndex 앱이 응답했다는 이유로 성공 처리하지 않아요. 실제 Photos 데이터에서는 상태 조회와 `1900-01-01` 날짜의 read-only 색인·그룹 조회만 수행해요. 원본 내보내기·이동·삭제는 수행하지 않아요.

패키징된 앱은 다음처럼 같은 테스트를 재사용해요.

```sh
REELS_ELECTRON_EXECUTABLE="$PWD/release/mac-arm64/Reels Dashboard.app/Contents/MacOS/Reels Dashboard" npm run test:electron -- tests/electron/desktop.spec.ts
REELS_ELECTRON_EXECUTABLE="$PWD/release/mac-arm64/Reels Dashboard.app/Contents/MacOS/Reels Dashboard" REELS_NATIVE_QA=1 npm run test:electron -- tests/electron/native.spec.ts
```

## 자동 검증 항목

| 범위 | 증거 |
| --- | --- |
| 실제 Electron 창 | Playwright `_electron.launch` 후 built React 화면과 fixture screenshot |
| renderer 격리 | `nodeIntegration=false`, `contextIsolation=true`, `sandbox=true`, `window.require` 부재 |
| preload API | `window.reels`에 공통 계약의 제한된 API만 노출 |
| IPC 입력 경계 | 임의 command, 문서 경로 traversal, 절대 파일명, 임의 로컬 이미지 경로 거부 |
| 저장 | 같은 임시 user data로 앱을 재시작한 후 dashboard 보존 |
| fixture IPC | status → sync → groups.list/show → groups.inspect가 실제 preload/main IPC를 통과 |
| 복사·이동 IPC | 전체 11개 명령 연결, 잘못된 digest 거부, move 확인 취소·승인 흐름 |
| 문서·snapshot | 한글 JSON 문서 선택·읽기, native 저장 dialog, 공유 항목만 snapshot에 포함 |
| 실제 native | protocol/권한 확인, 현재 빌드 helper 프로세스 경로 확인, 권한이 있으면 빈 날짜 조회 |
| helper 수명 | 실패한 명령 후에도 앱 종료 시 소유한 helper PID와 identity 파일 제거 |
| 권한 거부 상태 | 권한이 없으면 sync 실패를 확인하고 실데이터 접근은 미검증으로 표시 |

## 증거 해석

- `artifacts/electron-development/`와 `artifacts/electron-packaged/`에 테스트별 screenshot, native origin JSON, HTML·JSON 리포트를 나누어 남겨요. 공개 저장소에는 실행 산출물과 개인 라이브러리 자료를 올리지 않아요.
- native origin 첨부는 해당 빌드 사용 여부·packaged 여부·protocol·권한 상태만 기록해요. 개인 절대경로와 자산 정보는 포함하지 않아요.
- 실제 원본 삭제 검증은 일반 QA에서 실행하지 않아요. 이동의 hash·업로드·삭제 대상·재개 계약은 이관된 Swift 테스트와 synthetic UI/IPC 시나리오로 검증해요.
- 권한이 없는 실행에서도 연결 테스트는 통과할 수 있어요. 이때 annotation과 이 문서의 실행 기록에서 실제 Photos 접근이 미검증임을 명시해야 해요.

## 실행 기록

2026-10-27 개발 빌드 확인:

- `npm run build` 성공.
- `npm run test:electron -- tests/electron/desktop.spec.ts`: **5/5 통과**. 실제 Electron에서 격리 설정·경로/명령 거부·재시작 저장·전체 11개 명령의 fixture 흐름을 확인했어요.
- `REELS_NATIVE_QA=1 npm run test:electron -- tests/electron/native.spec.ts`: **1/1 통과**. 이 빌드의 helper executable·PID·isolated socket과 앱 종료 후 PID·identity 파일 정리를 확인했어요.
- native 권한은 `not-determined`였어요. 권한 없는 sync가 거부되는 동작은 확인했지만, 실제 Photos 자산의 색인·미리보기·복사·이동은 이 실행에서 검증하지 않았어요.
- 첫 fixture 실행은 개발 중간 빌드의 `dispose` 미포함으로 종료 hook에서 실패했어요. 완성된 NativeClient를 다시 빌드한 뒤 정상 종료까지 확인했어요. 또한 명령 실패가 readiness 상태를 초기화해 helper 정리가 건너뛰어지는 결함을 발견했고, root 수정 후 권한 오류→종료 시 정리를 실제 검증했어요.

2026-10-27 패키징된 앱 확인:

- `REELS_ELECTRON_EXECUTABLE="…/Reels Dashboard.app/Contents/MacOS/Reels Dashboard" REELS_NATIVE_QA=1 npm run test:electron`: **7/7 통과**, skipped 0, flaky 0. 최종 frontend 동결 후 재빌드한 앱으로 재실행했으며 **최종 7.4초**에 완료했어요.
- fixture 6개는 실제 패키징된 앱의 preload/main을 통과했어요. native 1개는 `Resources/native/PhotosIndex.app`의 실행 파일·PID·isolated socket에서 응답했음을 확인했어요.
- `app.asar`의 루트 `LICENSE`와 `Resources/native/PhotosIndex-LICENSE` 포함을 확인했어요.
- packaged native 권한도 `not-determined`였어요. 권한 없는 색인 거부, 종료 후 helper PID와 identity 파일 제거를 확인했으며 실제 Photos 접근은 여전히 별도 실기기 확인 대상이에요.
- 패키징된 앱 screenshot을 직접 확인했어요. 대시보드·좌측 메뉴·빈 상태·예시 모드 표시가 정상 배치되며, 테스트가 캡처한 화면에서 겹침이나 잘린 주요 컨트롤은 없었어요. 디자인 선호에 대한 최종 판단은 사용자에게 있어요.
- 테스트 결과: `artifacts/electron-packaged/results.json`, HTML 리포트: `artifacts/electron-packaged/report/`, screenshot: `artifacts/electron-packaged/results/`.

최종 재검증에는 evidence reference 변경 시 계획 무효화를 반영한 frontend 빌드를 사용했어요. 보존한 패키징 화면은 `artifacts/preview/reels-dashboard-electron.png`예요.

이 QA는 root가 별도 소켓으로 실행한 실제 권한 확인용 helper를 종료하거나 변경하지 않았어요. 실제 Photos 권한 확인은 Mac 잠금 상태로 아직 완료되지 않았어요.

## 후속 회귀: 실행 중인 native 파일 재빌드

앞선 Electron 7개 테스트는 이미 만들어진 앱을 실행하는 범위였어요. 이후 반복 native 빌드에서 서명된 CLI·helper 실행 파일을 같은 inode에 덮어써 macOS가 실행을 거부하거나 실행 중 helper를 종료하는 문제가 확인됐어요. 디스크의 `codesign --verify` 성공만으로 이 동작을 검증할 수 없어요.

이 회귀의 완료 기준은 서명 검증에 더해 **실행 중 helper가 재빌드 동안 동일 PID·instance로 응답하고, 새 CLI 실행과 helper 재시작이 모두 성공하는 것**이에요. native installer의 staging·원자적 교체 변경과 회귀 스크립트를 독립 검토하고, 수정 파일을 포함한 패키징 앱 QA를 다시 수행해요. 이 절의 후속 결과가 기록되기 전까지 위 최초 패키징 결과만으로 재빌드 안정성을 주장하지 않아요.

2026-10-27 독립 native 회귀 검증:

- 검토 대상: helper bundle을 별도 디렉터리에 구성·서명·검증한 후 `RENAME_SWAP`으로 교체하는 설치 코드와, CLI를 새 inode에 복사·검증한 후 rename하는 설치 코드.
- 검토 중 테스트의 premature EOF 처리 누락을 발견했어요. native 종료가 socket EOF를 보내면 테스트가 실패하도록 수정했고, 새 CLI가 기존 helper를 자동 재실행해 결함을 숨기지 못하도록 새 CLI 호출 후에도 동일 PID·instance를 확인하도록 보강했어요.
- `node scripts/test-native-rebuild.mjs`: **exit 0**. 의도한 서명 실패 시 기존 파일 유지, 재빌드 도중 **36회 실제 socket 상태 응답**, 기존 helper PID·instance 유지, 두 실행 파일 inode 교체, 새 CLI `--help`·`status`, 새 helper 시작·종료를 확인했어요.
- 이 검증은 고유 QA socket과 임시 support 경로에서 status만 호출했어요. Photos 권한 요청이나 개인 자산 작업을 실행하지 않았어요.
- 수정본을 포함한 패키징 앱 QA는 아래 후속 결과로 별도 기록해요.

수정된 native 산출물로 재패키징한 앱의 후속 QA:

- `REELS_ELECTRON_EXECUTABLE="…/Reels Dashboard.app/Contents/MacOS/Reels Dashboard" REELS_NATIVE_QA=1 npm run test:electron`: **7/7 통과**, skipped 0, flaky 0, **7.3초**.
- 최종 JSON 리포트와 보존 screenshot은 위와 같은 경로에 이 실행 결과로 갱신했어요. packaged helper의 protocol 1 응답·실제 실행 파일/PID/socket 귀속·권한 오류 후 종료 정리를 다시 확인했어요.
- 권한 상태는 여전히 `not-determined`예요. 앞선 실제 권한 요청 프로세스는 서명 crash로 종료된 상태였으며, 그 요청이 계속 살아 있다거나 승인이 완료됐다고 취급하지 않아요. 이 QA에서는 새 권한 요청을 실행하지 않았어요.

## 후속 회귀: 한글 설치 경로의 production 종료

CLI 설치 스크립트는 CLI와 helper를 한 쌍으로 staging·검증·교체하도록 수정됐어요. QA는 실제 사용자 설치 경로 대신 임시 `PHOTOSINDEX_INSTALL_ROOT`의 한글·공백 경로를 사용해 기본 helper 탐색과 재설치를 검증해요.

추가로 QA 전용 종료 함수만 성공하는 것으로 충분하지 않아, `tests/electron/native-client-install-runner.ts`에서 실제 `src/desktop/native.ts`를 `node --import tsx`로 불러 실행했어요. C locale에서 production `NativeClient.request`로 helper를 시작하고, 자산을 조회하지 않는 실패 명령 뒤 `dispose`를 호출해 PID·socket·identity 파일이 없어지는지 확인해요.

- **수정 전 실패:** `Production NativeClient.dispose must stop its Korean/spaced-path helper after a command error` assertion 실패. metadata 경로의 Unicode 표현 차이와 `ps`의 locale별 비ASCII 출력 때문에 소유한 프로세스의 종료를 건너뛰었어요. 독립 cleanup으로 해당 QA helper와 임시 설치 경로를 정리했어요.
- **수정 후 성공:** realpath의 NFC 정규화, UTF-8 locale의 `ps -ww`, `comm`으로 확인한 정확한 실행 파일 비교, 원래 metadata 재확인 조건을 적용한 뒤 `node scripts/test-native-install.mjs`가 **exit 0**으로 통과했어요.
- 같은 실행에서 임시 설치 기본 탐색, 재설치 중 **5회 실제 status 응답**, 기존 PID·instance 유지, 실행 파일 inode 교체, 새 CLI/helper 시작, 명시적 app override도 확인했어요.
- 실제 사용자 설치와 Photos 권한·개인 자산은 변경하지 않았어요. helper 소유권 검사를 제거해서 테스트를 통과시킨 것이 아니에요.

Unicode 종료 수정까지 포함한 최종 패키징 앱에서 **7/7 통과**, skipped 0, flaky 0, **7.2초**로 재검증했어요. actual packaged helper의 상태 응답·소유권·종료를 다시 확인했고 권한은 `not-determined`였어요. 최종 JSON 리포트와 보존 screenshot도 이 실행 결과로 갱신했어요. 별도 실제 권한 확인용 helper는 종료하거나 변경하지 않았어요.
