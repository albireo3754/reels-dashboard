# Instagram 인사이트 연동

데스크톱의 **Instagram 인사이트** 화면에서 소유 계정의 조회·도달·좋아요·댓글·저장·공유를 읽고 게시 시각과 비교한다. 수집 버튼을 눌렀을 때만 공식 API를 호출하며, 수집 기록은 앱의 비공개 저장소에 남는다. 공유 웹 빌드와 `snapshot.json`에는 계정 연결·지표·토큰을 넣지 않는다.

## 연결과 사용

1. Meta에서 소유 계정의 **조회용** 토큰을 발급하고 비공개 파일로 저장한다. 토큰 파일은 현재 사용자만 읽을 수 있도록 권한 `600`으로 둔다. 토큰을 원고·JSON snapshot·Git·채팅에 복사하지 않는다.
2. 앱의 **Instagram 인사이트 → 계정 연결 설정**에서 사용자 이름과 토큰 발급 방식을 입력하고 **조회 토큰 파일 연결**로 파일을 선택한다. 앱은 계정 이름을 실호출로 대조한 뒤 파일의 위치만 비공개 연결 설정에 저장한다. 파일 내용과 위치는 renderer·MCP에 반환하지 않는다.
3. **Instagram에서 가져오기**를 누르면 비동기로 수집한다. 앱 화면은 완료 알림을 받아 최신 결과를 읽는다. 실패할 때 같은 요청을 자동 반복하지 않는다.
4. 수집 기록을 선택해 당시 누적값을 다시 볼 수 있다. 주제는 게시물 표에서 직접 입력하고 포커스를 옮기면 저장된다. Instagram URL shortcode가 일치하면 기존 콘텐츠 기록의 제목을 사용하고 해당 기록을 열 수 있다. 게시 상태·문안 정본을 자동 수정하지 않는다.

OAuth 로그인·토큰 발급·갱신은 앱 안에 구현하지 않았다. 발급 화면의 가려진 토큰 표시값(검은 원·별표)은 실제 토큰이 아니며 연결 단계에서 거절한다. 토큰을 갱신하면 파일을 교체하거나 연결 설정에서 새 파일을 선택한다.

## API 경로

- **통합 로그인**: `graph.facebook.com/v27.0`. `/me`는 Instagram 계정이 아니므로 `/me/assigned_instagram_accounts`에서 입력한 소유 계정을 찾고, 그 ID로 프로필·미디어를 읽는다. 조회 권한은 `instagram_basic`, `instagram_manage_insights`다.
- **Instagram 로그인**: `graph.instagram.com/v27.0`, Instagram 사용자 토큰을 사용한다. 필요한 권한은 `instagram_business_basic`, `instagram_business_manage_insights`다.
- 발급 방식은 명시적으로 선택한다. 실패했다고 다른 호스트·로그인 방식으로 자동 전환하지 않는다. 자격증명은 Authorization 헤더로만 전송하고 리디렉션을 거절한다. 페이지 이동은 API가 반환한 커서로 공식 호스트의 요청을 재구성하며 `paging.next` URL을 따라가지 않는다.
- 미디어 목록은 최대 20페이지까지 확인하고, 지표는 최신 100개까지 수집한다. 조회된 목록 수와 실제 지표 수집 수를 따로 표시한다. 버전별·게시물별 지표 미지원은 0과 구분한다. 인증 만료·요청 제한·모든 지표 조회 실패에는 이전 성공 snapshot을 유지한다. 일부 지표만 미제공이면 상태와 빈 값을 저장한다.

[Meta 통합 로그인 시작 가이드](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/get-started?locale=en_US), [토큰과 계정 ID](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-unified-login/authentication?locale=en_US), [미디어 인사이트](https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights).

## 비교 기준

- 한국시간 기준 요일·6시간 시간대·직접 지정한 주제로 묶고 게시물별 비율의 중앙값과 유효 표본 수를 보여준다. **반응률·저장률·공유율**을 바꿔 볼 수 있다.
- 반응률은 `(좋아요+댓글+저장+공유)/도달×100`, 저장률·공유율은 각각 저장·공유를 도달로 나눈다. 빈 값·API 오류·도달 0에는 비율을 만들지 않는다. 실제 반응 0은 0으로 유지한다.
- 차트는 릴스만 비교하며 기본으로 게시 후 48시간 이상을 사용한다. 과거 기록의 경과시간도 해당 기록의 수집 시각으로 계산한다. 표에는 캐러셀과 최근 게시물도 남기고 비교 제외 여부를 표시한다.
- **제외할 게시 기간**에 명절 등 시작일·종료일을 입력하면 그 날짜에 게시한 릴스를 제외한다. 해당 기간에 다른 게시물이 시청된 영향 전체를 제거한 실험은 아니다.
- 누적 기간·주제·표본 수가 다르므로 최적 게시 시각이나 훅의 인과 효과로 단정하지 않는다. 게시물 도달을 합산한 값을 중복 제거한 계정 도달로 취급하지 않는다.

## 비공개 저장과 경계

앱 user-data 안에서만 다음 파일을 사용한다.

- `instagram-connection.json`: 소유 계정·발급 방식·선택한 토큰 파일의 위치·직접 지정한 주제. 토큰 값은 저장하지 않는다.
- `instagram-history.json`: 계정별 수집 기록 ID·시각·개수.
- `instagram-snapshots/<uuid>.json`: 매번 새로 쓰는 프로필·게시물 지표 기록. 파일 권한 `600`, 폴더 권한 `700`.

다른 계정으로 연결을 바꾸면 이전 계정 기록을 현재 계정에 섞지 않는다. 인증 값·API 오류 원문·외부 서비스 응답의 credential-bearing URL을 반환하지 않는다. 게시·댓글·팔로우·광고·Photos 변경은 이 기능에 없다. 앱 종료 판단에는 진행 중 수집도 포함한다.

## MCP와 CLI

- `reels_get_instagram_insights({snapshotId?})`: 로컬 상태·현재 또는 지정 수집 기록·주제·busy·lastError. 네트워크 요청 없음.
- `reels_refresh_instagram_insights({})`: 비동기 수집 시작. 곧바로 반환하므로 get으로 `busy=false`까지 확인하고 `lastError`를 검사한다. 시간 초과나 응답 단절 후 자동으로 다시 시작하지 않는다.
- `reels_set_instagram_topics({topics:{"123":"주제"}})`: 현재 계정 최신 기록에 속한 게시물만 부분 갱신한다. 빈 문자열은 미분류로 되돌린다.

```sh
reels get-instagram-insights
reels refresh-instagram-insights
reels get-instagram-insights
reels set-instagram-topics --topics '{"123":"맛집"}'
```

연결 설정은 데스크톱 파일 선택기로 한다. MCP·CLI에 토큰 값을 넘기는 도구는 제공하지 않는다. 새 도구는 새 빌드로 앱을 시작한 뒤 등록된다.

## 검증

합성 자료로 SDK 소유권·고정 호스트·날짜 정규화·오류 비노출, 비공개 파일 권한·재열기·동시 수집·실패 후 이전 기록 보존·0과 미제공·KST 기간 제외·소표본 계산을 검사했다. 웹 headless에서 1500/760/390 폭과 기간·주제·미연결 상태, background Electron에서 실제 파일 선택 IPC·MCP 비동기 수집·주제 변경·공유 snapshot 제외·앱 재열기를 확인했다. 실계정 수집 증거와 운영 snapshot은 공개 저장소 밖의 개인 검증 디렉터리에 보관한다.

패키지 앱에서는 실제 비공개 프로필 파일이 존재해도 데모 모드가 그 연결·기록을 읽지 않는 것을 별도로 확인했다. 운영 앱 적용 상태는 [TASKS](../TASKS.md)의 해당 절에서 구분한다.
