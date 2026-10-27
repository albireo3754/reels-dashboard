# 공통 웹 렌더러 QA

2026-10-27, macOS arm64에서 실제 Chromium 브라우저를 실행해 **42개 테스트가 모두 통과**했어요. 최종 실행은 `npm run test:web`이며 **16.7초, 실패0개, 재시도0회**였어요. 개발 중 소스 변경을 멈춘 상태에서 전체를 실행한 결과예요.

이 검증은 Electron에서도 사용하는 React 화면의 동작을 검사해요. `?demo=1`의 촬영본·분류·내보내기·복구는 명시적인 synthetic fixture예요. 실제 Photos 라이브러리의 조회·복사·삭제를 실행하지 않았고, fixture 성공을 PhotoKit·iCloud·설치 앱 QA 성공으로 계산하지 않아요.

## 환경과 재현

- Playwright1.64.1, Chromium156.0.8078.4.
- Vite 개발 서버 `127.0.0.1:4173`, browser worker2개.
- Desktop Chrome 기본 viewport1280×720, 모바일 viewport390×844.
- [설정](../playwright.web.config.ts), [테스트 실행 안내](../tests/web/README.md).

```sh
npm install
npx playwright install chromium
npm run test:web
```

테스트가 진행되는 동안 renderer 소스를 수정하면 Vite HMR이 화면 상태를 재설정할 수 있으므로, 최종 검증은 소스를 고정하고 실행해요. 이번 조사에서도 한 실행의 trace에서 버튼 조작 도중 `App.tsx` hot update를 확인했고, 수정 완료 후 전체42개를 다시 실행해 위 결과를 얻었어요.

## 검증 범위

| 파일 | 테스트 수 | 실제로 확인한 동작 |
| --- | ---: | --- |
| [dashboard.spec.ts](../tests/web/dashboard.spec.ts) | 4 | 콘텐츠 생성·단계·다음 할 일의 reload 유지, 명시적으로 공유한 항목만 JSON 다운로드, 공개 필드 목록, 잘못된 링크 거부, demo 동기화 HTTPS 검사·토큰 제거 |
| [shared-web.spec.ts](../tests/web/shared-web.spec.ts) | 9 | 실제 웹 adapter의 snapshot 로드, 모든 탭의 desktop 작업 제한, 빈 결과, schema·필수값·timestamp·unsafe URL 오류,503 실패·재시도, 모바일 배치 |
| [workspace.spec.ts](../tests/web/workspace.spec.ts) | 29 | Photos 권한6종·권한 요청·연결 오류·protocol 불일치, 날짜 색인·fine/coarse·선택 초기화·빈 날짜, 그룹 자산 분류, 증거 페이지·OCR·privacy·부분 실패·timeout, decision 저장·불러오기·중복 ID 거부, 복사·이동·재개, 키보드·모바일 접근 |
| 합계 | **42** | 동일 React 화면에서 수행한 browser UI 시나리오 |

세부 실패 조건도 확인했어요.

- denied 상태에서는 색인 버튼을 실행할 수 없고, 명시적인 권한 요청 뒤에만 상태가 갱신돼요. limited를 authorized로 바꿔 표시하지 않아요.
- 다른 날짜나 그룹 크기로 조회하면 이전 자산 선택이 남지 않아요.
- 26개 촬영본을12·12·2개의 세 페이지로 탐색하고 이전·다음 버튼의 경계를 확인했어요. 일부 preview가 빠져도 전체 자산 선택 목록은 유지하고 partial-evidence 경고를 보여줘요.
- 미정 선택·낮은 confidence·미해결 사항은 검증에서 거절돼요. 중복 ID를 가진 import는 체크박스에 덮어써서 정상화하지 않고 원본 입력 검증에서 거절해요.
- 선택을 바꾸면 기존 plan과 검토 상태가 무효화돼요. 복사는 계획 검토, 이동은 별도 원본 삭제 확인까지 필요해요.
- 복사 실패, 업로드 timeout, 원본 삭제 실패를 성공 receipt로 표시하지 않아요. 기존 이동 계획과 digest로 재시도할 수 있고 현재 색인 없이 복구 화면을 사용할 수 있어요.
- 잘못된 복구 digest를 거절하고 digest 변경 시 기존 실행 확인을 해제해요.
- 공유 snapshot의 project에는 `id`, `title`, `date`, `stage`, `nextAction`, `publicURL`만 들어가요. 공유하지 않은 콘텐츠가 다운로드에 포함되지 않는 것을 실제 다운로드 JSON으로 확인했어요.
- 웹 snapshot 오류를 demo 데이터나 성공한 빈 데이터로 감추지 않아요. 일반 웹 화면에서는 Photos 색인·원본 이동·현황 업로드 컨트롤을 제공하지 않아요.

## 발견하고 수정한 UI 문제

390px 모바일 폭에서 메뉴 텍스트를 숨기면 아이콘 버튼의 접근성 이름도 사라졌어요. renderer 담당자가 각 메뉴 버튼에 명시적인 `aria-label`을 추가했고, 모바일 메뉴 이동과 가로 overflow 검사를 다시 통과했어요.

데스크톱과 모바일 화면을 직접 캡처해 확인했어요. 주요 제목·콘텐츠 카드·버튼에 겹침이나 잘림이 없었고 모바일 가로 overflow는 허용치1px 이내였어요. 이 확인은 전체 WCAG 감사나 모든 기기에서의 시각적 완성도를 보장하지 않아요.

## 산출물

실행 시 아래 이름의 스크린샷을 `test-results/web/`의 해당 테스트 디렉터리에 생성해요. 모두 synthetic 데이터이고 저장소에서는 생성 결과를 제외해요.

- `dashboard-desktop.png`: 데스크톱 작업 대시보드.
- `library-evidence.png`: 촬영본·OCR·privacy 표시.
- `library-mobile.png`: 모바일 폭의 촬영 그룹·분류 화면.
- `shared-dashboard-desktop.png`: 읽기 전용 웹 현황.
- `shared-dashboard-mobile.png`: 모바일 공유 현황.
- HTML 결과: `playwright-report/web/index.html`.

## 별도 증거가 필요한 범위

- 실제 PhotoKit 권한·라이브러리·Vision OCR·iCloud 업로드와 원본 이동은 native/설치 앱 QA 영역이에요.
- 실제 Electron preload/main/helper 연결과 패키징은 [Electron QA](electron-qa.md)의 근거를 따라요. 웹 renderer 결과만으로 대체하지 않아요.
- demo의 `syncSnapshot` 성공은 실제 서버 전송 증거가 아니에요. production desktop adapter와 Sites 수신 API의 통신·인증·저장은 별도 계약 및 배포 검증이 필요해요.
- 모바일은 Chromium viewport 시뮬레이션이에요. iPhone Safari·Android 실기기 테스트는 하지 않았어요.
- 키보드 메뉴 활성화·모달 초기 focus·저장은 확인했지만 전체 스크린리더·키보드 focus trap·접근성 표준 감사는 하지 않았어요.
