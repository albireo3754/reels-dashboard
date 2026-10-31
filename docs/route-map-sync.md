# 촬영 지도와 모바일 동기화

콘텐츠에 `document` 역할로 연결된 **`route-map-data.json` 한 개**가 앱과 사이트의 지도 정본이에요. 지도 JSON을 바꾸면 기존 모바일 브리핑 동기화가 같은 데이터를 다시 전송해요. 앱에서 사용하는 미디어 원본 경로나 미리보기는 사이트 지도 데이터에 포함하지 않아요.

## 전달 계약

`projectSnapshot()`의 `contents[]`는 다음 필드를 포함해요.

```ts
routeMap: RouteMapData | null;
routeMapStatus: "ready" | "unavailable" | null;
```

- 등록 자료가 없으면 두 필드는 `null`이에요.
- 이름이 정확히 `route-map-data.json`인 문서 하나를 읽고 검증했으면 `ready`와 정제한 데이터를 전달해요.
- 중복 등록, 잘못된 JSON·값, 누락 파일, 8MiB 초과, 읽는 동안의 파일 교체는 `unavailable`과 `null`이에요. 이전 지도를 성공한 최신 지도처럼 전달하지 않아요.
- 사이트 수신 한도는 **지도 하나가 아니라 전체 snapshot JSON 4MiB**예요. D1 행 크기 제한에도 여유를 두도록 정제한 지도 하나는 **1MiB**, UTF-8 전체 요청은 **3.5MiB** 예산으로 확인해요. 초과 지도는 `unavailable`/`null`로 제외하고, 합계 초과 시 가장 큰 지도부터 제외해 기본 진행 상태의 동기화를 유지해요. 로컬 앱에서는 원래 8MiB 이하 지도 조회가 가능해요.
- 원본의 `source`, `thumbnail`, 로컬 경로와 임의 필드는 제거해요. 파일명·촬영시각·좌표·위치 정확도·구간·지도 도형·출처·경로의 확인 상태만 전달해요.
- 좌표는 `[longitude, latitude]`예요. 중복 파일명, 경로형 파일명, 유효 범위 밖 좌표, 잘못된 시간, 시간 역전은 거부해요.

앱 계약은 `src/shared/route-map.ts`, plain Node bridge 계약은 `packages/icloud-object-sdk/route-map.mjs`예요. SDK 테스트가 두 sanitizer의 DTO와 거부 규칙을 비교해요. 개인 지도 데이터는 코드 저장소에 보관하지 않아요.

## 변경 감지와 시간

기존 `sourceRevision`은 정제한 지도 본문을 포함한 snapshot 전체를 해시해요. 따라서 파일 크기·mtime·대시보드 수정 시각이 같아도 지도 내용이 바뀌면 서버 동기화 대상이 돼요. 정상적으로 읽은 지도 파일의 mtime도 `sourceUpdatedAt`에 반영해요.

현재 bridge의 60초 수집·사이트의 30초 새로고침 주기를 유지해요. ‘함께 반영’은 같은 정본의 변경을 양쪽이 받아보는 방식이며 두 화면이 같은 밀리초에 갱신된다는 의미는 아니에요. Mac이나 앱이 꺼져 있으면 서버에 마지막 저장된 상태가 남아요.

원본 열기의 `MEDIA_READS_ENABLED` 상태는 바꾸지 않아요. 지도 데이터를 읽기 위해 원본 영상을 읽거나 미리보기를 업로드하지 않아요. API·사이트가 지도 DTO를 받을 수 있는 버전을 먼저 배포한 뒤 bridge를 재시작해요.

## 기존 서비스에 적용

`scripts/mobile-briefing/bridge.mjs`는 시작할 때 SDK를 import하므로 SDK 수정 후 실행 중인 서비스의 재시작이 필요해요. 기존 Keychain 설정·LaunchAgent·사이트 주소를 유지해요.

```sh
launchctl kickstart -k "gui/$(id -u)/com.rosy.reels-mobile-bridge"
```

재시작 후 첫 수집 또는 다음 60초 수집에서 `Synced … content entries …`와 완료 snapshot 갱신을 확인해요. 인증정보나 registry의 로컬 경로를 로그·응답에 출력하지 않고, 상태 요약·서버의 해당 콘텐츠 지도 자산 수와 해시만 대조해요. 이 문서의 명령은 운영 적용 안내이며 이번 bridge 단위 구현에서 실행하지 않았어요.

## 검증

`node --import tsx --test tests/unit/route-map-sync.test.ts tests/unit/publishing-copy.test.ts tests/unit/local-object-store.test.ts`의 10개 검사가 통과했어요. 지도 DTO 정제와 앱 parity, 동일 크기·mtime의 본문 수정 감지, 등록 범위, 오류·중복·용량 상한의 명시적 실패, 단일 큰 지도·여러 지도 합계의 전체 payload 제한, 기존 문안/파일 범위 읽기 회귀를 검증해요. SDK와 기존 bridge의 Node 구문 검사도 통과했어요.

이는 로컬 SDK 검증이에요. 배포 사이트의 저장·응답, 서비스 재시작 후 서버 반영, 실제 화면·미디어 재생은 통합 검증에서 별도로 확인해야 해요.
