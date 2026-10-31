# 실제 편집 런타임 Electron QA

이 검증은 예시 adapter의 성공 응답을 검사하는 테스트가 아니에요. 실제 Electron preload/main, 번들된 Python 편집 엔진, FFmpeg·FFprobe를 사용해 합성 촬영본을 편집하고 결과 파일을 확인해요. 합성 출력 테스트와, 별도 사용자 허용 후 수행한 한 영상의 실제 Photos→편집기 가져오기 검증을 아래에서 구분해요.

## 개발 중 포커스 보호

Playwright Electron 테스트는 기본적으로 `REELS_BACKGROUND_QA=1`로 실행해 창을 숨기고 OS 포커스를 받지 않아요. macOS Dock·트레이를 만들지 않으며 activate/second-instance 이벤트도 창을 앞으로 가져오지 않아요. 숨겨진 renderer의 타이머 제한은 해제하므로 DOM 조작·스크린샷·재생 검증을 계속할 수 있어요. 일반 앱 실행은 기존 동작을 유지해요.

창 활성화 자체를 확인하는 application-identity 테스트는 기본 실행에서 제외해요. 사용자가 창 표시를 요청한 경우에만 `REELS_ELECTRON_HEADED=1 npm run test:electron -- tests/electron/application-identity.spec.ts`로 실행해요. 웹 테스트는 headless를 기본값으로 명시했어요. 기존 패키징 앱에는 이 변경이 없으므로 패키징 QA 전에는 새로 빌드해야 해요.

2026-10-31 개발 빌드 검증: background 회귀(숨김·포커스 불가·activate/second-instance·스크린샷)와 기존 desktop 5개 통과, 창 활성화 전용1개는 의도적으로 제외했어요. 기존 preload API 목록 검사는 현재 bridge의 `cardNews`·`routeMap`이 기대 목록에 없어1개 실패했으며 이번 범위에서 수정하지 않았어요. 빌드·타입·FSD·diff 검사 통과. 기존 패키징 앱은 재빌드·검증하지 않았어요.

## 실행

편집 runtime과 Electron 빌드가 준비된 뒤 실행해요. 패키징된 앱은 `REELS_ELECTRON_EXECUTABLE`에 해당 실행 파일을 지정해요.

```sh
REELS_EDITOR_QA=1 npm run test:electron -- tests/electron/editor.spec.ts
```

테스트는 별도의 임시 user-data 폴더에서 실행하고 실제 네이티브 파일 dialog의 반환값만 합성 파일 경로로 지정해요. `REELS_DEMO=0`에서 실제 editor bridge를 호출하며, 미디어 처리를 mock으로 바꾸지 않아요.

## 범위

| 흐름 | 검증 기준 |
| --- | --- |
| 입력 | 번들 FFmpeg로 만든 세로 H.264 영상과 AAC 음성. 한글·공백 경로를 사용해요. |
| 가져오기 | native probe 결과와 원본 정보, proxy 생성, custom media URL을 확인해요. |
| 재생 | 실제 media protocol의 byte-range 206 응답, HEAD의 빈 body·길이, 잘못된 범위의 416, 외부 Origin 거부와 브라우저 video 구간 이동을 확인해요. |
| 편집 | 장소 안내 묶음, 본문 자막, 표지 훅·배경 시점을 설정해요. |
| 미리보기 | 영상·표지 PNG를 생성하고 브라우저에서 디코딩해요. 합성 미리보기만 QA artifact로 보존해요. |
| 내보내기 | 실제 render job 완료, FFprobe 영상 해상도·길이·음성 stream, 표지, 영상·표지 manifest를 확인해요. |
| 작업 저장 | 편집 설정 저장 뒤 앱을 종료·재실행하고 같은 작업을 불러와요. |
| 신뢰 경계 | renderer가 바꾼 source 정보가 실제 입력을 덮어쓰지 못하는지, 잘못된 프로젝트 ID와 원본 출력 경로가 거부되는지 확인해요. |
| 취소 | 긴 합성 영상의 실제 render progress가 발생한 뒤 취소해요. 완료 파일을 게시하지 않고 work 디렉터리가 정리되는지 확인해요. |
| 원본 보존 | 편집·거부·취소 전후 원본 hash가 같아야 해요. |

내보내기 완료와 취소는 단순 UI 문자열로 판정하지 않아요. 실제 파일·FFprobe 결과·임시 작업 정리·원본 보존을 함께 확인해요. Photos 영상의 편집용 materialization은 별도 명시적 허용을 받은 QA만 수행하며, 이 합성 미디어 테스트의 성공으로 검증했다고 주장하지 않아요.

## 실행 기록

새 정본 경로에서 개발 Electron 빌드로 실행한 결과:

- `REELS_EDITOR_QA=1 npm run test:electron -- tests/electron/editor.spec.ts`: **2/2 통과**, skipped 0, flaky 0, **10.4초**.
- 실제 1080×1920 H.264/AAC 합성 입력에서 proxy 생성, Range·HEAD·416·외부 Origin 거부, 브라우저 seek, 영상·표지 PNG, 실제 영상·음성·표지·manifest 출력, 재실행 후 프로젝트 복원을 확인했어요.
- 긴 합성 영상의 실제 진행률이 발생한 뒤 취소했고 출력 파일 없음·작업 디렉터리 정리·원본 hash 불변을 확인했어요. `cancelled` 문자열만으로 판단하지 않았어요.
- renderer의 source 정보 변조가 실제 입력을 바꾸지 못하며 잘못된 ID·원본 출력 경로는 거부됐어요. 거부한 작업도 임시 디렉터리를 정리했어요.
- 최초 개발 실행은 custom media protocol의 file-origin Range fetch가 거부되어 실패했어요. CORS·노출 헤더·허용 Origin 처리를 수정한 후 통과했고, 임의 외부 Origin은 계속 403으로 거부됐어요.
- 합성 미리보기를 직접 확인했어요. 장소 안내 묶음의 가로 중앙, 본문 자막, 표지 훅·서명의 왼쪽 배치가 표시됐어요. 개인 미디어는 사용하지 않았어요.
- 타입 검사와 `git diff --check`도 통과했어요.

최종 편집 runtime을 포함한 패키징 앱에서 재검증했어요.

- `REELS_ELECTRON_EXECUTABLE="…/Reels Dashboard.app/Contents/MacOS/Reels Dashboard" REELS_EDITOR_QA=1 npm run test:electron -- tests/electron/editor.spec.ts tests/electron/desktop.spec.ts`: **8/8 통과**, skipped 0, flaky 0, **17.0초**.
- 구성은 기존 desktop/IPC 회귀 **6개**와 실제 편집 runtime **2개**예요. editor API가 추가된 뒤에도 renderer sandbox·context isolation·제한된 preload API·임의 파일/명령 거부·저장·snapshot 계약이 통과했어요.
- 편집 테스트는 앱 `Resources/editor-runtime`의 실행 파일·FFmpeg·FFprobe를 사용했어요. 실제 영상·음성·표지·manifest 출력과 취소·원본 보존·재시작 복원이 패키징 앱에서도 통과했어요.
- 전체 합성·desktop 8개 테스트 결과는 `artifacts/electron-packaged/editor-synthetic-suite-results.json`으로 보존했어요. 합성 PNG는 `artifacts/preview/editor-synthetic-video.png`, `editor-synthetic-cover.png`에 있어요.
- 새 native 빌드의 실제 Photos→편집기 materialization은 이 합성 테스트의 성공으로 대신하지 않고 아래에서 별도 검증했어요.

## 사용자 허용 후 실제 Photos→편집기 가져오기

- opt-in 테스트 `hands one explicitly approved Photos video to the real editor`: **1/1 통과**, skipped 0, flaky 0, **18.9초**.
- 실제 packaged bridge에서 `authorized`를 확인했어요. 실행 환경변수로 명시한 촬영일만 조회하고 날짜별 앞 3개 그룹 이내에서 짧은 동영상을 찾았어요. 적합한 그룹을 찾는 즉시 조회를 멈추고 그 그룹에서 가장 짧은 30초 이하 영상 하나만 선택했어요. 두 번째 날짜는 첫 날짜에 후보가 없을 때만 허용해요.
- `editor.fromPhotos`가 실제 native `editor.materialize` 경로를 거쳐 앱 전용 private cache에 편집용 사본을 만들었어요. native helper가 패키지 내부 실행 파일이며 해당 QA 소켓을 소유한 실제 프로세스임을 확인했어요.
- 생성 원본 사본이 테스트 profile의 `native/editor-sources` 안에 있고 권한이 `0600`인지 확인했어요. 편집 엔진의 proxy가 실제로 로드되고 영상 비율을 유지하며 구간 이동하는지 확인했어요.
- 날짜·파일명·자산 식별자·실제 미디어와 치수·길이를 공개 문서나 출력으로 남기지 않았어요. private 보고서에도 성공 여부만 첨부했어요. 실제 영상의 frame 추출·screenshot·편집본 외부 내보내기·업로드·Photos 원본 삭제는 하지 않았어요.
- 테스트가 만든 앱 profile을 종료·정리하여 private 원본 사본과 proxy를 제거했어요. 별도 사용자 권한 확인용 helper는 건드리지 않았어요.
- 이 테스트는 `REELS_EDITOR_QA=1`, `REELS_LIVE_EDITOR_QA=1`, `REELS_LIVE_EDITOR_DATE`와 선택적인 `REELS_LIVE_EDITOR_FALLBACK_DATE`를 명시해야 실행돼요. 실제 촬영일은 테스트 소스에 고정하지 않아요.

실제 handoff의 성공과 읽기·복사 범위는 위 실행 기록으로 남겼어요. 공통 reporter의 `results.json`과 HTML report는 마지막 실행으로 갱신되므로, 아래 후속 회귀 실행 후에는 해당 합성 테스트의 결과를 가리켜요. 전체 합성 8개 결과는 별도 JSON으로 보존했어요. 타입 검사와 diff 검사도 통과했어요.

## 내보내기 후 재편집 상태 회귀

내보내기를 마친 프로젝트를 변경 없이 저장하면 `review`를 유지하고, 자막 등 편집 설정을 실제로 변경해 저장하면 `editing`으로 돌아가도록 수정했어요. 재패키징한 앱에서 변경한 첫 번째 실제 편집 테스트만 실행해 **1/1 통과, 7.4초**를 확인했어요.

합성 영상의 실제 내보내기 후 변경 없는 저장·자막 변경 저장·앱 재실행 복원까지 통과했어요. 취소 테스트와 개인 Photos 가져오기는 다시 실행하지 않았어요. 이번 결과는 `artifacts/electron-packaged/editor-reedit-regression-results.json` 및 최신 `results.json`에 보존했어요.
