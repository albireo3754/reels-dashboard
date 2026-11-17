# 현황 보고서 (`reels report`)

앱 화면은 카드·탭이 많아 "지금 어디까지 왔나"를 한눈에 보기 어렵다. `reels report`는 그 순간의 진행 상황을 HTML 파일 하나로 뽑는다. 사람은 브라우저로 열어 보고, 다른 에이전트 세션은 같은 파일(또는 그 안의 JSON)을 읽어 같은 숫자로 이야기한다.

## 사용

```sh
reels report                         # <profile>/reports/status.html 을 새로 쓴다
reels report --out ./status.html     # 원하는 위치(상대 경로는 작업 폴더 기준)
reels report --now 2026-11-17T09:00:00+09:00   # 이 시각 기준으로 계산(재현용)
```

- 앱이 꺼져 있어도 된다. `dashboard.json`·`planning.json`·`autopilot/`을 읽기만 하고 앱 상태는 바꾸지 않는다. `REELS_USER_DATA`로 프로필을 고른다.
- stdout은 다른 명령처럼 JSON 한 줄이다: `data.path`(쓴 파일), `counts`, `today`(오늘 할 일 제목·결정), `thisWeek`(이번 주 합계), `warnings`(개수).
- 기존 파일은 **이 명령이 쓴 파일**(`<meta name="generator" content="reels-dashboard-status-report">`)일 때만 덮어쓴다. 다른 파일·심볼릭 링크·폴더면 `OUTPUT_EXISTS`(exit 2)로 거절한다. `--out`의 상위 폴더가 없으면 exit 2. 저장 데이터가 깨졌으면 `STORE_UNREADABLE`(exit 11).
- 파일 권한은 0600이다. 세션 공유는 같은 사용자 계정 안에서 경로를 넘기는 것을 전제로 한다.

## 내용

계산은 앱과 같은 규칙을 그대로 쓴다. 따로 셈하지 않는다.

| 섹션 | 근거 |
|---|---|
| 확인할 것 | 예약 시각이 지났는데 게시 확인이 없는 채널, 캘린더 사본 없음, autopilot 상태 문제 |
| 오늘 할 일 | `computeAutopilotView`의 `today` (= `reels autopilot today`와 같은 선택, 단 `today.md`는 쓰지 않음) |
| 요약 숫자 | `projectState`: 사람이 볼 것(검토 대기+채널 남음)·진행 중·공개 예약 대기·완료 |
| 주간 목표·영상 예약 큐 | `weeklyGoalsView` (= `reels get-weekly-goals`, [주간 목표](weekly-goals.md)) |
| 작업 순서 | `priority`가 있는 미완료 프로젝트, 순번 순 |
| 검토 대기·채널 남음·공개 예약 대기·진행 중 | 순번 없는 미완료 프로젝트를 상태별로, 날짜 최신순. 공개 예약 대기·진행 중은 접혀 있다 |
| 최근 게시 | 최근 14일 동안 게시 완료로 기록된 채널 |

같은 내용이 `<script type="application/json" id="reels-status-report">`에 들어 있다(형식 `version: 1`). 스크립트는 실행되지 않으며(CSP `default-src 'none'`), 외부 요청도 없다.

## 넣지 않는 것

공유용이므로 제목·단계·다음 할 일·날짜·**게시된 글의 링크**만 담는다. 로컬 경로·`resources`·`localNotes`·캘린더 일정 링크(계정이 인코딩돼 있음)·Linear 링크는 넣지 않는다. 다음 할 일 문장에 사용자가 직접 적은 경로가 있으면 그대로 나온다.

## 코드와 검증

- 계산: `src/features/status-report/model/report.ts`, HTML: `model/html.ts` (둘 다 순수 함수). 파일 쓰기: `src/app/cli/report.ts`.
- 단위 `tests/unit/status-report.test.ts`: 상태 집계·작업 순서 우선, 14일 게시·지난 예약 경고, 경로·메모·캘린더 링크 제외, HTML 이스케이프·JSON 왕복·http 링크만, CLI 기본 경로·자기 파일만 덮어쓰기·심볼릭 링크 거절·사용 오류·빈 프로필·깨진 저장소, 빌트인 목록.
- 앱 안의 버튼·자동 갱신은 아직 없다.
