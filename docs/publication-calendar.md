# 게시 캘린더와 외부 서비스

데스크톱 **캘린더** 탭은 이번 주·다음 주 네이버클립 목표를 보여 준다. 기본 주간 목표는 3개, 날짜 경계는 한국시간·월요일이다. 확인된 채널별 게시일과 Google Calendar에서 가져온 향후 게시 일정을 합산한다. 촬영일·프로젝트 날짜를 게시일로 추정하지 않는다. 게시 완료와 예정은 따로 세며, 같은 프로젝트/채널은 중복으로 세지 않는다.

## 정본과 연결

- 일정 생성·이동·취소: Google Calendar. 캘린더 탭의 외부 링크로 원본 일정을 연다.
- 작업 생성·상태·마감일: Linear. 앱은 가져온 이슈를 읽기 전용으로 표시하고 원본 이슈로 연결한다.
- 실제 채널 게시 완료: Dashboard의 `publications`. 달력 일정 시각이 지났다고 자동으로 게시 완료로 바꾸지 않는다.
- 로컬 `planning.json`: 확인한 외부 서비스 결과의 비공개 사본과 주간 목표. 계정 토큰·비밀번호는 저장하지 않고, 공유 snapshot에는 포함하지 않는다.

앱에 별도 할 일 편집기·캘린더 서버를 만들지 않았다. **이 버전은 연결 세션을 통한 가져오기 방식이며, 앱 자체 OAuth·자동 폴링·양방향 동기화는 없다.** 상단에는 각 서비스의 마지막 조회 시각을 표시한다. `새로고침`은 로컬의 최신 가져오기 결과를 읽는다. 조회 범위 밖 주에는 예정 일정과 목표 잔여량을 미확인으로 표시한다. 게시 개수는 실제 알려진 기록만 표시한다.

## MCP / CLI 동기화

1. 연결된 Google Calendar/Linear 도구로 필요한 주의 데이터를 조회한다. Calendar는 게시 일정만, Linear는 콘텐츠 팀의 이슈만 선택한다. 계정의 다른 일정·할 일을 통째로 가져오지 않는다.
2. `reels_get_planning`으로 로컬 `updatedAt`을 조회한다.
3. `reels_sync_planning`에 `expectedUpdatedAt`과 `calendar` 또는 `linear`를 넣는다. 각 provider에는 실제 `syncedAt`, 조회 구간 `{from,to}`(날짜·끝 제외), 실제 ID/URL과 결과 배열을 넣는다. 조회한 전체 구간을 페이지 끝까지 확인한 뒤 `window`를 기록한다.
4. 주어진 provider만 전체 교체하고 생략한 provider는 보존한다. 취소/삭제된 일정을 반영하려면 새 전체 결과에서 제거하거나 `cancelled:true`로 보낸다. 이전 조회 결과·동시 수정 리비전은 거절한다.
5. 앱에서 새로고침하거나 탭을 다시 열고 확인한다. 도구는 외부 서비스에 이벤트·이슈를 만들거나 네이버에 게시하지 않는다.

```json
{
  "expectedUpdatedAt": "1970-01-01T00:00:00.000Z",
  "weeklyTarget": 3,
  "calendar": {
    "url": "https://calendar.google.com/calendar/u/0/r/week",
    "syncedAt": "2026-11-12T08:00:00Z",
    "window": {"from": "2026-11-09", "to": "2026-11-23"},
    "events": [{
      "id": "provider-event-id",
      "projectId": "content:example",
      "title": "공개 예정",
      "channel": "naver-clip",
      "start": "2026-11-20T15:56:00+09:00",
      "url": "https://calendar.google.com/calendar/event?eid=example",
      "cancelled": false
    }]
  }
}
```

Linear 입력은 `{url,syncedAt,window,issues}`이고 이슈는 `{id,identifier,title,url,dueDate,state}`다. `dueDate` 없는 이슈는 주간 마감 목록에 포함하지 않는다. `state`는 Linear의 상태 타입(backlog/unstarted/started/completed/canceled)을 그대로 사용한다. API·커넥터 실패를 빈 목록 성공으로 저장하지 않는다.

CLI도 같은 도구 계약을 노출한다: `reels get-planning`, `reels sync-planning`. 전체 입력 사용법은 `reels help sync-planning`에서 확인한다. 앱과 MCP를 새 빌드로 다시 시작해야 새 도구가 등록된다.

주간 목표만 바꾸려면 `reels sync-planning --expected-updated-at <현재 updatedAt> --weekly-target 3`처럼 실제 변경 필드를 하나 이상 전달한다. CLI 도움말 예시에도 `--weekly-target 3`을 포함한다. 리비전만 있는 빈 업데이트는 계속 거절한다.

## 검증

- main 통합 검증(2026-11-12): `typecheck`, `check:architecture`, 전체 `npm test` 531개 중 527개 통과·4개 조건부 skip·실패 0, 공개 소스 검사 통과. 도구별 CLI 예시 스키마 검증의 `reels_sync_planning: No update supplied`를 예시 메타데이터 수정으로 해결했다. 이번 커밋 정리에서는 앱을 재패키징·재시작하지 않았다.
- 단위: 한국시간 월요일/연도 경계, 완료와 예정 구분, 중복/취소/채널 분리, 조회 범위, 잘못된 링크·날짜, 동시 리비전/과거 데이터 거절, 비공개 저장 권한.
- 웹 headless: 이번 주/다음 주, 부족한 수량, 서비스 링크, 조회 범위 밖 안내, 화면 폭1500/760/390.
- Electron background QA: 실제 MCP import → private JSON → preload → 캘린더 탭, dashboard 데이터에 외부 사본 미포함.
- 외부 서비스 실제 인증·등록과 설치 앱 적용은 개인 운영 기록에 별도로 남긴다. 합성 테스트를 실제 OAuth 자동 동기화의 증거로 쓰지 않는다.
