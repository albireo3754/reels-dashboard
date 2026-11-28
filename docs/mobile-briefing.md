# 모바일 제작 브리핑

현재 사이트: https://example.chatgpt.site

2026-10-28 사용자 요청으로 본인만 볼 수 있는 Sites를 만들었어요. 콘텐츠·촬영 묶음의 상태, 다음 할 일, 날짜 종류, 게시 링크와 연결 자료 메타데이터를 서버 DB에 저장하고 모바일에서 조회해요. 기존 로컬 대시보드의 공개 공유 설정은 바꾸지 않아요.

## 현재 제공

- 브리핑: 검토 대기·편집 중·게시 완료·촬영함 개수와 다음 할 일.
- 콘텐츠: 검색·단계별 필터, 상세 상태와 연결 자료 정보.
- 촬영함: 날짜별 촬영 묶음과 등록된 미디어 수.
- 로컬 앱 MCP → 소유자 전용 서버 메타데이터 동기화: 매분, 연결 상태 heartbeat: 10초.
- 마지막 완료 snapshot은 Mac이 꺼져도 서버에서 조회 가능.

사이트 소스는 [apps/mobile-briefing](../apps/mobile-briefing), 공용 React 화면과 보드 계약은 [packages/briefing](../packages/briefing)에서 관리해요. 데스크톱과 사이트 모두 주간 목표 → 소재 선정 → 오늘 볼 작업 순서로 같은 제작 현황 뷰를 조립해요. 주간 채널 카드·진행률, 소재 후보·근거, 오늘 볼 작업과 판단 기준, 프로젝트의 소스 보드를 공유해요. 데스크톱은 로컬 편집 콜백을 주입하고, 사이트는 완료된 D1 스냅샷을 읽어요. 동기화·파일 중계와 지시 큐는 기존 브리지를 사용해요.

공용 화면의 진입점은 `packages/briefing/ui.ts`, 데이터 계약은 `packages/briefing/model.ts`예요. 모바일의 원격 조회·재연결·인증 만료는 `features/briefing-sync`에서 관리하고, 페이지는 선택 상태와 화면 조립을 담당해요.

### 주간 게시 목록과 앞으로의 예약

브리지는 실행 중인 대시보드의 `reels_get_weekly_goals`가 반환한 `weeklyGoalsView` 결과에서 이번 주와 다음 주의 채널별 게시·예약 목록을 보내고, 3주차는 같은 `weekGoals`로 계산한다. 주간 목록은 제목·날짜·상태와 프로젝트 ID만 보낸다. 첫 화면의 공개 예약 목록은 같은 대시보드 예약 대기열의 `booked`와 `beyond`를 시각순으로 보낸다. 주간 게시 기록에는 지난 날짜가 보일 수 있으며, 앞으로의 예약에는 대기열에 남은 항목만 보인다. 사이트는 스냅샷의 목록 순서를 유지한다. 예약 목록 필드가 없는 이전 스냅샷을 열면 다음 동기화를 기다린다는 안내를 표시한다.

### 빌드와 배포

두 앱은 각자의 lockfile과 React 런타임을 사용해요. 새 체크아웃에서는 루트에서 `npm ci`, 사이트에서 `npm --prefix apps/mobile-briefing run install:ci`로 의존성을 설치해요.

- 데스크톱은 `npm run build` 후 `REELS_TEST_BUILT=1 npm run test:web -- tests/web/topic-selection.spec.ts tests/web/weekly-goals.spec.ts tests/web/autopilot-today.spec.ts`로 빌드 결과를 검사해요.
- 사이트는 `npm run build:site` 후 `npm --prefix apps/mobile-briefing run test:built`로 빌드된 Worker와 Chromium을 실행해요. 일회용 로컬 D1에 합성 데이터를 넣어 390px·1280px의 브리핑, 후보 펼치기, 소스 보드를 검사해요.
- 배포 소스는 `npm run audit:public` 후 `node scripts/mobile-briefing/export-site.mjs <빈-폴더>`로 만들어요. Git에서 추적하는 사이트·공용 패키지 파일의 현재 내용을 내보내므로 파일 목록과 diff를 확인해요. 기존 운영 Sites를 새 임시 체크아웃으로 열고 원격 변경을 대조한 뒤, 내보낸 소스로 맞춰요. 체크아웃의 Git과 기존 `.openai/hosting.json`을 유지하고 여기서 다시 Worker를 빌드·검증한 뒤 Sites 도구로 배포해요.
- 공개 저장소의 `hosting.local.json`에는 로컬 바인딩 이름만 있어요. 실제 사이트 ID, 접근 정책, 비밀값과 운영 DB는 기존 비공개 Sites에서 관리해요.


## 로컬 서비스

### 앱에서 사이트 열기·상태 확인 — 2026-10-28

대시보드와 설정 화면의 **모바일 브리핑** 카드에서 사이트를 열고, 동기화 서비스 연결 상태·마지막 서버 저장 시각·콘텐츠와 자료 수를 확인해요. 기존 LaunchAgent가 서버 응답으로 확인한 요약을 `mobile-bridge/status.json`에 원자적으로 기록하고, 앱은 10초마다 읽어요. 마지막 확인 후 45초가 지나거나 요청에 실패하면 연결 끊김으로 표시하며 이전 저장 시각과 사이트 열기는 유지해요. 연결됨은 서비스와 서버 간 통신 상태이며, 모든 로컬 변경이 이미 반영됐다는 뜻은 아니에요.

인증정보는 기존 Keychain에 유지해요. 앱 renderer에는 허용된 사이트 주소와 상태 요약만 전달하고, 사이트 열기는 main 프로세스에서 검증한 HTTPS Sites 주소로 수행해요. 서버 저장 시각은 로컬 파일 수정 시각이 아니라 `GET /api/briefing`의 완료 snapshot 시각이에요. 기존 선택 항목 공유 API와 본인 전용 자동 동기화는 별도로 유지해요.

검증: 타입·FSD·서비스 구문 검사, 상태 만료/주소 검증/민감 필드 제외 단위 검사, 실제 Electron IPC와 사이트 열기·오프라인 전환·설정 카드 검사, 패키징 앱의 동일 검사 통과. 새 빌드는 `release/briefing-connection/mac-arm64/Reels Dashboard.app`이에요.

`scripts/mobile-briefing/bridge.mjs`는 앱의 로컬 HTTP MCP(`REELS_MCP_URL`, 기본 `http://127.0.0.1:4319/mcp`)에 연결해 등록 자료를 읽어요. 인증정보는 macOS Keychain에 보관하고, `com.rosy.reels-mobile-bridge` 사용자 LaunchAgent가 로그인 세션에서 실행해요. 개인 경로와 기록은 앱 user-data의 `mobile-bridge` 아래에만 저장되며 사이트 소스에 커밋하지 않아요. 원본은 이동·복사하지 않아요.

`packages/icloud-object-sdk`는 등록 객체의 HeadObject/GetObject/ListObjects 형태 읽기 SDK예요. S3 HTTP/SigV4 호환 서버가 아니에요. Sites 전용 터널을 등록하는 도구가 없어, 준비한 파일 전송 경로는 요청 큐와 R2를 통한 인증된 outbound HTTPS 중계예요.

### 저화질 영상 미리보기

사이트의 `MEDIA_PREVIEWS_ENABLED`를 켜면 Mac은 heartbeat의 `previewsEnabled`를 받아 별도 `/api/bridge/preview-jobs` 큐를 조회해요. 원본 큐는 기존 `mediaEnabled`가 켜졌을 때만 조회해요. 미리보기 작업은 등록된 동영상 키와 SDK ETag가 현재 파일과 일치해야 시작해요. 변환기는 로컬 경로 대신 SDK로 연 읽기 전용 파일 디스크립터를 받아요.

`h264-540-v1`은 표시 회전을 반영해 세로 540×960, 가로 960×540 이내로 줄여요. 비율을 유지하고 작은 영상은 확대하지 않아요. H.264 yuv420p, 초당 최대 30프레임, 영상 비트레이트 상한 1.5Mbps, MP4 faststart를 사용하며 오디오 트랙이 있으면 AAC로 인코딩해요. HLG와 PQ는 `zscale`과 `tonemap`으로 BT.709 SDR로 변환해요.

기본 변환 도구는 `npm run build:editor`가 준비하는 `native/editor-engine/.build/runtime/bin/ffmpeg`와 `ffprobe`예요. 별도 바이너리는 `REELS_PREVIEW_FFMPEG` 및 `REELS_PREVIEW_FFPROBE`에 절대 경로를 지정해요. FFmpeg에는 `libx264`, `aac`, `zscale`, `tonemap`, 그리고 seek 가능한 `fd` 입력 프로토콜이 필요해요. FFprobe에도 `fd` 입력이 필요해요.

완성 파일은 `~/Library/Caches/Reels Dashboard/mobile-preview`의 사용자 전용 캐시에 저장해요. 원본 키·ETag·프리셋이 같으면 실행 중인 변환을 공유하고 이후에는 캐시로 응답해요. 변환 끝에 원본을 다시 확인하고 임시 파일을 원자적으로 확정해요. 변환 중에도 브리지의 heartbeat는 계속되며, 작업별 서버 만료시각과 최대 120초 제한 중 먼저 도달하는 시각에 변환을 중단해요. 종료·취소·실패 시 자식 프로세스와 임시 파일을 정리해요. 구간 작업은 완성된 미리보기의 ETag를 확인한 뒤 최대 2MiB까지 읽어요. 완성 파일은 브리지 재시작 뒤에도 재사용되며 자동 용량 정리나 만료 정책은 없어요.

편집기 런타임을 준비하고 Mac 브리지의 로컬 검사를 실행할 수 있어요.

```sh
node --import tsx --test tests/unit/mobile-preview.test.ts tests/unit/local-object-store.test.ts
```

## 사용자 확정 범위와 남은 확인

사용자가 **진행사항 사이트만 먼저 마무리**하도록 선택했어요. 모바일 원본 열기는 `MEDIA_READS_ENABLED`를 꺼둔 상태이며 화면에서도 준비 중으로 표시해요. 로컬 중계 검사에서는 실제 파일 구간의 일치를 확인했지만, production 상시 서비스의 파일 open은 잠긴 Mac에서 대기해 전체 원본 열기는 검증하지 못했어요. 파일 읽기를 별도 프로세스와 제한 시간으로 격리해 메타데이터 동기화가 함께 멈추지 않게 했어요.

폴더 미디어 수는 마지막 확인 기록을 유지하며 상시 서비스가 iCloud 폴더 전체를 반복 탐색하지 않아요. 원본 열기 활성화는 Mac 접근 상태와 실제 모바일 재생·다운로드를 검증한 뒤 진행해요. 자동 게시, 원본 삭제, 공개 사이트 전환은 하지 않았어요.

## 게시 문안 자동 반영 — 2026-10-28

사용자가 비타민 캡션 수정이 사이트에 보이지 않는 원인 분석·개선·반영을 요청했어요. 기존 동기화는 자료의 파일명·크기와 상태만 전송하고 문안 본문은 제외했으며, 사이트의 DB·API·화면에도 본문 경로가 없었어요.

등록 문서의 `content_id`가 콘텐츠 ID와 일치하는 경우 `캡션`·`댓글 N`·`대댓글 N`의 복사용 코드 블록만 추출해 비공개 서버에 저장해요. 콘텐츠 정본과 내부 메모는 로컬에 유지하며, 미디어 원본 열기와 무관하게 문안 조회·개별 복사가 가능해요. 문안 수정 시각과 미게시 초안 상태, 대댓글의 부모 댓글도 표시해요.

매분 문안 내용을 포함한 해시를 비교하므로 파일 크기와 대시보드 수정 시각이 같아도 문구 변경을 감지해요. 사이트는 30초마다 읽고, 열린 상세도 최신 항목을 참조해요. Mac 연결 중 변경 후 통상 1분 30초 안에 보이며, Mac이 꺼지면 마지막 동기화본을 보여줘요. 이후에도 문안 수정은 콘텐츠 정본에서 해요.

검증: 관련 SDK 단위5개, 앱·사이트 타입 검사, FSD 검사, 로컬 D1 저장/재조회·원본 열기 비활성 상태의 문안 조회, 브라우저 복사 결과·열린 상세의 자동 갱신·390px 모바일 배치. 실제 비공개 배포 성공 후 서버에서 콘텐츠 66개와 비타민의 캡션·댓글·대댓글 3개가 로컬 정본과 문자 단위로 일치함을 확인했어요. 문안이 있는 19개 콘텐츠가 저장됐어요. 원본 열기는 비활성 상태예요. 배포 도구가 반환한 새 호스트로 Keychain의 접속 URL을 갱신했고, 연결 실패 때 매초 메타데이터를 재수집하던 문제도 60초 재시도로 고쳤어요. 검증 결과는 `artifacts/mobile-bridge/publishing-copy-verification.json`에 있어요.

## 홈 화면 앱(PWA) — 2026-10-31

사용자가 다음 작업으로 홈 화면에서 앱처럼 현황 조회를 선택했어요. [이슈 #8](https://github.com/albireo3754/reels-dashboard/issues/8)에서 기존 Sites 브리핑을 기반으로 manifest·앱 아이콘·standalone 표시·설치 안내를 구현했고 로컬 타입·빌드·브라우저 검사를 통과했어요. 2026-11-17 첫 화면 UX 동기화 배포에 포함해 반영했어요. 실제 iPhone 설치·로그인 지속은 기기 확인이 필요해요.

iPhone은 Safari의 공유 메뉴에서 홈 화면에 추가하고, ‘웹 앱으로 열기’가 보이면 켜요. 지원 브라우저에는 설치 버튼을 표시해요. 앱 모드에서는 설치 안내와 긴 도입 설명을 줄여 현황을 먼저 보여줘요. 화면 복귀·연결 복구 때 다시 조회하며 기기 확인 시각과 서버 동기화 시각을 구분해요.

오프라인 캐시는 개인 데이터가 없는 연결 안내 HTML만 저장해요. 인증된 페이지·API·미디어·제작 정보는 캐시하지 않아요. 401/403/인증 리다이렉트 때에는 기존 내용과 상세를 지워요. 390px 화면·설치 이벤트·standalone 감지·오프라인 재열기·온라인 복구·인증 거부·캐시 경계를 자동 검증했으며 실제 iPhone 홈 화면 설치·로그인 유지는 별도 기기 확인이 필요해요.

모바일 원본 열기는 [이슈 #13](https://github.com/albireo3754/reels-dashboard/issues/13)으로 분리했고 아직 비활성이에요. 기존 사이트의 허용 사용자 범위도 유지해요. 자세한 설치/검증은 별도 사이트 저장소의 `docs/home-screen.md`를 따라요.


## 데스크톱 첫 화면 UX 동기화 — 2026-11-17

사용자 요청으로 모바일 모니터링도 작업 중심 첫 화면으로 맞췄다. 소개 문구를 줄이고 진행 중·검토 대기·완료 요약, 이번/다음 주 채널 목표, 영상 2주 예약 현황, 퇴근 후 오늘 볼 1개를 표시한다. 콘텐츠 보드에는 진행 중 기본 보기, 채널·종류 필터, 사용자 작업 순서·날짜·제목 정렬, 목록/카드 전환과 채널별 임시저장·예약·게시 상태를 추가했다.

동기화가 예전 단계/문안/자료 필드만 보내고 사이트의 strict 스키마가 `done`을 거부하던 문제를 고쳤다. 브리지는 `scripts/mobile-briefing/monitor.ts`에서 데스크톱의 상태·주간 목표·오늘 항목 계산을 재사용하고, 허용된 결과만 서버에 보낸다. 계획/자동 작업 상태 변경도 snapshot 해시에 포함하므로 프로젝트 수정 시각이 같아도 갱신한다. 기존 1분 동기화·30초 화면 갱신과 마지막 완료 snapshot 표시를 유지한다.

검증과 배포 결과는 아래 완료 기록 및 별도 사이트의 `docs/architecture.md`를 따른다. 실제 앱 88개 프로젝트가 새 저장 계약을 통과했다. 실제 iPhone 설치/로그인 지속은 브라우저 에뮬레이션 검증과 구분한다.


완료 확인(2026-11-17): 사이트 소스 `55bec851e145315ec515706e58f401c1b2308111`, 기존 owner-only 배포 성공. 자동 동기화 서비스를 재시작한 뒤 실제 서버에서 프로젝트 88개·연결 자료 745개를 확인했고, 주간 목표·오늘 볼 항목·프로젝트별 종류/순서/채널 상태·게시 문안이 로컬 완료 snapshot과 일치했다. 상태는 진행 중 46·검토 대기 8·채널 남음 3·공개 예약 대기 2·완료 29개다. 390px·1280px headless 브라우저와 타입/빌드/단위/FSD 검사, 기존 문안·지도·PWA 회귀를 통과했다. 검증 영수증은 `artifacts/mobile-bridge/monitor-parity-verification.json`, 화면 근거는 별도 사이트의 `artifacts/monitor`에 보관했다. 실제 모바일 하드웨어의 설치/로그인 지속은 미검증이다.


### 「Linear 사본이 오래됐어요 — 자동 실행 멈춤」 진단 — 2026-11-17

사용자 후속 질문에 대해 21:45 KST의 실제 상태와 tick 코드를 확인했다. Linear 마지막 조회는 18:20:46 KST로 약 205분 전이었고, 최신성 기준 180분을 넘었다. 자동 tick은 30분마다 정상 종료하지만 활성 시간 09:00~18:30 KST 밖에서는 Linear 갱신보다 먼저 반환한다. 실제 최근 tick(21:20)의 결과도 `outside_hours`이며 일시정지는 없다. 모바일 연결과 요약 동기화는 계속되고 있다.

따라서 이 문구는 Linear 서비스 장애를 확인한 결과가 아니라, 야간 조회 중단으로 낡아진 로컬 사본을 freshness 검사에서 표시한 것이다. 화면의 경고는 최근 tick의 시간 외 대기 사유를 구분하지 않아 오해를 부른다. 이 턴은 설명·진단 범위로 운영 시간, 자동 실행, Linear 조회 및 화면 코드는 변경하지 않았다. 이후 개선 시 조회 갱신과 자동 작업 시간의 분리, 시간 외 대기/마지막 조회 시각의 명확한 표시를 검토한다.


### 야간 조회 운영 변경 — 2026-11-17 후속

사용자 요청으로 Linear 조회를 자동 작업 시간에서 분리했다. 기존 30분 tick이 밤에도 사본 나이를 확인하고, 기본 90분 이상 지났으면 모델 없이 Linear 읽기 API로 갱신한다. 모델 작업은 기존 09:00~18:30 KST 안에서만 시작한다. 모바일 브리지는 새 사본을 다음 메타데이터 동기화에 반영하므로, 조회 성공 뒤 오래된 사본 경고가 사라진다. 위 진단의 야간 조회 중단은 변경 전 동작이며 현재 규칙은 이 절과 `docs/autopilot.md`가 정본이다.

운영 검증 완료: 2026-11-17 21:50 KST 야간 tick에서 Linear 사본 갱신 성공(이슈 5개), 모델 호출·새 작업 예약 모두 0건. 21:51에는 실제 모바일 서버의 새 요약을 확인했고 `notice: null`로 오래된 사본 경고가 해소됐다. 기존 30분 LaunchAgent가 새 CLI를 사용한다. 영수증: `artifacts/autopilot/overnight-refresh-20261117.json`, `artifacts/autopilot/overnight-mobile-verification-20261117.json`.


## Sites 지시 기능 — 2026-11-21

휴대폰 Sites에서 보낸 자유 문장 지시를 Mac 브리지가 가져가(claim) 보이는 Paseo 에이전트로 실행하고, 검증한 결과만 Sites로 돌려준다. 이 절은 브리지(Mac) 쪽 구현이다. 사이트 API·D1·화면은 별도 사이트 저장소가 맡고, 둘은 같은 계약(claim·status·heartbeat)을 따른다. 코드: `scripts/mobile-briefing/instructions.ts`(실행기·원장·결과 검증), `bridge.mjs`(연결), 테스트 `tests/unit/mobile-bridge-instructions.test.ts`.

누가 지시할 수 있나(2026-11-21 사용자 결정): 사이트에 접근할 수 있는 사람이면 누구나 지시할 수 있다. 별도 소유자 allowlist는 없고, 사이트 접근 정책이 곧 실행 권한이다. 사이트에 다른 사람을 추가하면 그 사람도 이 Mac에서 에이전트를 실행할 수 있다.

### 로컬 스위치와 설정

`<user-data>/mobile-bridge/instructions.json`(`<user-data>` = `~/Library/Application Support/Reels Dashboard`). 파일이 없으면 꺼짐이다. 모르는 키, 형식이 틀린 값, `bypass`·`full-access` 류 mode가 있으면 설정 전체를 꺼짐으로 읽는다(fail closed).

| 키 | 기본값 | 뜻 |
|---|---|---|
| `enabled` | `false` | 로컬 스위치. claim 직전과 launch 직전에 다시 읽는다 |
| `maxActive` | `1` | 동시 실행 한도(0~2). 서버 한도와 작은 쪽이 적용된다 |
| `launcher` | `paseo` | `paseo`가 아니면 실행하지 않는다. Herdr는 구현하지 않았다 |
| `provider`/`model`/`mode` | `claude`/`claude-sonnet-5-5`/`auto` | `paseo run --provider --model --mode`로 넘긴다 |
| `cwd` | `~/Obsidian` | 기본 작업 폴더. 서버가 보낸 값은 cwd에 쓰지 않는다 |
| `preMergeCwd` | `~/side/reels-dashboard` | 끝이 `pre_merge`일 때 `--new-workspace worktree`로 독립 worktree를 만든다. 실패하면 메인 트리에서 대신 실행하지 않고 `failed` |
| `stopAfterMinutes` | `0` | 0이면 오래 걸려도 멈추지 않고 `running`을 유지하며 자리를 계속 차지한다(화면이 `started_at` 경과로 지연 표시). 0보다 크면 그 시간 뒤 `paseo stop` 후 `failed TIMEOUT` |
| `pollSeconds` | `15` | `paseo inspect` 폴링 간격(10~30) |
| `retentionDays` | `7` | 보고까지 끝난 지시 폴더를 지우는 기간 |

### 준비 검사와 heartbeat

브리지는 별도 루프에서 10초마다 검사한다. 미디어 기능(`mediaEnabled`)이 꺼져 있어도 이 루프는 돈다. heartbeat 본문은 `{instructions:{ready, reason?}}`이다.

1. 스위치·설정 → 아니면 `disabled`. 꺼져 있고 원장에 남은 일이 없으면 Paseo를 부르지도 않는다.
2. 화면 잠김 → `locked`(claim하지 않음).
3. `paseo status --json`이 `localDaemon: running`, `connectedDaemon: reachable`(1회 재시도) → 아니면 `launcher_down`.
4. 남은 자리 > 0 → 아니면 `busy`. 다른 브리지 프로세스가 원장 잠금(`instructions/.dispatch.lock`)을 쥐고 있어도 `busy`.

준비되면 `POST /api/bridge/instructions/claim {capacity: 남은 자리}`.

**잠김 판정.** 본문 없이 로컬에서 `/usr/sbin/ioreg -n Root -d1 -a`를 읽고 `plutil -extract`로 `IOConsoleUsers`·`IOConsoleLocked`만 꺼낸다. 현재 uid의 세션이 없거나, 콘솔에 있지 않거나(사용자 전환), 로그인이 끝나지 않았거나, `CGSSessionScreenIsLocked`가 true거나, `IOConsoleLocked`가 true면 잠김이다. 명령 실패·파싱 실패처럼 **판정을 못 하면 잠김으로 본다**(claim하지 않고 `locked`). 2026-11-21에 잠기지 않은 상태에서 `unlocked` 판정을 확인했다. 실제 잠금 상태의 값은 실기에서 확인하지 않았다.

### 한 번만 실행

1. claim 직후 `<user-data>/mobile-bridge/instructions/<id>/state.json`(폴더 0700, 파일 0600, 임시 파일→rename)을 먼저 쓴다. 이 기록이 실패하면 실행하지 않고 `failed`.
2. 본문은 `instruction.md`(0600)에만 쓴다. `paseo run` 인자에는 고정 머리말과 파일 경로만 들어간다. 로그에는 `instruction <id> <코드>`만 남는다.
3. `phase: launching`을 기록한 뒤 `paseo run --no-wait --json --title sites-<id 앞 8자> --label source=sites --label instruction=<id>`. agent id를 기록하고 `running`을 보고한다.
4. 자리는 원장 기준으로 센다. agent id가 있는 지시는 `inspect`가 끝남(대기 중인 권한 요청 없이 `idle`·`closed`·`error` 또는 보관됨)을 보일 때까지 자리를 차지한다. 확인이 안 되는 동안에도 차지한다. 권한 대기로 `needs_user`를 보고한 뒤, TIMEOUT 뒤, 사이트가 claim 유실로 `running` 보고를 거절한 뒤에도 에이전트를 계속 확인하며, 끝난 것을 본 다음에야 다음 지시를 가져간다.
   - 상태 보고의 409는 응답 본문의 현재 `status`·`error_code`로 나눈다. 사이트가 이미 보낸 상태(`running`이면 그 뒤 상태도)를 갖고 있으면 앞선 보고가 반영되고 응답만 유실된 것으로 보고 성공 처리한다(`REPORT_ACKED`, 최종 보고도 같다). `failed` + `CLAIM_LOST`면 claim 유실(`CLAIM_LOST`), 그 밖과 본문에 상태가 없는 409는 거절이다. claim 유실·거절된 지시는 원장에 `rejected`로 남기고 최종 결과는 보내지 않는다. 에이전트 추적과 자리 점유는 그대로다.
5. dispatch 잠금(`instructions/.dispatch.lock`, `<pid>:<uuid>`)은 매 tick과 claim 직전에 내 토큰인지 다시 확인한다. 죽은 프로세스의 잠금은 별도 O_EXCL `.dispatch.lock.takeover` 파일을 쥔 프로세스 하나만 원자 rename으로 바꿀 수 있다. takeover 파일을 쥔 프로세스가 죽어 그 파일이 남으면 브리지는 자동으로 지우지 않고 `busy`로 멈춘다(로그 `STALE_TAKEOVER`). 정리 방법은 아래 「운영자 정리」.
6. 브리지가 다시 떴을 때 agent id가 없는 기록은 **다시 띄우지 않는다.** `paseo ls -a -g --label instruction=<id>`로 정확히 하나를 찾으면 adopt한다. launch가 응답 없이 실패한 경우도 같은 label 조회로 먼저 adopt를 시도한다. adopt하지 못하면 사이트에는 `failed LAUNCH_FAILED`(고정 요약)를 보내되 원장에서 두 경우를 나눈다.
   - **실행 안 됨 확정**: launch를 시작하기 전(`phase: claimed`)이었거나, label 조회가 성공했고 세션이 0개. 자리를 바로 푼다.
   - **불확실**(`launchUncertain`): 조회가 실패했거나 세션이 둘 이상. agent id가 없어도 자리를 계속 차지하고 보관 기간 정리에서도 빠진다. 매 tick label을 다시 조회해 정확히 하나가 보이면 adopt하고 그 에이전트가 끝날 때까지 추적한 뒤 자리를 푼다. 사이트에는 더 보고하지 않는다.

### 운영자 정리

- **불확실한 launch가 자리를 잡고 있을 때**(heartbeat `busy`, 로그 `LAUNCH_UNCERTAIN`): `paseo ls -a -g --label instruction=<id>`로 그 지시의 세션이 없거나 이미 끝났음을 확인한다(둘 이상이면 Paseo에서 정리·보관). 그다음 `<user-data>/mobile-bridge/instructions/<id>/` 폴더를 지우거나 다른 곳으로 옮긴다. 브리지는 다음 tick에 원장을 다시 읽어 자리를 푼다(브리지가 돌고 있어도 된다).
- **`STALE_TAKEOVER`**: `pgrep -fl mobile-briefing/bridge.mjs`로 브리지 프로세스를 확인하고, `<user-data>/mobile-bridge/instructions/.dispatch.lock.takeover` 안의 pid가 살아 있지 않음을 확인한 뒤 그 파일만 지운다. 다음 tick에 잠금 회수가 다시 시도된다.

### 결과 회수

`paseo inspect --json`의 `Status`·`PendingPermissions`와 검증된 `result.json`의 교집합으로 정한다.

- 권한 요청이 걸려 있으면 자동 허용하지 않고 `needs_user`(질문: Paseo 세션에서 권한 요청 확인).
- idle인데 결과 파일이 없으면 30초 기다린 뒤 `paseo send --prompt-file`로 형식 재요청을 **한 번** 보낸다. 그래도 없으면 `failed RESULT_MISSING`. 형식 오류는 `RESULT_INVALID`, 결과 없이 `error` 상태면 `AGENT_FAILED`.
- 결과 파일은 연 뒤에 폴더가 여전히 진짜 폴더(링크 아님, 같은 realpath)인지와 열린 파일의 dev/ino가 지금 그 경로의 파일과 같은지 다시 확인한다. 에이전트가 같은 uid로 돌기 때문에 이 검사는 브리지가 엉뚱한 파일을 읽어 올리는 것을 막을 뿐이고, 요약 내용 자체는 원래 에이전트가 정한다.
- 스키마(strict, 16 KiB 이하, symlink·폴더 이탈·FIFO 거부, UTF-8): `{schemaVersion:1, instructionId, attemptId, status:'done'|'needs_user'|'failed', summaryLines:[1~10줄, 줄당 200자], question?(needs_user일 때만·필수, 500자), verification:'passed'|'failed'|'not_run'}`. `attemptId`는 claim마다 브리지가 새로 만든다.
- 요약 각 줄에 제어·서식 문자, POSIX·home·file URI·Windows·UNC 경로, 토큰 모양(`sk-`, `ghp_`, JWT, `token:` 류, 32자 이상 연속 영숫자)이 보이면 그 줄을 "(경로·민감 문자열이 있어 가렸어요)"로 바꾼다. 의심스러운 질문은 "Paseo 세션 …에서 질문을 확인해 주세요."로 바꾼다. 요약 끝 줄은 `검증: 통과|실패|하지 않음`이고 에이전트 줄은 최대 9줄까지 쓴다.
- Sites로 가는 것: 상태, 요약, 질문, 세션 이름(`sites-<id 앞 8자>`), 오류 코드. agent id·cwd·경로·로그·에이전트 출력은 보내지 않는다.
- 상태 업로드가 네트워크·5xx·429로 실패하면 같은 결과만 다음 tick에 다시 보낸다. 409는 위 「한 번만 실행」 4번 규칙으로 나누고, 400·404는 서버가 거절한 것으로 보고 기록만 한다. 실행은 다시 하지 않는다.

### 자격과 로컬 E2E

운영은 기존과 같이 Keychain에서 URL·키를 읽는다. 테스트·로컬 E2E는 `REELS_BRIDGE_URL`(https, 또는 loopback http) + `REELS_BRIDGE_KEY_FILE`(0600 일반 파일)로 주입하고, `REELS_BRIDGE_DATA_DIR`로 user-data 위치를 바꿀 수 있다. Paseo CLI에는 `PATH`·`LANG`·`HOME`·`USER`·`LOGNAME`·`TMPDIR`만 넘기고 `--env`는 쓰지 않는다.

사이트 로컬 dev와 가짜 실행기로 왕복(실제 Paseo 기동 없음, 임시 폴더만 사용):

```sh
REELS_BRIDGE_URL=http://127.0.0.1:<port> REELS_BRIDGE_KEY_FILE=<0600 키 파일> \
  node --import tsx scripts/mobile-briefing/instructions-e2e.ts 90
```

지시 본문에 `[fake:needs_user]`·`[fake:failed]`·`[fake:missing]` 등을 넣으면 가짜 에이전트의 결과를 고를 수 있다(기본 done).

### 로컬 왕복 확인 — 2026-11-21

로컬 사이트 dev(loopback)와 임시 user-data로 확인했다. 운영 Keychain·Sites·LaunchAgent는 쓰지 않았다.

- 가짜 실행기(`instructions-e2e.ts`): 사이트 API로 만든 지시 2건이 claim → running → done / needs_user로 끝나고, 사이트 목록에 상태·요약·질문·세션 이름이 표시됐다.
- 실제 `bridge.mjs` + 실제 Paseo, 읽기 전용 지시 1건: `--mode auto`와 `claude-sonnet-5-5`가 그대로 적용됐다(`inspect`의 `Mode: auto`). 세션 제목은 `sites-<id 앞 8자>`. 권한 요청 없이 cwd 밖 결과 폴더의 `instruction.md`를 읽고 `result.json`을 썼다. 재요청 없이 약 40초 만에 `done`. 관측한 `inspect` 상태 이름은 `running`, `idle`이고 보관 처리 뒤에는 `closed`였다. 작업 폴더에는 변경이 없었다.

### 남은 확인

- `--new-workspace worktree`(`pre_merge`) 실제 생성, LaunchAgent로 띄운 브리지에서의 실행.
- 잠긴 Mac에서의 `ioreg` 값 실측.
- 응답 유실 뒤 label 조회도 실패한 경우는 계약상 코드가 없어 `LAUNCH_FAILED`로 보낸다(요약에 "실행 여부를 확인하지 못했어요"). 별도 `LAUNCH_UNCERTAIN` 코드는 계약 변경이 필요하다.
- 본문은 `instruction.md`와 Paseo·provider의 세션 기록에도 남는다(브리지 로그·argv·Sites 결과에는 없음).

## 소스 보드

카드 하나에 순위별 소재 최대 40개를 저장한다. 모바일 첫 화면의 **소스 보드**에서 카드를 열거나 콘텐츠 상세에서 소재를 펼치면 촬영 상황과 Instagram 레퍼런스(최대 3개)를 볼 수 있다. 계약은 [source-board.ts](../src/shared/source-board.ts)에 있고, 브리지가 보드가 있는 카드만 `monitor.sourceBoards[]`에 담는다.

`reels get-source-board --project-id <카드 ID>`가 돌려준 `data.updatedAt`을 쓰기 요청의 `expectedUpdatedAt`으로 넣는다. `reels set-source-board --input-file <요청.json>`은 `{projectId, expectedUpdatedAt, board}`를 받는다. `board: null`이면 삭제한다. MCP 이름은 `reels_get_source_board`와 `reels_set_source_board`다. 보드에 로컬 경로·파일명·인증정보를 적지 않는다.
