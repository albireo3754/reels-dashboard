# 편집기 웹 렌더러 QA

2026-10-27 기준, 기존 PhotosIndex·대시보드42개 테스트와 새 편집기16개 테스트를 함께 실행해 **58개 모두 통과**했어요. 최종 명령은 `npm run test:web`, 결과는 **58 passed (23.0s), 실패0개·재시도0회**예요.

테스트 소스는 [editor.spec.ts](../tests/web/editor.spec.ts)이며, 실행 환경은 기존 [웹 QA](web-qa.md)와 같은 Playwright1.64.1·Chromium156.0.8078.4·worker2개예요. Desktop viewport1280×720과 모바일 viewport390×844를 사용했어요.

## 실제로 검증한 것

| 시나리오 | 확인한 동작 |
| --- | --- |
| 로컬 영상 열기 | 명시적 demo adapter로 생성한12초 H.264 MP4를 브라우저가 실제 decode하고 재생·3.5초 탐색하며 media error가 없는지 검사했어요. |
| 장소 안내 묶음 | 기본 배치에서 좌표 입력이 잠기고, 수동 배치·가로/세로 위치·핀 크기·설명 재질·핀 지속 표시·표시 구간을 바꾼 뒤 저장/reload로 복원했어요. |
| 설명 재질 | 테이프인데 설명이 없으면 거절하고, 장소 핀만 선택하면 빈 설명으로 preview를 만들 수 있어요. |
| 본문 자막 | 역순 시간·빈 내용을 거절하고, 정상 구간/내용을 저장·복원·삭제할 수 있어요. |
| 겹치는 자막 | 0–3초와2–4초가 겹치면 preview와 export 모두 명시적인 오류를 표시하고 작업을 시작하지 않아요. |
| 표지 | 두 줄 훅을 요구하고, 표지 시점·자동/큰 글자 방식·훅 좌표·장소 핀 좌표를 조절해요. 표지 위치 변경이 영상의 장소 안내 좌표를 바꾸지 않아요. |
| preview 무효화 | 문구 등 설정을 바꾸면 과거 합성 이미지를 숨겨 현재 설정 결과로 오인하지 않게 해요. |
| 진행 상태 | synthetic export 진행률이100%에 도달하고, 대시보드로 이동해도 작업이 계속되어 해당 콘텐츠가 검토 대기로 바뀌어요. 작업 중 원본 전환은 막아요. |
| 취소 | 취소 후 취소됨을 표시하고 완료 결과 버튼을 제공하지 않으며 새 원본을 열 수 있어요. |
| Photos에서 편집 | 동영상에만 ‘이 영상 편집’을 제공하고 선택한 fixture asset ID를 편집기에 전달해요. 생성한 프로젝트를 대시보드에서 편집 중으로 확인해요. |
| 읽기 전용 웹 | 영상 편집 탭에서 데스크톱 전용임을 안내하며 로컬 열기·영상 출력 버튼이 없어요. |
| 실행 환경 오류 | runtime unavailable이면 이유를 표시하고 영상 열기를 비활성화해요. |
| preview 실패 | 오류를 표시하고 성공 이미지를 대신 보여주지 않아요. |
| render 실패 | 실패를 표시하며 완료 경로·결과 열기 버튼을 제공하지 않아요. |
| HDR 표시 | synthetic HDR metadata일 때 원본 HDR과 재생용 SDR 프록시를 구분해 안내해요. |
| 모바일 |390px에서 메뉴와 입력이 이름을 유지하고 가로 overflow가1px 이하인지 확인했어요. |

## 근거의 경계

**실제 동영상 decode/play/seek**는 생성한 단색 MP4를 사용해 Chromium에서 실행했어요. 개인 촬영본·Photos 라이브러리를 사용하지 않았어요.

**합성 preview·렌더 진행률·완료·취소·Photos handoff**는 `?demo=1` adapter의 synthetic 동작이에요. 이 테스트에서는 FFmpeg를 실행해 결과 영상을 만들지 않아요. 화면도 예시 모드이며 실제 파일을 만들지 않았다는 점을 표시해요. Pixel 배치·글꼴·HDR 보존·오디오 보존·실제 원본 export는 별도 engine 및 Electron 통합 QA의 증거가 필요해요.

모바일 검증은 Chromium viewport 시뮬레이션이에요. iPhone Safari나 Android 실기기, 전체 접근성 감사의 완료를 뜻하지 않아요.

## 확인 중 반영한 내용

편집기 초안의 자막 간 겹침 검사가 빠져 있어 renderer 담당자에게 전달했어요. renderer와 demo가 backend와 같은 공통 `validateEditSettings`를 사용하도록 반영한 뒤, 겹침 오류 UI와 export 차단 테스트를 통과했어요.

테스트의 textarea 재입력 locator는 값이 포함되는 nested label 문자열 대신 실제 textbox의 accessible name을 사용하도록 수정했어요. 제품 동작에 대한 assertion을 줄이지 않았어요. 개발 중 HMR 간섭이 있는 실행을 최종 결과로 사용하지 않고 소스를 고정한 뒤58개 전체를 재실행했어요.

## 스크린샷

두 캡처 모두 페이지 맨 위로 이동한 뒤 전체 화면을 저장해 sticky 위치 때문에 생기는 빈 공간을 피했어요. 실제 이미지도 열어 확인했어요. 캡처에는 synthetic 미디어와 예시 문구만 있어요.

- `test-results/web/editor-local-synthetic-vid-d1a28-seeks-without-a-media-error-chromium/editor-desktop.png`
- `test-results/web/editor-mobile-editor-retai-bb273-without-horizontal-overflow-chromium/editor-mobile.png`

위 생성 결과와 `playwright-report/web/`는 Git에서 제외되며 테스트를 실행하면 다시 만들 수 있어요. 공개 저장소에는 테스트·명세를 남기고 개인 미디어는 포함하지 않아요.
