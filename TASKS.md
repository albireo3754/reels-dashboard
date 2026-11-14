# Reels Dashboard 진행 상태

## Edits 외부 앱 자동화 — 2026-11-14

- [x] main 기준 격리 worktree에서 TS 서비스·공통 MCP/CLI 도구·edits 필터·main 주입 경로 작성. 앱을 우회하는 독립 CLI/helper 실행 경로 없음.
- [x] dryRun·stale/모호성·실제 후조건·DB 읽기 전용 경계 및 금지 동작 계약. [사용법·구현/실기 검증 구분](docs/edits-automation.md).
- [x] native 전담 47개 순수 테스트·release 빌드 인계, Developer ID 서명·원자 배치, background Dashboard status/읽기/dryRun 스모크. 실기 -25200 진단과 한정 Subrole 부재 정책 후속 읽기는 root cycle로 incomplete였다. 쓰기 guard를 유지하고 새 근거로 native 원인 분석을 이어간다.
- [ ] terra 독립 코드리뷰·최신 main 통합/재검증·main 병합·빌드 반영.
- [ ] 실제 GUI 수용: 관찰된 Mac 잠금 때문에 잠금 해제 전 live AX/음악/앱 UI 검사를 대기. 마지막 목록은 clips=0·complete=false, 원인 미확정·일반 설치 앱 TCC 미검증. 잠금 해제/로그인/질문 화면 조작 없이 독립 코드/통합/패키징을 진행.

## Instagram headless CLI 적대적 리뷰 보강 — 2026-11-14

- [x] 기존 `prepare-media`/render/status의 오류 계약과 비교: 저장 전 실패와 SIGTERM은 `not_applied`, 저장 시작 뒤는 `unknown`, history 교체 뒤는 `applied`. 불확실한 결과에는 같은 프로필의 앱을 연 뒤 조회하는 `next`/`hint`, busy에는 기존 `retry: wait`와 소유 프로세스 확인 안내를 제공.
- [x] 인증 만료·취소는 Codex에 Instagram 조회 토큰 갱신 요청을 안내(message/CLI hint). 기존 비공개 파일·계정 연결 경로를 유지하며 OAuth·자동 갱신·실토큰 교체는 추가하지 않음.
- [x] SDK의 credential-bearing permalink query/fragment가 저장·반환되던 경로를 공개 게시물 URL로 정규화. `REELS_DEMO=1` CLI의 비공개 수집을 차단. 내장 CLI skill에 앱 없는 수집 경로와 복구 절차 반영.
- [x] 관련 단위/기존 CLI 99개 중 98 통과·fish 미설치 1 skip, 독립 CLI 번들 4개, background Electron 관련 7개(headless 5·기존 연동/데모 2) 통과. 타입/FSD/build/public audit/diff 검사 통과. 저장 실패에서도 기존 index 바이트 보존과 앱 필요 조건을 명시한 복구 지침을 확인.
- [x] Astra(gpt-6-astra) 적대적 리뷰 수정 뒤 root 통합 확인: 새 패키지 background Electron 7개·최신 독립 CLI 번들 4개 통과. 검증한 설치본을 기존 경로에 백업 없이 갱신·재실행하고 운영 토큰·연결 설정·history/snapshot 및 다른 세션 변경 보존 확인. main 로컬 병합, origin push 없음.
- 제한: SIGKILL 뒤 잠금 수동 확인 계약 유지. 개별 파일 atomic rename은 보장하지만 snapshot+history 두 파일의 트랜잭션은 아니므로 실패 시 참조 없는 새 snapshot이 남을 수 있음. 기존 history를 덮어 지우지 않으며 자동 재시도·새 DB·대체 스케줄러는 추가하지 않음. 실계정 API·운영 토큰·main의 다른 세션 변경은 건드리지 않음.

## Instagram headless 1회 수집 · Codex 예약 등록 차단 — 2026-11-14

- [x] main 기준 새 worktree에서 사용자가 승인한 미커밋 Instagram 선행 변경만 기반 커밋으로 보존. OpenCut과 다른 세션의 작업은 포함하지 않음.
- [x] 앱 없이 완료까지 기다리는 `reels collect-instagram-insights --source manual|scheduled`. 기존 private history/UUID snapshot·프로필 경로 유지, 출처·시각·릴스 시청시간/스킵률 저장, 앱/CLI 간 파일 잠금과 화면 갱신.
- [x] 인증/권한/제한/네트워크별 고정 오류·nonzero 종료, 자동 재시도 없음·이전 성공 보존·SIGTERM 잠금 정리. 확인된 만료 시각의 7일 경고와 미확인 상태를 실제 인증 거부와 구분.
- [x] diff 코드 검토, 타입/FSD/빌드/공개 소스 검사, 전체 단위 637개(632 통과·5 조건부 skip), headless 웹 3개, background Electron 관련 5개 및 새 패키지 같은 5개, 독립 CLI 번들 4개 통과. 기존 Photos `verify:spec` 해시 불일치는 변경 전 main과 같은 파일·해시임을 확인했으며 이번 범위에서 변경하지 않음.
- [ ] Codex 예약 등록·다음 실행·실패 알림 확인: 이 세션에 scheduler 생성/조회 도구가 없고 Codex UI 접근도 차단됨. 미등록 상태를 유지하며 대체 스케줄러를 만들지 않음. 제안 설정: 매일 09:00 Asia/Seoul, `reels collect-instagram-insights --source scheduled`.
- [x] 운영 앱이 idle인 것을 확인하고 종료한 뒤 새 패키지 CLI로 실계정 1회 수집 성공(29개). 기존 dashboard·연결 설정·이전 snapshot 해시 불변, history에 새 UUID 추가와 릴스 시청시간/스킵률 필드 확인. 개인 ID/시각 증거는 저장소 밖 비공개 검증 폴더에 보관. 새 패키지를 기존 설치 경로에 백업 없이 적용·재실행. main에 로컬 병합하며 origin push는 하지 않음. [CLI·잠금·예약 상태](docs/instagram-insights.md#앱-없이-1회-수집--2026-11-14).

## Photos 묶음 가져오기(관련 데이터 기본 묶음) — 2026-11-13

배경: 사용자 지시 "사진도 가져와. 블로그 때문에 관련된 데이터는 다 묶어서 가져오는 걸 기본으로". 기존에는 영상 1개씩(`reels_import_photos_video`) 가져와 카드가 영상마다 생겼고, 사진은 inspect 미리보기로만 썼다.

- [x] native `media.materialize`: `editor.materialize`와 같은 인자·권한·그룹·index-run 검사로 사진·영상 모두 private `editor-sources/<UUID>/`에 복사. Live Photo는 원본 motion(`.pairedVideo`, 없으면 `.fullSizePairedVideo`)도 같은 폴더에 복사. PhotoKit은 resource 데이터 요청만. Swift 테스트 5개 추가.
- [x] MCP·CLI `reels_import_photos_bundle`(`reels import-photos-bundle`): 입력 `projectId`·`groupId`·`indexRunId`·선택 `assetIds`. 영상은 카드 없는 편집 프로젝트로 만들어 대상 카드 `production.edits`에 연결, 사진·Live Photo 영상은 `footage` 자료로 등록. 카드 단계·다음 할 일은 바꾸지 않음.
- [x] 멱등: 프로필 `photos-imports.json` ledger(공개 asset ID 기준). 단일 영상 가져오기도 ledger에 기록. 파일·편집이 사라진 항목만 다시 복사. 다른 카드에 이미 연결된 영상은 `linked-elsewhere`로 보고하고 옮기지 않음.
- [x] 교차 리뷰(eris) 반영: 복사본을 편집 생성 전에 ledger에 기록(편집 실패 시 재복사 없이 편집만 재시도), 다른 카드 소유 영상은 복사 전에 `linked-elsewhere`, 같은 카드 재복사는 사라진 footage·죽은 편집을 교체, 500개 상한을 복사 전에 검사, 단일 영상 ledger 기록은 기다리지 않고 유효 항목을 덮지 않음, 편집 존재는 디스크로 확인, `REELS_PHOTOS_DEMO_QA`는 `REELS_USER_DATA`가 있을 때만. 남은 판단: Live Photo 영상 복사만 실패해도 사진까지 `failed`(재실행으로 복구).
- [x] 검증: 단위 `tests/unit/photos-bundle.test.ts`(12), `photos-copy-default`에 새 도구 분류, e2e `tests/electron/photos-bundle.spec.ts`(REELS_DEMO 합성 Photos, `REELS_EDITOR_QA=1`). 실제 Photos 보관함 QA는 하지 않음.
- 문서: [MCP](docs/mcp-usage.md#photos-bundle-import-default-for-blog-and-reels-material)·[인터페이스](docs/agent-interface.md)·[CLI 스킬](skills/reels-cli/SKILL.md)·[native README](native/photosindex/README.md).

## Photos 원본 기본 불변(복사 기본) — 2026-11-13

배경: 사용자 지시 "대시보드로 영상 정리할 때 기존 Photos는 손대지 마라". 처음에는 move 제거를 검토했으나 사용자 정정으로 move는 그대로 두고 복사를 기본으로 했다.

- [x] 조사: PhotoKit 쓰기는 `PhotoKitAssetDeleter`(move 전용) 한 곳뿐이고, 색인·검색·검사는 읽기만 하며 영상 가져오기(`reels_import_photos_video`·`editor.fromPhotos`)는 앱 저장소로 복사한다. MCP·CLI·워크플로에는 move 실행 도구가 없다.
- [x] UI: `복사 계획 만들기`를 primary로, `이동 계획 만들기`는 보조 버튼과 설명으로 구분. 전송 화면에 "복사 내보내기 (기본)"·"검증 후 이동 (직접 고를 때만)" 표기. 기존 이동 확인 체크·native 확인창(기본 취소)은 유지.
- [x] MCP 안내·`reels_import_photos_video` 설명에 "Photos 원본은 기본적으로 그대로, 가져오기는 복사"를 명시. [MCP](docs/mcp-usage.md#photos-and-limits)·[인터페이스](docs/agent-interface.md)·[UI 명세](docs/photosindex-ui-spec.md#5-복사이동복구-ux)·README 반영.
- [x] 회귀 검사: `tests/unit/photos-copy-default.test.ts`(Photos 도구는 읽기 메서드만, 가져오기는 복사, move 실행 도구 없음, 복사 버튼 primary, move 확인창 기본 취소, PhotoKit 쓰기는 move 경로에만), web `copy is the default plan…`.
- 범위 밖: move·deleter 코드와 기존 pending move 복구는 변경하지 않음. 실제 Photos 보관함 쓰기 QA는 하지 않음.

## Instagram 인사이트 연결 — 2026-11-13

- [x] 기존 조회 SDK에 명시적 Unified Login·소유 계정 ID 확인·v27·배치 조회·날짜 정규화·인증/요청 제한 중단을 연결. 계정별 기본값·토큰 값·운영 데이터를 공개 소스에 넣지 않음.
- [x] 데스크톱 **Instagram 인사이트** 화면, 조회 토큰 파일 선택, 비동기 수동 수집, 비공개 불변 기록·재열기, 콘텐츠 URL 연결, 주제 분류, 48시간·기간 제외, 반응/저장/공유율·요일/시간대/주제 비교. 공유 snapshot 제외.
- [x] MCP/CLI 조회·수집 시작·주제 부분 변경. 불확실한 시작 재시도 없음, 인증·요청 제한·전체 지표 실패 때 마지막 성공 기록 유지.
- [x] 타입/FSD/빌드/공개 소스 검사 통과. 전체 단위 619개 중 614 통과·5 조건부 skip·실패 0(초기 macOS locale 실패는 UTF-8 locale을 지정해 재실행). 웹 9개 및 날짜 필드 배치 조정 후 해당 화면 2개 재검증. background Electron IPC/MCP/비공개 저장·재열기, 패키지 앱의 데모/비공개 프로필 분리 2개 통과. 소유 실계정의 앱 서비스 수집·패키지 UI 표시도 확인했고 개인 증거는 공개 저장소 밖에 보관.
- [x] main 기준 코드와 이번 변경만 격리한 폴더에서 패키지 생성, 진행 중 OpenCut 미커밋 변경 제외 확인. `release/pending/instagram-20261113/Reels Dashboard.app`에 적용할 설치본 준비.
- [x] 2026-11-14 운영 설치본 확인·실행 완료. 11/13 23:35 설치본에 Instagram 연동과 이후 Photos·블로그 변경이 이미 포함돼 있어 이전 대기 패키지로 덮어쓰지 않음. 해당 설치본의 background Electron 검증 2개 통과, 실제 화면과 CLI에서 게시물 29개·연결 정상 확인. 대시보드 80개·편집 프로젝트 51개를 유지했고 dashboard·Instagram 설정/기록 파일 해시도 실행 전후 동일. 사용자 정정에 따라 설치본 백업은 만들지 않았고 이후에도 별도 요청 없이 만들지 않도록 `AGENTS.md`에 기록. OAuth 자체 발급·자동 수집 예약·외부 게시·push는 범위 밖. [계약과 사용법](docs/instagram-insights.md).

## main 통합·정식 경로 패키지 실행 — 2026-11-13

- [x] 남은 콘텐츠 평가 이력·OpenCut 준비 변경을 main `a1d84dc`에 통합. 미병합 로컬 브랜치 없음. 별도 build worktree는 같은 기존 main에서 만든 무변경 빌드용 checkout이었으며 새 코드가 없었음.
- [x] 정본 checkout에서 `npm run package:mac`으로 웹·Electron·PhotosIndex·편집 엔진을 다시 빌드. 기존 main 패키지를 `release/backups/main-before-20261113-161423`에 보존하고 새 패키지는 `release/mac-arm64/Reels Dashboard.app`에 생성.
- [x] 패키지 UI·IPC·저장/재열기 8개 통과·opt-in 2개 skip. 검토 엔진 1개는 테스트 프로세스의 OpenTelemetry CJS 로딩 오류 후 `NODE_OPTIONS=--require=@opentelemetry/api`로 재실행 통과. 타입/FSD·작업본/전체 이력 공개 소스 검사·공개 감사/OpenCut 단위6개 통과. 직전 전체 단위607 통과·5 skip 결과를 재사용.
- [x] 기존 worktree 앱 정상 종료 → main 패키지 실제 실행. 같은 사용자 profile 유지, 편집 엔진 준비·앱 online 확인. 앱의 관리형 `reels` 런처도 main 패키지 경로로 갱신됐고 doctor의 런타임·프로필·앱·런처·PATH 검사 통과.
- [x] 패키지 `main.cjs`·CLI 바이트와 main 빌드 출력의 해시 일치. 운영 콘텐츠 쓰기·외부 게시·push는 하지 않음. 앞 절의 평가 수집 기능은 이 패키지부터 적용됨.


## 블로그 저장 이력·콘텐츠 평가 파이프라인 — 2026-11-13

- [x] 실제 마크업 저장 경로에 불변 원문 revision·정확한 diff·저장 시도/영수증을 추가. no-op, 중복 피드백, 중단 복구, 외부 변경의 unknown 관측, 기존 병합·충돌 사본 보존. 오래된 base를 불변 이력에서 복구하면 이전 중간 수정도 충돌로 정확히 보고.
- [x] 검토 제안 유지·적용 의도, 명시적 ghost 수락·닫기, 주석을 자동 기록. 프로젝트/원고/revision/제안·실행 출처 연결. 이유는 선택, 자동 gold 승격 없음.
- [x] 개인 자료 명시 import→YAML/CSV, 후보/확정·개발/holdout 계약, 동결 입력/문서/스킬/역할, 기존 런타임 adapter 계약, 재시도·중단·증거·사용량, 범위별 ID judge와 pair 비교. 합성 demo와 과거 결과 adapter 제공.
- [x] 개인 데이터 위치에 실제 19개 출처→281개 미확정 raw record, 후보 3개와 과거 실험 3종 연결. 재수집 신규 0·중복 281·오류 0. 개인 사례를 포함한 학습 HTML·용어집·구조/시퀀스·공식 자료 링크는 공개 저장소 밖에 보관.
- [x] 검증: 전체 단위 612개 중 607 통과·5 조건부 skip·실패 0(동시 4), 타입/FSD/공개 소스/웹·desktop 빌드 통과. headless 웹 10개 통과·기존 팝오버 간섭 1개 실패 후 해당 검사+신규 저장 검사 재실행 2개 통과. background Electron 블로그 탭 6개 통과.
- [ ] 기존 `verify:spec` Swift `AppCommandRouterTests.swift` 기준 해시 불일치 유지(해당 파일 미변경). 운영 앱 교체·재시작, 신규 모델 품질 실험, 네이버 직접 편집 실시간 수집은 하지 않음. 새 빌드 적용 후 실제 저장 수집 시작.
- [계약·사용법·관측 한계](docs/content-evals.md). `npm run evals:demo`는 모델을 호출하지 않는다.


## OpenCut 자막 소개 템플릿 연결 — 2026-11-12

- [x] 공통 여행·맛집 스타일, 컷과 자막의 독립 시간표, 정지사진3초 제한, 재생속도에 따른 원본 구간 계산.
- [x] `npm run opencut:prepare -- request.json`: 등록 원고·촬영본 검증/사본 준비, 원고 해시·레시피·SRT·OpenCut 적용 스크립트 생성, 기존 API로 같은 Dashboard 프로젝트에 자료 연결. 네이티브 앱 재시작 없이 실제 등록 확인.
- [x] OpenCut v28의 실제 미디어와 기본 요소를 확인해 적용, 실제 무음 MP4 출력. 개인 콘텐츠 근거는 Obsidian 작업공간에 보존.
- [x] typecheck, FSD, desktop build, 관련 단위9개 통과. 실제 다른 음식점 촬영본 교체 제작·네이티브 템플릿 선택 버튼·양방향 동기화는 범위 밖.
- [사용법·검증 범위](docs/opencut-templates.md).

## herdr 방식 CLI 보강 — 2026-11-13

배경: `reels` CLI를 사람·에이전트가 더 쉽게 찾고 진단하도록 보강했다. 기존 JSON 출력·종료 코드는 그대로 두고 추가만 했다. 새 의존성 없음. [CLI 사용법](docs/cli-usage.md).

- [x] 내장 명령 표: `status`·`doctor`·`tools`·`call`·`prepare-media`·`help`·`completion`과 `--help`·`--version`을 한 표에서 라우팅·도움말·`data.builtins`·자동 완성에 사용.
- [x] 도구 그룹: `reels tools`의 각 도구에 `group`, 목록에 `groups`(`id`·`summary`·`count`). `reels tools --group <id>`로 한 그룹만 표시.
- [x] `reels doctor`: 런타임·프로필·앱·`~/.local/bin/reels` 런처·`PATH`를 읽기만 하는 진단. 검사마다 `ok` true/false/null과 CLI가 적용하지 않는 `fix`. 리뷰 반영으로 런처가 실행하는 실행 파일의 존재·실행 권한까지 확인하고, 런처 없이 다른 `reels`(npm link 등)가 `PATH`에 있으면 `path_dir`를 null로 보고.
- [x] `reels help agent` + `skills/reels-cli/SKILL.md`: 에이전트용 사용 안내를 빌드에 포함해 설치된 CLI 버전과 일치. 리비전 안내는 `--expected-updated-at`를 받는 쓰기로 좁힘.
- [x] `--plain`: `reels help --plain`·`reels tools --plain`만 사람용 텍스트. 실패는 JSON 유지. `--help`·`--version`은 먼저 처리되어 `--plain`을 무시하고 JSON 출력(기존 동작, 문서에 명시).
- [x] `reels completion <bash|zsh|fish>`: 현재 버전 표에서 만든 정적 스크립트, 설치하지 않음. 리뷰 반영으로 경로·값을 받는 플래그 뒤에서는 파일 이름 완성 유지(bash `complete -o default`, zsh `_files`, fish는 명령·그룹 위치만 `-f`). macOS `/bin/bash` 3.2용으로 `eval "$(reels completion bash)"` 안내.
- [x] 검증: typecheck, check:architecture, `npm test` 603개(598 통과·5 건너뜀·실패 0, fish 미설치 skip 포함), `npm run build`, `npm run test:cli` 4개, `npm run test:workflow` 82개 통과. 생성 스크립트 `bash -n`(3.2)·`zsh -n` 통과. 기존 명령 출력 캡처 비교에서 completion·도움말 예시·agent 안내 외 변화 없음.
- [ ] 의도적으로 하지 않음: `npm run workflow`를 `reels workflow`로 감싸기(HTTP 경로이고 CLI는 비공개 소켓만 쓴다는 문서 계약, 번들 위험), `serve`·`blog:editor`(장시간 서버), `reels editor ...` 같은 그룹 하위 명령, doctor의 앱 버전(앱이 CLI에 버전을 알리지 않음), help의 `writeOutcome` 통일(기존 `help <unknown>` 출력이 바뀜).
- 제한: 실행 중 앱·실제 `~/.local/bin/reels`·셸 설정 파일은 건드리지 않음. 패키징·push 안 함.

## 무음 반복 GIF 변환 — 2026-11-12

- [x] 영상 → 소리 없는 무한 반복 GIF. 기본은 전체 길이·폭 480·15fps, `start`/`end` 구간(최대 60초), 회전 반영, HDR/HLG→SDR, 메타데이터(위치 포함) 제거. 번들 ffmpeg만 사용(새 의존성 없음): VideoToolbox 디코드·회전·톤매핑·축소 + 샘플 프레임 팔레트 + bayer 디더링, GPU 실패 시 CPU 경로. [문서](docs/gif-convert.md).
- [x] MCP/CLI `reels_convert_gif`, 보드 미디어 보기의 **무음 GIF 만들기**(저장 위치 선택). 20MB 초과 경고(네이버 상한 미확인), `maxBytes`로 fps→폭 자동 축소.
- [x] 검증: typecheck, check:architecture, `npm test` 519개(515 통과·4 건너뜀, 새 단위 7개 포함: 합성 HLG·회전·오디오·위치 태그 영상으로 GPU/CPU 경로, 무한 반복, 메타데이터 제거, maxBytes), `npm run build`, Electron background QA `gif-convert`(UI 버튼 + 실제 MCP)·`content-board` 2개 통과.
- [x] 실측: iPhone HEVC HLG 8초 세로 원본 → 480×854·15fps·120프레임·23.1MB, 4.1~5.0초(첫 실행 8.0초). 고전 CPU palettegen 기준선은 22.8초·28.2MB. 프레임 육안 확인(회전·톤·밴딩) 정상.
- [ ] 네이버 블로그 실제 업로드 상한 확인, 패키징·실행 중 앱 반영은 하지 않음.
- [x] 크롭 옵션(2026-11-12): 선택 `crop {x,y,width,height}`(회전 반영 후 화면 기준 0~1 비율, 범위 밖은 스키마 오류, 16px 미만은 `GIF_CROP`). GPU 경로 유지 — `scale_vt`가 전체 프레임을 "남길 영역=출력 크기"가 되게 줄이고 `hwdownload` 직후 작은 프레임에서 `crop`, CPU 경로도 같은 지점에서 같은 사각형. 폭 480 기본·확대 없음·`maxBytes` 재시도는 잘라낸 영역에 적용. 결과에 `crop`(+원본 화면 `pixels`, 없으면 `null`). CLI `--crop '<json>'`·MCP 설명·예시 갱신, 보드 버튼에는 크롭 UI 없음. [문서](docs/gif-convert.md).
- [x] 크롭 검증: typecheck, check:architecture, `npm test` 522개(518 통과·4 건너뜀·실패 0, 새 단위 3개: 크롭 계획·스키마, 합성 회전 HLG로 GPU 경로 180×272·잘린 위치 픽셀 대조·CPU 대체 동일 크기·maxBytes 재시도), `npm run build`, Electron background QA `gif-convert`(MCP crop 호출 포함) 통과.
- [x] 크롭 실측: `IMG_7360.MOV`(HLG 세로 8초) `crop {0,0.15,1,0.85}`·`maxBytes 10000000` → `accel: videotoolbox`, 396×598·10fps·9.99MB, 14.2초(재실행 10.9초), 3회 시도. 크롭 없이 같은 `maxBytes`는 334×594·8.4MB·23.6초. 패키징·앱 재시작은 이 작업에서 하지 않음(메인 세션 담당).

## 주간 게시 캘린더·외부 서비스 연결 — 2026-11-12

- [x] main 통합: `reels_sync_planning` CLI 예시에 `--weekly-target 3`을 추가해 빈 업데이트 스키마 실패 해결. 타입/FSD·전체 단위 531개(527 통과·4 조건부 skip·실패 0)·공개 소스 검사 통과. 앱 재패키징·재시작 없이 기능별 커밋 정리.
- [x] 캘린더 탭: 한국시간 월요일 기준 이번 주/다음 주, 네이버클립 주3개 목표, 게시 완료·예정·잔여량 구분. 촬영일로 게시일 추정 없음, 동일 프로젝트/채널 중복 방지. 조회 구간 밖은 미확인.
- [x] Google Calendar 일정·Linear 이슈의 비공개 가져오기와 원본 링크. 외부에서 수정하고 앱은 읽기 전용으로 표시. 마지막 조회 시각 표시, MCP/CLI 리비전 검사와 provider별 교체, 공유 snapshot 제외.
- [x] 타입/FSD/빌드·공개 소스 검사, 관련 단위16개·웹 캘린더/셸/채널 회귀10개·개발 및 패키지 Electron 실제 MCP/IPC 각1개 통과. 실제 실행 앱에서 캘린더 탭·이번 주3/3·다음 주1/3 표시 확인.
- 제한: 앱 OAuth·백그라운드 자동 갱신·양방향 동기화 없음. 연결된 세션이 조회 결과를 가져오는 방식. 실제 Linear 연결·개인 일정 등록·설치 적용은 운영 기록과 구분. [계약·사용법](docs/publication-calendar.md).

## 콘텐츠 프로젝트 터미널 진입점 — 2026-11-12

- [x] 후속 요청: **다음 작업 가이드 넣기**로 현재 단계·다음 할 일·채널별 상태와 작업 순서·완료 기준을 요청에 추가. 기존 입력 보존, 중복·길이 제한. 실제 연결 워크플로의 대기 작업은 세션에서 조회하도록 안내.
- [x] 후속 검증: 타입·FSD·빌드와 관련 단위 24개, 새 패키지 Electron 2개 통과. 기존 앱을 백업하고 `release/mac-arm64/Reels Dashboard.app`에 반영해 터미널 활성 상태로 실행, 실제 대시보드 확인. 모델 작업·게시·업로드는 미실행.
- [x] 데스크톱 카드의 **프로젝트 터미널**에서 대상 ID·제목과 선택적 작업 요청을 새 Codex 세션으로 전달. 앱 개발 프롬프트와 콘텐츠 작업 프롬프트 분리. 터미널 비활성 상태는 설정 안내, 시작 실패는 입력 보존, 성공은 새 탭 선택.
- [x] 타입·FSD·빌드, 관련 단위 24개, Electron 프로젝트/블로그 4개, 웹 보드 3개 통과. 기존 `workbench-request` 1개는 HEAD에도 있는 permission 기대값 누락으로 실패.
- 제한: 기존 앱 소스 cwd 유지, 프로젝트별 대화 자동 재개 없음. 실제 모델 작업·개인 자료 수정은 실행하지 않음. 설치 앱 반영은 위 후속 요청에서 완료. [사용법과 검증 경계](docs/production-projects.md#프로젝트-터미널--2026-11-12).

## 보드 문서 뷰어 + 폴더 구분 — 2026-11-12

- [x] 연결 문서(폴더 안 포함)를 ‘위치 열기’ 대신 보드 뷰어에서 표시. `.md`는 **블로그**(SmartEditor 유사 칼럼, blog markup v1은 `renderHtml`로 렌더)·**Markdown**·**텍스트** 전환, 그 밖의 형식은 텍스트만. 파일 그리드에서 폴더를 앞에 두고 테두리·폴더 아이콘·`/`·“폴더 · 열기 ›”로 구분. [문서](docs/local-content-library.md#document-viewer-and-folder-distinction--2026-11-12).
- [x] 검증: typecheck, check:architecture, `npm test` 512개(508 통과·4 건너뜀), `npm run build`, 웹 `content-board` 4개, Electron background QA `content-board` 1개(실제 파일: 폴더 안 블로그 마크업과 연결된 표지 사진, `.txt`) 통과.
- 제한: 블로그 뷰는 콘텐츠 레이아웃 셸·웹폰트를 불러오지 않는 근사치. 영상은 블로그 뷰에서 재생하지 않음. 사진은 연결 자료 안에 있을 때만 썸네일로 표시. 설치 앱 반영은 하지 않음.

## 원본 직접 재생 + GPU 사본 통합 — 2026-11-12

배경: `feat/direct-playback`(원본 직접 재생, 사본은 실패·dataless 때만)과 `feat/gpu-proxy`(사본 VideoToolbox 생성, CPU 자동 폴백)를 `feat/playback-direct-gpu`로 합쳤다. 문서 충돌 두 곳은 양쪽 내용을 모두 살렸다.

- [x] 검증: `npm run typecheck`, `npm run check:architecture`, `npm test`(498개 중 494 통과·4 건너뜀), `npm run build`, `npm run build:editor` 후 `npm run test:editor-engine` 21개 통과, 웹 `editor`·`content-board`·`route-map` 23개 통과, Electron background QA 7개 통과·1개 opt-in skip, `npm run package:mac` 성공(`release/mac-arm64`, 설치·교체 안 함)과 패키지 앱으로 재생 spec 2개 통과.
- [x] 실제 HEVC 10bit HLG 2160×3840 20초 원본이 보드·편집기에서 사본 없이 재생. Chromium이 못 읽는 ProRes HLG `.mov`는 보드·편집기 모두 사본으로 자동 전환되고 사본은 GPU 경로(`GPU proxy unavailable` 없음)로 만들어짐. 클릭부터 사본 재생까지 개발 빌드 약 3.2~3.3초(4초 클립).
- [x] 오디오가 있고 영상 코덱만 못 읽는 파일은 `<video>` 오류 없이 오디오만 재생되어 폴백이 일어나지 않던 문제를 고침. 보드·촬영 지도·편집기가 `loadedmetadata`에서 `videoWidth`가 0이면 재생 실패로 처리.
- [x] opt-in Electron 폴백 spec 추가(`REELS_FALLBACK_SOURCE`, GPU 경로 확인은 `REELS_FALLBACK_EXPECT_GPU=1`). 결과는 [Electron QA](docs/editor-electron-qa.md#원본-직접-재생--gpu-사본-통합--2026-11-12).
- [ ] 실제 dataless 파일의 사본 경로 end-to-end, HDR 원본과 SDR 사본의 화면 톤 육안 비교, 실행 중 앱 반영은 하지 않음.

## 원본 직접 재생 — 2026-11-12

배경: 보드 재생·촬영 지도·편집기 가져오기가 모든 영상을 ffmpeg SDR 사본으로 바꾼 뒤 재생해 첫 재생이 느리고 HDR 원본을 그대로 볼 수 없었다. 사용자 결정으로 원본을 기본 재생하고 사본은 필요할 때만 만든다.

- [x] `reels-media`가 원본을 Range로 스트리밍(보드 `content/{token}` grant, 편집기 `video/{id}`). origin 검사·토큰 grant·등록 자료 제한은 유지. `.mov`는 `video/quicktime`.
- [x] 사본은 (a) `<video>` 오류 시 UI가 자동 요청(“재생용 사본을 준비하고 있어요” 표시, 보드 `open(..., {copy: true})`, 편집기 `editor.playbackCopy(id)` → `video/{id}/copy`) (b) iCloud dataless 원본(`stat -f %f`의 `SF_DATALESS`, 플래그를 못 읽을 때만 `blocks === 0 && size > 0`)일 때만. 판별 실패는 원본 재생. 편집기는 dataless 원본의 첫 요청을 503으로 거절해 (a)로 넘김.
- [x] 편집기 가져오기에서 `proxy` 호출 제거. 기존 기록의 `proxyPath`/`playback.mp4`는 그대로 읽고 폴백 때 재사용. 표지·렌더·미리보기 프레임 경로와 Python 엔진은 변경 없음.
- [x] 검증: `npm run typecheck`, `npm run check:architecture`, `npm test`(494개 중 489 통과·4 건너뜀·1 실패: `agent.test.ts`의 abort 타이밍 테스트로 단독 3회 재실행 모두 통과), 웹 161개 통과(`canonical-sdk.spec.ts`는 공유 node_modules의 OpenTelemetry 로드 오류로 HEAD에서도 수집 불가라 제외), Electron background QA 6개 통과·1개 opt-in skip. 실제 HEVC 10bit HLG 2160×3840 20초 원본이 보드·편집기에서 사본 없이 재생(readyState 4, 2160×3840 디코드, currentTime 1.5초 이상). 결과는 [Electron QA](docs/editor-electron-qa.md#원본-직접-재생--2026-11-12).
- [ ] 실제 dataless 파일의 사본 경로 end-to-end(다운로드 유발)는 실행하지 않음. 판별은 실제 iCloud placeholder 메타데이터로만 확인. 실행 중 앱 반영·패키징은 하지 않음.
- 정책: [원본 직접 재생](docs/editor-workflow.md#원본-직접-재생--2026-11-12).

## 프로젝트의 채널별 게시 상태 — 2026-11-12

배경: 게시 완료가 프로젝트당 `stage` 하나라 인스타그램·네이버클립·블로그 중 일부만 올린 프로젝트를 표현할 수 없었다. 사용자 결정으로 프로젝트는 하나로 두고 그 안에서 채널별로 본다.

- [x] `Project.publications`: 채널(`instagram`·`naver-clip`·`blog`)마다 `planned`/`published`·링크·게시일. 기존 dashboard schemaVersion 1의 선택 필드이며 `stage`·`publicURL`은 프로젝트 요약으로 유지. 공유 snapshot에는 넣지 않음.
- [x] 보드 **채널 필터**: 채널을 고르면 그 채널을 목표로 하는 프로젝트만 보이고 진행 중/게시 완료를 그 채널 기준으로 판정. 카드에 채널 칩·링크, 콘텐츠 기록 폼에 채널별 입력.
- [x] MCP/CLI `reels_set_publication`: 채널 하나만 갱신(전체 upsert 불필요). 목표 채널이 전부 게시되면 `stage`를 게시 완료로 올리고 되돌리지 않음. 남은 채널은 먼저 `planned`로 등록해야 함. `reels_upsert_content`는 `publications`를 생략하면 기존 값을 유지.
- [x] 프로젝트 병합: 채널별로 합치고 같은 채널의 서로 다른 게시물은 `PROJECT_PUBLICATION_CONFLICT`로 거절.
- [x] 검증: `npm run typecheck`, `npm run check:architecture`, `npm test`(479개 중 473 통과·4 건너뜀·2 실패. 실패는 단독 재실행 시 통과하는 `blog-autosave` 타이밍 테스트와 이 worktree에 번들 ffmpeg가 없어 난 `face-mosaic`이며 이번 변경과 무관), 웹 Playwright 10개(`publications`·`board-controls`·`dashboard`) 통과, 카드 화면 스크린샷 확인.
- [ ] Electron 테스트 미실행. 모바일 공유 화면의 채널 표시 없음. 기존 프로젝트의 채널 상태는 비어 있어 실제 게시 확인 뒤 채워야 함.
- 설계·사용법: [제작 프로젝트 모델](docs/production-projects.md#채널별-게시-상태--2026-11-12), [MCP 사용법](docs/mcp-usage.md#per-channel-publication-state--2026-11-12).

## 로컬 표지 서명·클립 업로드 묶음 — 2026-11-12

- [x] 표지 서명: user-data의 비공개 `cover-preferences.json`, 기본 `@your_account 🌹` 유지. 앱 설정·MCP가 같은 서비스를 사용하고 요청별 서명을 표지 엔진·manifest에 전달. 팔로우 마지막 장의 명시적 서명은 유지.
- [x] 업로드 묶음: 현재 outbound 우선, 없으면 최신 기록된 출력/유일한 등록 자료. 모호한 선택은 오류로 명시 선택 요구. 설명은 호출자가 확인한 문안 그대로 UTF-8 저장. `/tmp/reels-clip-*` 전용 새 폴더에 ASCII 영상명·JPEG 표지·설명·영수증을 만들며 원본/outbound/대시보드 상태는 변경하지 않음. 자동 만료 삭제는 하지 않고 사용 후 사용자 삭제 또는 OS 임시 정리를 따름.
- [x] 앱 설정 UI·프로젝트 카드의 묶음 생성·preload·MCP 연결. `reels_get_cover_preferences`/`reels_set_cover_preferences`, `reels_create_clip_upload_bundle` 계약은 [MCP 사용법](docs/mcp-usage.md#local-cover-signature-and-clip-upload-bundle--2026-11-12)에 기록.
- [x] `npm run typecheck`, `npm run check:architecture`, `npm run audit:public`, `git diff --check`, `npm run build` 및 `npm run build:editor` 통과. `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npm test`: 462개 통과·기존 환경 조건 4개 skip. 새 묶음/설정 단위 7개 포함.
- [x] `npm run test:editor-engine`: 번들 엔진 14개(HDR 포함) 통과. 서명 변경/장미 제외 픽셀·manifest, 기본값·팔로우 표지 회귀 확인. 소스의 새 서명 테스트도 통과. 최초 서명 문자열과 이미지 변수명 충돌은 수정 후 재검증.
- [x] `npm run test:electron -- tests/electron/clip-upload.spec.ts`: 격리된 background QA 앱 1개 통과. 실제 UI 저장·MCP 조회/수정·표지 preview/render·JPEG 디코딩(720×1280)·ASCII 경로/해시·설명 UTF-8·원본/대시보드 보존·UI 묶음 생성 확인, 화면 캡처 검토. 초기 테스트의 렌더 종료 직후 `EDITOR_BUSY`는 UI 상태 갱신까지 기다리는 방식으로 수정. 기존 `npm run test:mcp` 2개도 통과.
- 검사 실패 보존: `npm run verify:spec`은 기존 `AppCommandRouterTests.swift` 기준 해시 불일치로 실패. 해당 파일이 HEAD와 동일함을 확인했으며 이번 범위에서 기준을 변경하지 않음. 전체 웹·실제 iCloud·설치 패키지 검증은 하지 않음.
- [ ] 사용자 확인 필요: 설치 앱 반영·실계정 설정·실제 네이버 파일 선택/업로드. 기존 앱 재시작·iCloud 변경·push/PR/배포는 수행하지 않음.

## YAML 제작 워크플로 DSL — 2026-11-12

- [x] 사용자 요청으로 새 패키지를 실제 설치 위치에 적용하고 개발 모드 유지·재시작. 이전 앱/워크플로 DB 백업 보존. 패키지 Electron 3개 통과 후 설치 app.asar 일치와 실제 내장 서버 protocol 4, 두 stdio MCP의 호출을 확인. 기존 제작·편집 프로젝트 ID와 워크플로 task/history 유지 확인. 실제 제작 프로젝트의 YAML 실행을 생성해 Photos 탐색→근거 준비→사용자 경험 폼 대기까지 진행.
- [x] 실제 Photos 탐색에서 `groups.inspect`가 64px fastFormat 캐시를 반환하는 문제 수정. 검사 경로만 highQuality 요청으로 전환하고 서명 헬퍼 적용. 관련 timeout 테스트와 실제 1024px 미리보기·간판/메뉴 OCR 복구 확인. 원본 이동·삭제 없음.

- [x] YAML v1에 단계·스킬·MCP 용도·입출력·완료 기준·done/pass/revise 전이를 선언. 파일 경계·중복/누락/도달 불가 단계·무한 성공 경로를 검증하고 정의 원문/해시/구조를 실행 체크포인트에 저장. 기존 편집 워크플로 유지.
- [x] 현재 Codex 세션이 `reels_workflow_context`/공식 CLI로 같은 run/task를 읽고 실행·결과 제출. projectId 연결과 새 태스크 ID·입력 해시·산출물 검증, 사용자 입력폼의 원문 제출, 재시작·수정/전체 단계 한도 지원. 읽기 전용 SDK는 DSL 작업 실행에서 제외.
- [x] Dashboard가 같은 저장 정의로 분기·수정 경로·현재 단계·이력을 표시. 단계별 계약, 원본 YAML, 기존 채팅에 전달할 이어가기 정보 제공. 새 실행 UI에서 YAML과 프로젝트 ID 입력.
- [x] [실행 스킬](skills/reels-workflow/SKILL.md), [YAML 예시](docs/workflow-examples/production.yaml), [DSL 계약](docs/workflow-dsl.md), 에디터용 생성 JSON Schema 추가. Codex 사용자 스킬 디렉터리에 정본 심볼릭 링크 연결.
- 검증: 단위 전체 472개 중 468개 통과·4개 조건부 skip, 워크플로 웹 7개 통과(실제 stdio MCP→UI 갱신→서버 재시작→CLI 재개 포함), 타입/FSD/웹·desktop 빌드/공개 소스 검사 통과. 사용자 입력 프로젝트 연결 후 관련 단위 재검증. Electron 결과는 DSL 문서의 검증 항목 참조.
- 기존 실패: `verify:spec`의 `AppCommandRouterTests.swift` 기준 해시 불일치. 해당 Swift 파일·기준표는 수정하지 않음.
- 반영 경계: 소스·빌드·격리 검증까지. 실행 중인 사용자 앱/운영 DB/기존 MCP 설정은 교체하지 않음. 새 빌드 적용 후 워크플로 프로토콜 4와 MCP 재연결 필요. YAML 도구 선언은 실제 호출·검토 품질·발행의 증명이 아님.

## CPU 자동 인코딩 제거 — 2026-11-11

- [x] 기존 Dolby Vision의 `libx265` 선택은 메타데이터 보존 목적이었다. 실제 입력에서 FFmpeg 인코더만 VideoToolbox로 바꾸면 HLG/10비트는 남고 Dolby Vision 신호는 사라지는 점을 확인.
- [x] Dolby Vision 8.4는 번들 네이티브 렌더러의 Metal 합성·하드웨어 HEVC Main10·동적 메타데이터 재생성으로 교체. 일반 영상·프록시·카드뉴스도 VideoToolbox를 강제하고 CPU 자동 전환 제거. 지원하지 않는 프로필·하드웨어는 명시적 오류. 원본 비트레이트를 상한 안에서 적용하고 동일 시간 레이어는 한 번에 합성.
- [x] 단위 전체 389개, 엔진 소스/번들 각 13개, 실제 Dolby 입력 포함 하드웨어 5개, 개발/패키지 Electron 각 4개, 타입/FSD/공개 소스 검사 통과. 실제 4K60 26.77초 입력은 33.13초에 렌더링, 1,606프레임·표시 시각·오디오 바이트·Dolby Vision/HLG/10비트 확인. [구현·검증 범위](docs/editor-engine.md#hardware-encoding-policy--2026-11-11).
- [ ] 실행 중 앱 반영: Mac 잠금 해제 대기. 검증 패키지는 `release/hardware-encoding-20261111/mac-arm64/Reels Dashboard.app`, 설치 대기 사본은 기존 설치 폴더의 `Reels Dashboard.hardware-update.app`. 기존 앱·콘텐츠 출력은 유지.

## 재생용 사본 GPU 가속 — 2026-11-12

- [x] `proxy`가 VideoToolbox 디코딩(`videotoolbox_vld`)→`transpose_vt`/`scale_vt`(HDR은 BT.709 변환 포함)→`h264_videotoolbox -allow_sw 0`로 프레임을 GPU 메모리에 둔 채 사본을 만든다. 하드웨어 프레임은 자동 회전되지 않아 display matrix를 `transpose_vt`로 적용.
- [x] GPU 경로 실패·출력 크기/색 태그 불일치·좌우 반전 matrix는 기존 CPU 디코딩+zscale/tonemap 경로로 자동 폴백(인코더는 계속 VideoToolbox). 결과 JSON에 `accel: videotoolbox|cpu` 추가.
- [x] 실제 4K60 HLG/Dolby 8.4 20.78초 샘플: 102.3초→6.4초(CPU user 242초→1.3초), 608×1080 bt709·1,247프레임 동일. 엔진 소스/번들 각 21개 통과. [구현·측정](docs/editor-engine.md#gpu-playback-proxy--2026-11-12).
- [ ] 실행 중 앱 반영은 별도. TypeScript 호출부는 결과의 `accel`을 아직 사용하지 않음.

## 프로젝트별 단일 outbound — 2026-11-11 후속 정정

- [x] `Project.outbound`에 폴더 하나·현재 파일 목록·세대·로컬 영수증 경로를 저장. `reels_set_project_outbound`로 한 번 연결하고 이후 전달에는 `destination`을 받지 않음. 다른 폴더 재지정·다른 프로젝트와 경로 중첩 거부.
- [x] `reels_start_icloud_delivery`의 `files[{sourcePath,name,role}]`를 현재 출력 전체로 반영. 고정 파일명 교체·누락된 이전 관리 파일은 로컬 `outbound-history`로 보관. 관련 출력 이력 참조도 보관 경로로 유지. 원본·미등록 파일 보존, 외부 변경/충돌 거부, 오류 시 복구 검사.
- [x] 카드가 현재 outbound 미디어를 우선 표시하고, 세대·자료 변경 시 같은 경로의 썸네일·뷰어를 갱신. 이전 자료는 전체 목록에서 조회.
- [x] 전체 단위 389개, 타입/FSD/공개 소스 검사, 웹·데스크톱 빌드 및 패키지 생성 통과. 보드 웹 2개, Electron 비-iCloud 실패 판정, 개발/패키지 실제 iCloud 같은 폴더 연속 전달·교체·로컬 이력 확인 통과. 네이티브 업로드 조회는 앞서 검증한 구현을 재사용.
- [x] 잠금 해제 후 기존 설치 위치에 업데이트·정상 재시작. 실제 프로젝트에 고정 outbound를 지정하고 최신 영상·표지·게시글을 같은 경로로 갱신, 업로드 완료 확인. 버전별 iCloud 폴더 두 개는 로컬 보관 후 자료 링크 갱신(모든 링크 유효). Dashboard의 현재 outbound 두 미리보기 표시·새로고침을 실제 화면에서 확인. [새 계약](docs/mcp-usage.md#icloud-delivery-api--2026-11-11).

## 블로그 화면 맥락·터미널 연결 — 2026-11-11

- [x] 개발 모드의 블로그 상단에 터미널 열기·맥락과 함께 수정 추가. 현재 보이는 탭/프로젝트와 수정 요청을 새 Codex 초기 프롬프트로 전달하고 해당 터미널 선택. 기존 대화용 프롬프트 복사, 실패 시 입력 보존·중복 제출 방지.
- [x] 세션이 생긴 터미널과 정본 편집기가 겹치던 높이 계산 수정. 실제 패널 높이를 반영하며 기존 편집기 탭과 자료 유지.
- [x] 관련 단위 21개, Electron background QA 11개, 타입/FSD, 웹·desktop 빌드 통과. 실제 모델 작업·기존 대화 자동 재개·패키지 설치는 미검증/미실행. `verify:spec`은 기존 Swift `AppCommandRouterTests.swift`의 기준 해시 불일치로 실패(이번 변경 범위 밖, 보존). [사용법과 검증 경계](docs/blog-workspace.md#화면-맥락으로-터미널-열기--2026-11-11).

## iCloud 전달·상태 MCP 연결 — 2026-11-11 초기 구현 기록

- [x] 기존 `ICloudDestinationUploadVerifier`의 네이티브 상태 조회·판정을 `icloud.status`로 노출. 업로드 완료와 로컬 다운로드 최신 상태를 분리하며, Photos 원본 이동의 기존 엄격한 검증은 유지.
- [x] `reels_icloud_status`, `reels_start_icloud_delivery`, `reels_get_icloud_delivery` 추가. 등록된 미디어·문서만 기존 복사기(`prepareLocalMedia`)로 새 폴더에 전달하고, 복사/업로드 대기/완료를 구분. `get_app_state.deliveries`로 재연결 뒤 작업 ID 조회.
- [x] Dashboard preload와 MCP가 같은 `ICloudDelivery` 서비스를 사용. 별도 Swift 명령 생성 없이 파일별 iCloud 상태 확인. Photos 권한 요청·삭제·게시·기존 출력 덮어쓰기 없음. [계약·사용법](docs/mcp-usage.md#icloud-delivery-api--2026-11-11).
- [x] Node 전체 383개(정상 macOS locale 지정), Swift 관련 29개, 타입/FSD/공개 소스 검사, 웹·데스크톱·서명된 native 빌드 통과. 기존 MCP Electron 2개, 새 경로 1개와 실제 iCloud 동기화 검사(개발/패키지) 통과. 테스트 파일만 새 QA 폴더에 올리고 정리함.
- [x] 기존 설치 위치 `release/production-projects/mac-arm64/Reels Dashboard.app`에 반영·재시작. 개발 모드와 콘텐츠 목록 유지 확인. 새 MCP 클라이언트로 기존 전달 파일 3개의 업로드 완료를 실제 조회. 이전 앱은 `release/icloud-delivery-20261111/previous-production-projects.app`에 보존.
- 범위: 새 전달 폴더와 상태 조회 API. 전달 패널 UI·기존 파일 교체·앱 재시작 뒤 복사 작업 복구는 포함하지 않음. 새 도구 목록을 캐시한 MCP 클라이언트는 재연결 필요.

## 프로젝트 단위 MCP·herdr 작업 패널 — 2026-11-10 계획

- 방향(사용자 결정): Workdesk 탭으로 합치지 않는다. Photos 헬퍼·번들 런타임·워크플로 서버·공개 저장소·`work`/`side` 경계 때문이다. Workdesk PR을 따라 기능을 일괄 이식하는 것도 멈추고, 실제 제작에서 막힌 기능만 가져온다. 에이전트 쪽 투자는 대시보드 안 에이전트 UI 대신 **MCP 개선**에 둔다.
- 목표: 블로그만이 아니라 **모든 작업 화면이 프로젝트 단위로** 같은 패널을 붙인다. 영상 편집, 카드뉴스, 블로그 정본 편집기, 콘텐츠 보드의 프로젝트 상세 모두 해당한다. 화면 옆에 ① 그 프로젝트에서 쓰는 `reels_dashboard` MCP 도구와 호출 기록, ② 그 프로젝트에 묶인 herdr 세션 터미널(Codex/Claude)이 붙는다. 화면을 보면서 MCP로 수정하고, MCP로 못 한 일을 바로 MCP 개선으로 돌린다.
- [ ] 통합 프로젝트 모델(사용자 결정): 영상·카드뉴스·블로그·클립을 모두 프로젝트 하나로 묶는다. 원본·분석·장소 맥락은 프로젝트가 공유하고, 표현·데이터 선택·레퍼런스·문안 정본은 산출물(kind)별로 둔다. 블로그 등록(`blog-projects.json`)은 `projectId`로 명시 연결한다. [설계 기준](docs/production-projects.md#통합-프로젝트-모델--2026-11-10-계획). 패널·herdr의 공통 키는 `projectId`, 화면 맥락은 산출물 `kind`·`id`다.
- [ ] herdr 세션을 프로젝트 단위로 묶기: 진행 중인 herdr 백엔드(`src/desktop/herdr.ts`, label `reels-dashboard:<kind>:<uuid>`)에 프로젝트 키를 넣는다. cwd는 콘텐츠 작업공간이고, 같은 프로젝트를 다시 열면 화면 종류와 상관없이 기존 세션에 attach한다.
- [ ] 공통 사이드 패널: 화면별로 따로 만들지 않고 작업 화면 셸에 하나로 둔다. MCP 도구 목록, 최근 호출(입력·결과·오류·소요 시간), 호출이 바꾼 대상(편집 구성 `updatedAt`, 블로그 정본 revision 등)을 보여 준다. 저장 안 된 UI 변경과 충돌하지 않도록 기존 `updatedAt`·자동 저장·3-way 병합 계약을 따른다.
- [ ] 패널 터미널 세션이 `reels_dashboard` MCP를 기본으로 쓰도록 연결하고, 세션 시작 맥락에 현재 프로젝트 키와 열린 화면을 넘긴다.
- [ ] MCP 부족 기록: 터미널에서 셸·파일 직접 수정으로 처리한 작업을 프로젝트별 "MCP 도구 후보"로 남겨 개선 목록으로 모은다(자동 판별 범위는 설계 때 정한다).
- 미정(사용자 결정 필요): 지금 터미널은 `REELS_DEV_MODE=1` 전용이다. 제작 화면에서 개발모드 없이 이 패널을 열지 정해야 한다.

## 블로그 비율 혼합 콜라주 — 2026-11-10

- [x] 계기: 하남 핑크뮬리 글의 묶음 사진 17장이 모두 3:4 세로였다. `<Collage>`가 균등 2열 격자만 그려서 가로·세로를 섞은 행을 표현할 수 없었다.
- [x] `<Collage ratios="3:4 · 4:3 · …">` 추가. `layout`의 `2x2`·`2+1`로 행을 나누고, 행 안에서 사진 비율대로 폭을 나눠 높이를 맞춘다. `ratios`가 없으면 기존 균등 격자 그대로. 검사는 비율 개수·형식과 칸 수 불일치를 오류로 낸다. [동작·한계](docs/blog-markup-source.md#mixed-ratio-collage--2026-11-10).
- [x] 타입/FSD 검사, 단위 전체 343개, 웹 headless `markup-layout` 1개(폭 4종에서 행 높이·전체 폭·칸 비율) 통과. 웹 전체·Electron 스위트는 실행하지 않음.
- 미구현·미검증: 편집기 화면에서 `ratios`를 고치는 조작 없음(마크업 원문 수정). 실행 중인 앱 교체·패키지 미생성. 네이버 실제 콜라주로 옮겼을 때 같은 행 구성이 되는지 미확인.

## 에이전트 CLI — 2026-11-06

- [x] `reels` 명령 추가(`src/app/cli`, `dist-cli/reels.mjs`). `toolDefinitions`에서 하위 명령·플래그·스키마를 자동 생성하고 MCP와 같은 소켓을 쓴다. 프로젝트 저장소·렌더 큐·재시도·revision 자동 채움은 두지 않는다. [사용법·종료 코드](docs/cli-usage.md).
- [x] `callAgent`가 요청 전송 뒤 끊김을 `APP_OFFLINE`이 아닌 `CONNECTION_LOST`로 낸다. `timeoutMs`·`signal` 옵션과 `code`·`requestSent`·`reason`, 앱 오류의 `code` 전달을 추가했다. 앱의 코드 없던 오류에 `EDITOR_BUSY`·`OUTPUT_EXISTS`·`RENDER_JOB_NOT_FOUND`·`BLOG_EXTRACT_BUSY`·`RENDER_SAVE_BUSY`를 붙였다(문구는 그대로). 빈 메시지 오류도 실패로 판별하고, 큰 응답은 선형 시간으로 읽으며, `timeoutMs`는 호출 전체의 절대 제한이다.
- [x] SIGHUP·SIGINT·SIGTERM은 명령 어디서든 JSON 한 건을 남긴다. 앱 호출 중 쓰기는 `unknown`/`inspect_first`, job id를 받은 뒤의 `--wait`만 `applied`/`safe`다.
- [x] `next`는 실행 가능한 명령 배열로 고정하고 사람용 안내는 `hint`로 분리. `upsert-content` 충돌은 `reels list-projects`로 안내하고 리비전 스키마 설명을 대시보드 기준으로 바로잡았다. 미리보기 `kind=video`의 `time` 필수를 스키마로 올려 MCP도 함께 맞췄다.
- [x] `reels prepare-media`로 앱 없이 등록 자료 사본을 만든다. 입력은 `--list`로 앱 없이 찾는다. 출력 폴더 생성 전 거부는 `INVALID_INPUT`, 생성 뒤 실패만 `PREPARE_FAILED`다. 파일별 거부 사유는 `issues`로 내고, `dashboard.json`을 못 읽으면 어느 경로든 `STORE_UNREADABLE`이다. 기존 스크립트는 호환 경로로 유지.
- [x] 결과가 잘리지 않게 했다. `--out`은 임시 파일을 hard link로 올려 완성본만 남고, stdout은 전체 바이트를 확인해 못 쓰면 비0으로 끝난다. hard link가 없는 파일 시스템(exFAT 등)에서는 `--out`이 `OUTPUT_WRITE_FAILED`다.
- [x] 복구 안내를 채웠다. exit 7 쓰기와 exit 5의 `next`는 입력에서 만든 조회 명령이고, `reels help exit-codes`로 종료 코드를 CLI 안에서 볼 수 있다. 값 자리의 `--help`는 사용법 오류이며, 모든 도구 예시가 스키마를 통과하는지 테스트한다.
- 통과: 가짜 dispatch와 실제 private socket의 왕복·오프라인·종료 코드·이미지·`--wait`·신호, stub 포트를 넣은 실제 `createAgentDispatch` 왕복, stdio MCP와의 스키마 일치, `node_modules` 없는 폴더로 복사한 번들 실행, 삭제된 작업 폴더에서의 `status`.
- 미검증: **실제 실행 중인 앱과의 왕복**. 실제 앱에는 어떤 요청도 보내지 않았고 렌더·실제 미디어 처리도 하지 않았다. 패키지 앱에는 포함하지 않는다(`dist-mcp`와 같음).

## 블로그 자동 저장·실시간 동기화 — 2026-11-05

- [x] 원인: 문단 안 빈 줄이 `문단 내부의 빈 문단·HTML은 지원하지 않아요.`로 저장 전체를 막았고, 외부 변경 뒤에는 기준 revision이 만료됐다. 빈 줄은 문단 나눔(서식 유지, 새 ID), `< >` 등 예약 글자는 비슷한 글자로 저장, 문제 있는 문단만 보류.
- [x] 1.2초 자동 저장(한 번에 하나, 최신 상태 우선, 문단 이탈·창 가림·페이지 닫기 저장, 재시도), 삭제·사진 8초 유예, ⌘S 즉시 저장. 마크업 원고의 `다시 불러오기` 제거, 프레임은 저장·외부 변경에 재로드 없이 제자리 갱신.
- [x] 외부 변경은 기존 폴링의 revision으로 감지(`fs.watch` 없음, 최대 약 1.5초). 로컬 변경은 3-way 병합, 진짜 충돌은 쓰던 글 유지·`.history/conflict-*.md` 보관·작은 알림. 기준은 메모리·페이지 `baseText`·`.history`로 복구, BUSY는 재시도, 120초 넘은 잠금 인수.
- [x] 리뷰 지적 반영: 분할 재전송 멱등, 분할로 옮겨간 오류 허용·문단 단위 보류, 저장 중 되돌림 우선, 남은 편집의 기준 유지(문단 안 줄 병합·제목 포함), 낡은 지연 적용 제거, sync와 엇갈린 입력 보호, 포커스 문단 외부 삭제 대응, 전송 중 삭제 취소 차단, 사진·스티커 자리 추적, 거부 항목 재시도·`일부 저장 안 됨` 표시·닫기 경고, 빈 제목·긴 제목 표시, 삭제 충돌 알림, 알림 고정. 제안 적용의 변경 묶음 표시 회귀 수정.
- [x] 합성 fixture로 타입/FSD/공개 소스 검사, 단위 전체 342개, 편집기·인접 웹 headless 81개, 자동 저장·사진 spec 3회 반복 69/69, Electron background QA 블로그 4개 파일 7개 통과·2개 건너뜀. 웹 전체 스위트는 실행하지 않음.
- [x] 최종 재검증: 타입/FSD/공개 소스, 단위 342개, 웹·데스크톱 빌드 통과. 웹 headless `canonical-*`·`blog-stickers`·`blog-photo-picker`·`markup-*` 64개를 3회 실행해 192/192(재시도 없음). Electron background QA `blog-projects` 2개 통과, 블로그·마크업 7개 파일로 넓혀 14개 통과·4개 건너뜀(실원고·실모델·실URL 환경변수 필요).
- 코드만 확인: 앱 닫기 확인 대화상자(`will-prevent-unload`), 64KB 초과 닫기 경고, 30초 자동 재시도 타이머(⌘S 재시도만 시험), 문단·스티커 거부의 화면 표시.
- 실제 원고·실행 중인 앱에서는 미검증(앱 미교체·패키지 미생성). 한글 IME 조합 중 나눔 지연은 실제 IME로 시험하지 않음. 옛 레이어 형식은 수동 저장 유지. [동작·한계](docs/canonical-blog-editor.md#자동-저장실시간-동기화--2026-11-05).

## 이미지 추출 표준 루프 — 2026-11-04

- [x] `scripts/evidence-loop.ts`: spec 하나로 프레임 추출·정확 사본 정리·영구 보관·분석·국소 교정·병합·표·검증을 재실행 가능하게 처리. `connect`는 통과한 결과만 편집기 사진 창에 연결.
- [x] 단위 12개, 타입 통과. 태백관 실제 실행 재현: 병합 486행 차이 0, 입력 570경로→486장·사본 84. 실제 신규 실행: 하남 92개 촬영·417장 53배치와 교정 52행, 검사 6개 통과(개인 기록은 vault). [단계·계약](docs/media-evidence.md#standard-loop--2026-11-04).

## 블로그 편집기 사진 고르기 — 2026-11-04

- [x] 상단 `사진 넣기` 창에서 전체 이미지 분석 결과를 검색·촬영물 필터·상세 확인하고, 문단·사진 사이 자리에 넣어 `정본 저장`으로 반영. 저장 시 SHA-256 대조 후 `<imageId>` 이름으로 미디어 폴더에 복사. 얼굴 후보·이미 쓴 사진 표시.
- [x] 전체 단위 279개(새 11개 포함), 편집기 웹 headless 43개(새 2개 포함), 타입/FSD/공개 소스 검사, 실제 486장 결과와 원고 개인 사본 저장·표시 확인. Electron은 프로젝트 열기 회귀 2개만 실행했고 이 창을 앱 안에서 직접 조작하지는 않음. 패키지 앱 미교체. [사용법·계약](docs/canonical-blog-editor.md#사진-고르기--2026-11-04).

## 전체 캡처·이미지 데이터 추출 구간 — 2026-11-04

- [x] 선정본과 별도로 전체 입력 manifest를 검증하고 기존 이미지 분석 어댑터로 처리하는 CLI. 출처·시각·최신 맥락 보존, 성공 배치 재사용, 누락·실패·입력 변경 검증.
- [x] 전체 이미지 메타데이터 표 자동 생성·기존/병합 결과의 표 렌더 CLI. 실패 행·출처·시각·모든 분석 필드 보존.
- [x] 합성 분석기 단위10개, 타입/FSD 검사 및 실제 CLI 입력검사·표 렌더 검증 통과. 개인 미디어와 실제 실행 결과는 콘텐츠 작업공간에서 관리.
- 앱 UI·저장 DB·기존 세 프레임 샘플링 동작은 변경하지 않음. [입출력·검증·구간 범위](docs/media-evidence.md).

## 구절 채팅 — 2026-11-04

- [x] 드래그 빠른 도구에 `채팅에 추가`. 구절 칩 첨부, 질문/후속 질문, 답변 diff의 `본문에 반영`(저장 전, 최신 글에서 재검증), `답변을 메모로 남기기`(비공개 주석).
- [x] 읽기 전용 `POST /api/blog/chat` → 워크플로 `chat-blog`(프로토콜 3). 단위 5개, 웹 headless 2개(20회 반복 40/40), 기존 `canonical-*` 회귀 통과. 실제 SDK 답변 품질·Electron은 미검증. [사용법·계약](docs/canonical-blog-editor.md#구절-채팅--2026-11-04).

## 사진에서 구성하는 초안 — 2026-11-03

- [x] Claude Fable과 단계 위치·계약·구현을 3회 논의. 근거 준비에서 전체 장면을 확보하고 경험/추가 작업 뒤 draft의 첫 작업으로 사진 선택·묶음·순서를 결정. 새 그래프 단계 없음.
- [x] 장면 목록·출처 있는 맥락과 선택 계획, 미리보기 해시 추적, 누락/중복/미지 ID/오래된 입력 검증. 문구 수정 시 기존 계획의 유효성 재확인. 기존 비미디어 run과 국소 수정 동작 보존.
- [x] 관련 테스트36개, 보강된 수정 단계 검사, 타입/FSD, 웹·데스크톱 빌드 통과. 앱은 일반 계약만 포함하며 개인 사진/시험 기록은 콘텐츠 저장소에 보존.
- 실행 중인 앱·서버는 교체하지 않음. 프로토콜2 검사 적용은 업데이트된 서버부터. [단계·입출력·검증 한계](docs/photo-first-drafting.md).

## 데스크톱 워크플로 서버 내장 — 2026-11-03

- [x] 앱이 워크플로 서버를 직접 띄움(`npm run start:server` 별도 실행 불필요). 호환 서버 재사용, 이전 버전 서버 감지·안내, 시작 실패 안내, 공유 서버 종료 시 인계, 종료 시 실행 중 AI 작업 확인.
- [x] Electron에서 better-sqlite3 대신 `node:sqlite` 체크포인터 사용, CJS 번들의 `import.meta.url` 보정, Finder 실행 시 codex PATH 보강.
- [x] Electron QA는 포트 0·프로필별 데이터만 사용(4318·실제 데이터 미접촉). [동작·설정](docs/workflows.md#desktop-embedded-server--2026-11-03).

## 기본 스티커 배치 — 2026-11-03

- [x] 묶음 맥락·화면 리뷰용 prepare/finish/apply CLI, 현재 원고·서식/스크린샷 지문 및 역할/범위 검증, 스티커만 저장 후 재검토 계약. 독립 스킬 워크플로 연결·태백관 실원고 리뷰 재실행(개인 기록은 vault), 관련 단위6개·타입/FSD 통과.

- [x] 정본 편집기에 인사·맛있다·추천·마무리 용도와 사진/문단 사이 자리 추가·이동·삭제·선택 메모. 실제 네이버 이미지와 자리 표시를 구분.
- [x] 마크업 정본/미리보기 저장·다시 열기, 기존 본문/부분서식 보존, 저장 실패 유지, 네이버 배치 메모 복사와 공식 사용 안내.
- [x] 관련 단위 19개, 웹 3개(390/1440px 포함), 개발/새 패키지 Electron 각 1개, 타입/FSD/웹·데스크톱 빌드 통과. 실제 네이버 스티커 선택·삽입과 개인 원고 수정은 미실행. [사용법·계약](docs/blog-stickers.md).

## 블로그 프로젝트별 열기 — 2026-11-02

- [x] 블로그 기본 화면을 프로젝트 카드 목록으로 변경. 프로젝트 ID로 원고·사진·검토 연결을 선택하고 프로젝트별 서버/창 분리, 같은 프로젝트 재열기 시 기존 창 재사용.
- [x] 로컬 프로젝트 등록 목록 검증·새로고침·빈 목록/오류 안내. 단일 정본 기본 열기 제거. 기존 원고·배치와 레퍼런스 도구 보존.
- [x] 타입·FSD·관련 단위3개, 개발 Electron6개, 패키지 Electron7개 통과. 두 프로젝트 저장 격리·재시작·실제 원고/사진 읽기와 원본 보존 검증. 실모델 검토 실행 검사는 제외.
- [x] 기존 로컬 원고를 프로젝트로 명시 연결하고 이전 앱을 백업해 사용 중인 설치 위치에 새 패키지 반영. [연결 구조와 사용법](docs/blog-workspace.md#프로젝트로-열기--2026-11-02).

## 외부 편집용 로컬 미디어 준비 — 2026-11-02

- [x] 등록 프로젝트 자료의 선택 파일만 로컬 폴더로 준비하는 서비스·CLI. 원본 보존, 권한/파일명/출력 경로 검증, 기존 폴더 덮어쓰기 거부, SHA-256 대조·영수증.
- [x] 관련 단위·타입·FSD 검사, 실제 콘텐츠 영상6개 복사 검증과 OpenCut 가져오기 완료. 개인 경로/결과는 콘텐츠 작업공간에 보존.
- 설치 앱의 신규 UI/MCP가 아니라 기존 자료 서비스를 재사용하는 CLI다. [사용법](docs/local-editor-handoff.md).

## Workdesk UX·안정성 적용 — 2026-11-02

- [x] 작업 이력·SDK 진행을 Slack식 행과 안전한 Markdown으로 표시, 작업별 결과 초안 보존.
- [x] 개발모드 화면 검사·코드 위치·의견을 기존 요청에 추가, 명시적으로 Codex 실행.
- [x] 검색 키보드 탐색·결과 제한, Finder PTY UTF-8 기본값, MCP 응답 공통화·동일 검토 중복 시작 방지.
- [x] 창 비활성 시 새 워크플로 완료·실패 알림과 작업 이동, 초기 이력·중복·QA 알림 억제.
- 적용 대상·기존 대응·Workdesk 전용 제외 항목과 검증은 [적용 기록](docs/workdesk-adoption.md)을 따른다.

## 앱/MCP 영상 처리 로그 — 2026-11-01

- [x] 공통 로그 계약·로컬 영속 저장소를 먼저 구현하고 영상 편집·카드뉴스·보관함 재생용 변환·분석 프레임 추출에 연결. 시스템 전체 Python/FFmpeg 수집 없음.
- [x] **실행 로그** 공통 컴포넌트: 실행 중/종료 필터, 시작·갱신·종료 시각, PID·진행률·종료 코드/신호·진단 출력. 재시작 중단은 실제 프로세스 종료와 구분.
- [x] 합성 프로세스/실제 편집 엔진으로 보존·실패·종료·외부 작업 제외를 검증. 사용자 설치 앱 교체는 포함하지 않음. [설계·검증](docs/execution-logs.md).

## AI 실행 관측 — 2026-11-01

- [x] Codex OTel 실행 모델·추론/버전과 SDK 토큰 수집, 인증 시도별 상태·역할·지침 해시·시간 기록. 로컬 기본값, 공식 OTel exporter와 선택적 Langfuse 매핑 분리.
- [x] 단가 카탈로그/비용 산정 분리, 캐시·추론 중복 산정 방지, 미확인·구독 인증 구분. [계약·근거](docs/ai-observability.md).

## 정본 스마트 에디터 — 2026-11-01

- [x] 강조 구절별 역할·방법·이유·대안 판단, 360·390·430px 실제 캡처의 SDK 전달, 화면 미검증/통과/재확인 구분.

- [x] 저장 전·저장 중·완료 시각·실패 표시, 검토 전 저장 안내와 동일 revision 다시 불러오기 동기화.

- [x] 묶음 전체 변경 대신 제안 대상 구절·서식별 적용 가능 판정, 여러 제안 연속 적용과 기존 부분서식 보존.

- [x] 구절 옆 색·형광펜·메모·체크, 비공개 주석 영속화와 본문 변경 감지. 기존 크기 오류를 유지한 사용자 색상 저장 지원.

- [x] 마크업 원본 편집·병합 저장·부분 강조 역할 보존, 앱에서 직접 서버/창 열기. [통합 설계·사용법](docs/markup-editor-integration.md).

- [x] 실제 정본·묶음·사진·콜라주·글꼴을 여는 웹 편집기, 본문 직접 편집과 선택 구절 서식, 정본/강조/미리보기 저장 및 백업, 외부 변경 차단.
- [x] 기존 리뷰 표시·후보 본문 반영, 명시적 버튼으로 엔진 작업 폴더에 검토 요청. [동작·범위](docs/canonical-blog-editor.md).
- [x] AI 제안을 본문 대상 문구 위치에 diff·서식 샘플로 표시하고 그 자리에서 적용/현재 유지. [본문 내 제안 검토](docs/canonical-blog-editor.md#본문-내-제안-검토--2026-11-02).
- [x] 마크업 검토 요청 소비 → 실제 SDK 실행 → 상태/결과 자동 갱신, 원문 검증·중복 실행 방지·실패 재시도.
- [ ] 사진 배치/묶음 구조 직접 편집.

## Codex SDK 실행기 — 2026-11-01

- [x] 로컬 채널 브리지 누적 조사: 기존 브리지의 세션별 중복 resume·하위 프로세스 잔류와 별개인 SDK/이미지 분석 경로에 `CODEX_LOCAL_CHANNEL_DISABLED=1` 적용. 관련 단위9개·타입·아키텍처·데스크톱 빌드 검증. 실행 중인 서버·설치 앱 교체는 포함하지 않음. [관계·수정 범위](docs/workflows.md#codex-sdk-execution--2026-11-01).
- [x] 현재는 저장된 Codex 로그인 사용. 추후 서버 API 키 설정 시 API 우선, 작업 시작 전 인증·사용량 오류에서만 로그인 폴백. 키 생성·저장 없음.
- [x] 단계별 명시 실행·중지·진행/인증/사용량 이력, 중복 실행·원고 변경 차단. Dashboard·정본 블로그 UI·CLI·MCP가 공통 서버 사용.
- [x] 실제 로그인으로 합성 작업 실행·결과 저장·다음 단계 이동 확인. 현재 단위120개·Dashboard 웹2개·정본 SDK 웹1개·Electron 연결1개 통과. API 경로는 모의 테스트이며 실키 검증하지 않음. [계약·검증](docs/workflows.md#codex-sdk-execution--2026-11-01).

## Headless 제작 워크플로 — 2026-11-01

- [x] LangGraph 외부 작업 요청·결과 제출·수정 루프, SQLite 재개, 웹·CLI·독립 MCP 경로. 모델 API 없이 현재 Codex 세션이 작업한다.
- [x] 단위101개·워크플로 브라우저1개·기존 웹/셸10개, 타입·아키텍처·웹/데스크톱 번들 검증. 실제 글 작성·네이버 이관은 이번 검증 범위가 아니다.
- 문안/사진 도구는 기존 구현을 유지하며 Electron 전체 기능의 웹 이식은 아니다. [동작·검증 범위](docs/workflows.md).

## 블로그 레퍼런스 탐색 — 2026-10-31

- [x] 기존 블로그 탭의 원고/레퍼런스 화면 분리, 구조 Markdown/JSON 가져오기·원본/도식·부분서식 검사.
- [x] 실제 자식앵커 사용·없는앵커 위치유지, URL/크기/스키마 검사.
- [x] 2026-11-01: 분석 결과 폴더 등록·재시작 후 목록 복원·클릭으로 구조 및 기존 템플릿 미리보기 열기.
- [x] 2026-11-01: 앱 내 URL 추출(숨김 격리 창)·교차검증·결과 등록·복원 뷰어 높이 대조, Dashboard MCP `reels_extract_blog_reference`/`reels_list_blog_references`. [사용법](docs/blog-workspace.md#url-추출--2026-11-01).
- [ ] 지도 블록을 원본 크기 자리표시로 그려 높이 대조에 포함. 복원 뷰어를 앱 화면의 React 컴포넌트로 이전할지 결정.
- [x] 2026-11-01: 패키지 빌드·설치(이전 앱 `release/production-projects-before-blog-url-extract/` 보존) 후 실행 앱에서 MCP URL 추출 확인.
- [x] 2026-11-01: 결과 목록 자동 갱신(MCP 변경 포함), 연결 해제 버튼, MCP `reels_link_blog_reference`/`reels_unlink_blog_reference`. 옮겨진 판교 결과 폴더 재연결.
- [x] 2026-11-01: 구조 run 원문 저장·구조 탐색 원문 표시(`release/blog-url-extract-3` 설치). 기존 등록 해제 후 애둔·해달을 앱 MCP로 재추출(`side/blog/research/reference-restore/`).

## 블로그 작업 — 2026-10-31

- [x] 기존 프로젝트의 명시 연결 Markdown 중 선택한 구간과 연결 사진으로 배치, 순서 조정·기기 내 비공개 저장/재열기·모바일/PC 미리보기. 원고 정본은 수정하지 않음.
- [x] 선택한 render-spec JSON을 블록 목록으로 사전 검토한 후 가져오기. 소제목·정보 상자·강조·사진·네이버 자리 표시와 주요 스타일 반영, 외부 이미지 URL 및 미연결 파일 차단.
- [x] 합성 서비스/백그라운드 Electron 검사. 네이버 전용 카드·게시, 사진 묶음 재편집, 지정 글꼴 설치는 지원하지 않음. [사용법](docs/blog-workspace.md).

## 얼굴 모자이크 — 2026-10-31

- [x] 기존 Codex 이미지 분석에 정규화 얼굴 후보 추가. 자동 탐지 누락 가능성을 표시하고, 분석 UI에서 상자 확인·추가·삭제·강도 선택.
- [x] 편집 엔진의 결정적 픽셀 모자이크로 새 PNG와 영역·설정 sidecar 저장. 원본 변경과 덮어쓰기 거부.
- [x] 합성 이미지 엔진·서비스 및 백그라운드 Electron UI 검증, 타입/FSD·기존 단위 검사.
- HEIC·영상은 분석용 정지 프레임만 출력하며, 전체 영상 추적·익명화는 지원하지 않음. 실제 Codex 얼굴 탐지 정확도는 검증하지 않음. [사용법](docs/media-analysis.md#face-mosaic-review-workflow).

## 프로젝트 미디어 분석 — 2026-10-31

- [x] 사진·영상 표본 전처리, 교체 가능한 이미지 분석기 계약, Codex CLI 어댑터.
- [x] 프로젝트별 분석 이력·사람 수정 분리, 설명·태그·OCR 검색, 카드 대화상자·IPC·MCP 연결.
- [x] 타입/FSD·전체 단위78개·개발 Electron7개·패키징 Electron7개 통과. 실제 미디어 분석 결과는 콘텐츠 작업공간에 별도 기록.
- [x] 가게·위치·방문일·메뉴·주변·파일별 맥락 입력/재사용, 실행별 맥락 보존, 관찰/OCR/기록 근거 구분(context-v2).
- [x] Codex 실행별 읽기 전용 배치 MCP·필수 맥락 조회/영수증 검증, 프로젝트 지침·기억·앱/플러그인·환경변수 유입 축소(context-v3-mcp). 완전한 컨테이너 격리는 아님.
- [ ] Claude·로컬 모델 어댑터, 연속 영상·음성 분석은 후속 범위.

[사용법·구조·검증 범위](docs/media-analysis.md).

## PhotosIndex 고정 서명 — 2026-10-31

- [x] 로컬 Developer ID Application 단일 서명 정책, 기존 식별자 유지, 인증서 선택 모호성·누락 시 실패.
- [x] 구형 로컬 development/adhoc 경로·테스트의 자동 임시 서명 제거. CI 일회성 모드만 별도 제한.
- [x] 사용하지 않는 브랜드·타이틀바·푸터 DOM/CSS 정리.
- [x] signer 정책 회귀, 타입/FSD·단위76개·Swift101개·화면 검사 통과.
- [x] 사용자 승인으로 G1 중간 인증서 신뢰 기본값 복원. 서로 다른 바이너리의 동일 서명 요구조건·실제 재빌드45회 응답·재설치 검사 통과.

[서명 정책과 권한 유지](docs/native-signing.md).

## 큰 창·상단 도구·터미널 — 2026-10-31

- [x] macOS 타이틀바 통합, 기본 1600×1000 창, 큰 소개 타이틀 제거·전체 폭 작업 영역.
- [x] 좌측 뒤로/앞으로·최근 화면 히스토리·메뉴/콘텐츠 검색, 우측 설정.
- [x] 개발 메뉴 제거·독립 터미널 버튼과 기존 PTY/탭/단축키 유지.
- [x] 통합 소스 단위76개·타입/FSD, 별도 main 후보 단위30개·웹59개·Electron13개 통과.

[변경과 검증 범위](docs/workspace-shell.md).

## 제작 프로젝트 모델·병합 — 2026-10-31

- [x] Dashboard→제작 프로젝트→영상/카드뉴스 편집·출력 이력·자료 관계와 JSON Schema 추가. 소유권/별칭/참조 무결성 검증.
- [x] 수정 화면의 프로젝트 병합·저장된 편집 연결, revision 보호·전체 백업·MCP3개. 영상/표지/카드뉴스 후속 출력을 대표 프로젝트에 연결.
- [x] 전체 단위·타입/FSD·빌드, 개발 및 패키징 Electron 각3개 통과. 실제 중복 콘텐츠 병합·기존 자료 보존·편집3개 연결·앱 화면 확인.
- 앱: `release/production-projects/mac-arm64/Reels Dashboard.app`. [모델·스키마·사용법](docs/production-projects.md).

## Workdesk 방식 개발 작업공간 탭 — 2026-10-31

- [x] 콘텐츠 화면을 유지하는 하단 패널, 고정 탭바·Codex 시작·새 터미널·접기/패널 닫기.
- [x] `⌘N/T/W/1–9` 공통 액션·호스트 입력 처리. iframe 포커스에서도 동작하며 IME·키 반복·일반 모드 구분.
- [x] 탭 전환·접기 후 xterm/PTY 유지, 비활성 입력·resize 차단, 실제 종료 확인 후 탭 제거·인접 탭 선택.
- [x] 조사·분담 구현·독립 리뷰 후 iframe 단축키 누락 수정. 타입/FSD·전체 단위71개·수정 후 관련7개·개발 Electron13개 통과, 데스크톱/760px 화면 확인.
- [x] 패키징 탭 검사4개 통과. 현재 사용 중이던 `release/production-projects/mac-arm64/Reels Dashboard.app`를 갱신하고 개발모드로 재실행, 실제 `⌘N` 접기/펼치기 확인. 이전 앱은 `release/production-projects-before-workspace-tabs/`에 보존.

[단축키·동작·검증 기록](docs/development-workspace.md#작업공간-탭과-단축키).

## 진행 중 작업 우선 대시보드 — 2026-10-31

- [x] 앱 시작·필터 초기화는 진행 중 작업, 전체 보기는 보조 버튼과 필터 마지막 항목으로 이동. 정렬·카드/목록 선택 유지.
- [x] 단위4·웹5·패키징 Electron1·타입/FSD/빌드 통과. 기존 사용자 데이터로 새 앱 실행·화면 확인.
- 앱: `release/active-board/mac-arm64/Reels Dashboard.app`. [동작·검증](docs/local-content-library.md#active-first-dashboard--2026-10-31).

## 환경변수로 켜는 개발 작업공간 — 2026-10-31

- [x] `REELS_DEV_MODE=1`에서만 개발 작업공간·PTY 관리자·IPC·preload API 활성화. 일반 실행은 비활성.
- [x] Codex 기본 도구, 호스트 provider registry와 UI 계약 분리. Claude Code는 이후 지원용 어댑터만 보존하고 현재 시작 요청 거부.
- [x] 조사·호스트/provider 분담 구현·독립 리뷰·Electron QA를 상위 에이전트가 통합. 타입/FSD·단위64개·빌드·개발 Electron9개 시나리오 통과.
- [x] 실제 터미널 임시 소스 수정과 Codex 초기 화면 확인. 모델 작업 제출 및 새 패키징 앱 검증은 수행하지 않음.
- [x] 후속 요청으로 패키징·실행 앱 갱신: 개발모드 ON/OFF·PTY 파일 수정·Codex 초기 실행 6개 통과. 기존 `release/active-board/mac-arm64/Reels Dashboard.app`를 갱신하고 실제 사용자 프로필에서 `REELS_DEV_MODE=1`로 재실행·Codex 기본 화면 확인. 이전 번들은 `release/active-board-before-dev-mode/`에 보존.

[실행 방법·리뷰·검증 기록](docs/development-workspace.md). 빌드 후 `REELS_DEV_MODE=1 npm start`로 실행한다.

## 촬영 지도·시간별 핀·사이트 동기화 — 2026-10-31

- [x] 등록 지도 JSON 기반 공통 지도·시간선택·영상/사진 필터·불확실GPS 토글·기존 등록원본 연결.
- [x] 앱·브리핑사이트 동일 DTO, 변경본문 hash 감지, 큰지도 제외로 다른 콘텐츠 동기화 유지.
- [x] 타입·FSD·빌드·관련단위·웹2·개발/패키징Electron각1·사이트D1/계약 검사 통과.
- [x] 새앱 실행, 기존Sites v4 배포·bridge재시작·실제68핀 서버반영·앱/390px사이트 화면 확인.

[사용법](docs/route-map.md) · [통합검증·한계](docs/route-map-release.md). 사이트 원본재생은 기존 비활성 상태를 유지해요.

## 카드뉴스 선택지 정리 — 2026-10-30

- [x] 카드 종류를 문구·비교표·마무리3개로 정리. 별도 역할 선택 제거·큰 요약은 문구강조 옵션.
- [x] 기존5개 렌더템플릿/저장본은 유지하며 선택UI만 단순화. 문구·미디어·시간 보존.
- [x] 현재 사용법을 문서앞에 두고 과거변경 이력은 접기 처리.
- [x] 타입·FSD·빌드·관련단위5개·웹3개·새 패키징앱 영상혼합/저장/출력1개 통과. 앱: `release/card-news-simple/mac-arm64/Reels Dashboard.app`.

## 카드뉴스 템플릿 강제 — 2026-10-30

- [x] 최신 행간 정정: 고정 여백64px 대신 글자크기×1.5, 본문각주는 마지막 줄 아래32px. 표간격 유지·엔진7개 통과.

- [x] 비교표10행·내용 기반 제목/표/각주 배치. 상단40px·하단32px,엔진6개/웹2개/타입/빌드 통과. `release/card-news-table/mac-arm64/Reels Dashboard.app`.

- [x] 후속 정정: 템플릿별 줄 시작간격 대신 실제 글자 사이 여백64px를 공통 적용. 훅·본문·요약·팔로우 간 회귀검증 추가(엔진5개). 새 앱 `release/card-news-line-gap/mac-arm64/Reels Dashboard.app`.

- [x] 훅·본문·큰 요약·비교표·팔로우5종과 단일 크기 프리셋. 문장별 스타일·커스텀 PNG 우회 거부.
- [x] 미리보기·MP4에서 내장 템플릿 엔진 재생성, 기본 UI의 글자 크기·PNG 오버레이 입력 제거.
- [x] 실제 콘텐츠를 데이터만으로6장12초 재출력. 과거 개별 렌더러·산출물은 이력으로 보존.
- [x] 타입·FSD·명세 보존·단위52개·템플릿 엔진4개·기존 엔진13개·웹2개·개발/패키징 Electron 각2개 통과. 새 앱: `release/card-news-templates/mac-arm64/Reels Dashboard.app`.

[현재 제작 계약](docs/card-news.md#템플릿-강제--2026-10-30-후속-정정).

## 카드뉴스 영상 배경 — 2026-10-30

- [x] 영상 선택·인점·사진 혼합, 원본 길이 초과 거부, 실제 움직임 미리보기·MP4.
- [x] 투명 PNG 오버레이로 기존 표·서명 디자인 보존. 원본 소리는 무음, 선택 BGM은 기존 경로 유지.
- [x] 타입/FSD/명세·전체 단위51·웹3·개발 Electron 영상1 및 기존 사진/음악1 통과. 기존 오디오 시계 대기 최초 실패·재실행 통과를 문서에 기록.
- [x] 별도 앱 번들 `release/card-news-video/mac-arm64/Reels Dashboard.app` 생성 및 패키징 Electron2개 통과, 실행 중인 앱 보존.
- [x] 콘텐츠 작업공간의 실제 원본 영상4+사진2로 서비스 경유12초 출력. 개인 미디어는 이 저장소에 복사하지 않음.

[사용법·검증 한계](docs/card-news.md#영상-배경--2026-10-30).

## 카드뉴스 릴스·음악·MP4 출력 — 2026-10-29

- [x] 독립 카드뉴스 화면: 사진·문구·카드 역할·순서·시간·글자 크기·배경 어둡기.
- [x] 6장·24초 시작값, 글자 수와 역할별 읽기 시간 추천, 수동 BPM 기준 박자 맞춤. 공개 성과 사례와 추천의 한계를 화면에 표시.
- [x] 로컬 음악 선택·시작 구간·볼륨·반복, 사진/문구와 함께 재생 미리보기.
- [x] revision 기반 구성 저장·재열기, 선택 미디어의 앱 전용 사본 보관, 기존 영상 편집기와 분리.
- [x] 1080×1920·30fps H.264/AAC MP4, 완료 후 콘텐츠 보드 연결, 덮어쓰기 거부·진행률·취소.
- [x] 타입·FSD·명세 보존·빌드, 단위48개, 관련 웹19개, 개발 및 패키징 Electron 각1개 통과. 합성 미디어로 실제 45프레임/1.5초·장면 경계·오디오·원본 보존·재시작·취소 검증.
- [x] 저장소 전체 공개 소스 검사: 2026-10-31 통합 정리에서 가상 경로 정정 이후 전체 검사를 다시 통과했어요.

새 앱: `release/card-news/mac-arm64/Reels Dashboard.app`. [사용법·공개 연구 근거·검증 경계](docs/card-news.md). 현재 실행 중인 기존 앱을 덮어쓰지 않았어요. 개인 콘텐츠와 음원은 패키지에 포함하지 않아요. 웹 회귀 검사 중 trace 산출물 충돌로 실패한 2개는 별도 출력 폴더에서 재실행해 통과했어요.

## 개발 작업공간 — 2026-10-28

- [x] Workdesk 구조를 참고한 호스트 PTY 관리자·공통 계약·FSD 화면 분리.
- [x] Codex·Claude Code·일반 터미널, 세션 전환·출력 복원·종료·소스 폴더 연결.
- [x] 설계·구현·리뷰·수정 프롬프트와 검증 실행, 로컬 웹 미리보기·기존 운영 사이트 열기.
- [x] 통합 개발 checkout 단위41·패키징 Electron4개. 푸시 대상만 분리한 snapshot 단위21·Electron4·타입·FSD·빌드·공개 소스 검사 통과.

사용자가 단계 결과를 전달하는 개선 루프이며 자동 배포나 무인 반복 실행은 포함하지 않아요. [설계·사용법·리뷰 기록](docs/development-workspace.md). 새 앱: `release/workbench/mac-arm64/Reels Dashboard.app`.

## 콘텐츠 보드 탐색 UX — 2026-10-28

- [x] 최신 날짜 기본 정렬, 오래된순·제목순·작업 우선순 선택.
- [x] 제목·할 일·자료 검색, 진행 단계·날짜 종류 복합 필터와 결과 수·초기화.
- [x] 현황 카드 클릭 필터, 카드/간결한 목록 전환, 12개씩 더 보기와 보기 설정 유지.
- [x] 단위3개·관련 웹8개·패키징 Electron2개·타입/FSD/빌드 검사 통과. 데스크톱·모바일 배치 확인.

[정렬과 필터의 기준](docs/local-content-library.md#board-search-sorting-and-views--2026-10-28). 새 앱: `release/board-ux-final/mac-arm64/Reels Dashboard.app`.

## 앱 아이콘·설명 — 2026-10-28

- [x] 전용 Dock/Finder 아이콘과 1×/2× 메뉴바 template 아이콘, 열기·앱 정보·종료 메뉴.
- [x] 실제 제작 기능에 맞춘 패키지·웹 메타·앱 정보 설명.
- [x] 빌드·타입·구조 검사, 패키징 앱 리소스 로딩·창 복원 테스트1개 통과.
- [ ] 메뉴바 외관·앱 정보 패널 수동 확인: UI 도구 타임아웃으로 미확인.

[변경과 검증 범위](docs/application-identity.md). 새 앱은 `release/app-identity/mac-arm64/Reels Dashboard.app`이며 기존 실행 앱은 유지했어요.

기준일: 2026-10-27. 요청한 구현·검증·공개를 완료했어요. 이번 목표는 Electron·React 공통 화면과 PhotosIndex 대체 기능을 구현하고, 별도 웹·Electron QA 후 공개 저장소에 올리는 것이에요.

## 구현·검증 완료

- [x] 독립 저장소와 명세 작성 후 마이그레이션 시작.
- [x] 기존 26개 테스트 파일·75개 테스트 및 실제 UI·11개 명령의 명세 작성.
- [x] 역할·파일 소유권과 검증 단계가 있는 재사용 서브에이전트 워크플로우.
- [x] Electron main/preload와 공통 React renderer 분리.
- [x] 원본 75개 테스트 보존, 추가 포함 Swift 테스트85개 통과.
- [x] Photos 권한·색인·촬영 그룹·증거 페이지·OCR·분류 검증 연결.
- [x] 복사·이동 계획과 실행, 별도 확인, 실패·복구 UI 연결.
- [x] bundled Swift helper·CLI, 독립 소켓·실행 경로 확인·종료 정리.
- [x] 로컬 대시보드 영속 저장과 공유 항목 선택.
- [x] Sites용 공통 웹 화면·snapshot 계약·HTTPS 수신 API 연동 adapter.
- [x] 별도 Chromium 웹 UI 테스트42개와 데스크톱/모바일 화면 확인.
- [x] 패키징 앱 Electron QA8개와 라이선스 포함 확인.
- [x] TypeScript 단위 테스트9개·타입 검사·공개 소스 검사.
- [x] macOS 로컬 QA용 앱 번들 생성.
- [x] 실행 중 서명 바이너리 덮어쓰기 오류 수정 및 실제 재빌드 회귀 검증.
- [x] 단독 CLI의 paired helper 설치·재설치와 한글/공백 경로 종료 검증.

## 최종 확인

- [x] 사용자 허용 후 `authorized` 확인, 실제 날짜 색인·그룹 상세·한 자산 미리보기·Vision 분석·JPEG 디코딩 검증. 개인 라이브러리 정보와 이미지는 공개하지 않았어요.
- [x] 실제 미리보기에서 발견한 경로 표현 차이의 접근 거부를 수정 전 실패·수정 후 성공으로 확인하고, 허용되지 않은 파일과 최종 심볼릭 링크 거부도 유지했어요.
- [x] GitHub 공개 원격 push, PUBLIC·로컬/원격 HEAD 일치 확인. 구현 커밋의 [GitHub CI](https://github.com/albireo3754/reels-dashboard/actions/runs/40518829999) 전체 통과.

## 검증 범위

내보내기·이동의 실제 개인 사진 삭제는 자동 QA로 수행하지 않아요. 해당 동작은 기존 Swift 서비스 테스트와 synthetic 웹/Electron 시나리오에서 검사했어요. 실제 helper 실행 경로와 권한 거부 처리·종료는 패키징 앱으로 확인했어요.

이 기기에는 Apple Development 인증서가 없어 명시적인 ad-hoc 서명으로 QA했어요. 안정적인 개발 서명과 공증된 배포용 서명은 별도 인증서 설정이 필요해요. 실제 Sites 프로젝트 배포·수신 저장소 구축은 이번 연결 가능한 공통화와 구분해요.

## 영상 편집기 통합 — 2026-10-27

- [x] Photos의 선택 영상 및 로컬 영상을 편집 프로젝트로 연결.
- [x] 시간별 본문 자막, 장소 안내 묶음과 재질·노출 구간, 표지 시점·훅·배치 편집.
- [x] 기존 렌더러의 기본 배치·서체·HDR 출력 규칙 재사용, 같은 엔진의 합성 미리보기.
- [x] 프로젝트 저장·다시 열기, 실제 내보내기 진행률·취소·결과 확인.
- [x] 내보내기 완료 시 검토 대기, 설정 변경 저장 시 편집 중 상태 반영.
- [x] Python·Pillow·FFmpeg·ffprobe를 포함한 자체 실행 런타임과 macOS 앱 패키징.
- [x] 웹58·엔진11·TypeScript13·Swift95·패키징 desktop/editor8 검증.
- [x] 실제 Photos 영상 한 편의 private materialization·proxy 재생/탐색 검증. 개인 미디어는 공개하지 않음.
- [x] 새 개발 경로에서 빌드·패키징·실제 편집/내보내기·웹 검증. 이전 위치는 런타임 의존성이 아님.

자세한 사용 흐름과 검증 범위는 [편집기 문서](docs/editor-workflow.md)를 따라요. 이 편집기 구현 작업에서는 로컬 앱과 검증 기록을 준비했어요. 별도 채팅의 FSD·MCP 연동 작업이 같은 기반을 이어서 사용하고 있으며, 위 결과가 그 후속 변경의 완료를 뜻하지는 않아요. 기존 라우팅 문서와 모바일 TODO를 보존했어요.

## OpenCut 선택 적용 — 2026-10-28

- [x] OpenCut 재작성 버전과 현재 Classic 구현·MIT 라이선스·실제 소스 확인.
- [x] SRT parser를 출처·라이선스 고지와 함께 적용하고 기본 평문 VTT·SRT 저장 추가.
- [x] 검토 후 자막 교체, 현재 스타일 유지, 잘못된 파일 전체 거부, 변경된 편집 상태에 이전 파일 적용 방지.
- [x] 단위6·Chromium UI3·실제 패키징 파일 I/O1 검사 및 타입·FSD 검사 통과.

[조사·적용 기록](docs/opencut-adoption.md)을 참고해요. 전체 OpenCut 앱·다중 클립 timeline·undo/redo는 이번 적용 범위가 아니에요.

## 기존 콘텐츠·촬영 자료의 로컬 연결 — 2026-10-28

- [x] MCP에 로컬 미디어 폴더 목록, 콘텐츠 조회·가용성 검사, revision 기반 콘텐츠 등록·수정 추가.
- [x] 원본·완성본·표지·시안·문서·폴더 참조, 촬영 완료 단계와 촬영/게시/기록 날짜 구분.
- [x] 중복 ID 갱신·동시 수정 보호, 앱 카드 실시간 갱신과 등록 자료 위치 열기.
- [x] 로컬 경로·메모의 공유 snapshot 제외, 개인 데이터는 앱 로컬 저장소에서만 관리.
- [x] 단위29개·대시보드 웹4개·개발 Electron 관련7개·패키징 MCP 연결1개 통과. 구조·타입·공개 소스 검사 통과.
- [x] 실제 로컬 자료를 MCP로 등록하고 전체 재조회. 개인 자료의 상세 목록과 등록 증거는 콘텐츠 작업공간에서 관리.

[사용 흐름과 범위](docs/local-content-library.md). 경로 연결은 Photos 다중 날짜 색인 영속화나 기존 영상의 재편집 프로젝트 복원을 뜻하지 않아요.

## 모바일 진행 브리핑 — 2026-10-28

- [x] 본인 전용 Sites 배포와 D1 관계형 메타데이터 테이블 연결.
- [x] 브리핑·콘텐츠 검색/필터·촬영함·자료 메타데이터 모바일 화면.
- [x] 로컬 MCP의 전체 진행 정보를 서버에 저장하고 공개 공유 설정은 보존.
- [x] Keychain 인증정보와 로그인 세션 서비스로 메타데이터 자동 동기화.
- [x] 실제 서버 DB 66개 항목·124개 자료와 비로그인 API 접근 차단 확인.
- [ ] [모바일 원본 열기·중계 검증 #13](https://github.com/albireo3754/reels-dashboard/issues/13): 별도 후속 작업. production 원본 읽기는 비활성화 상태를 유지해요.

[모바일 사이트와 운영 문서](docs/mobile-briefing.md). 실제 PostgreSQL 서버·Sites 전용 터널·전체 S3 프로토콜 호환을 구현했다고 표현하지 않아요.

## 브리핑 사이트의 앱 연결 — 2026-10-28

- [x] 대시보드·설정에 브리핑 사이트 열기, 서비스 연결 상태, 마지막 서버 저장 시각·항목 수 표시.
- [x] 기존 LaunchAgent의 인증정보 없는 상태 요약 연결, 45초 상태 만료와 기존 저장본 유지.
- [x] 타입·FSD·서비스 구문·단위1개·개발 Electron2개·패키징 Electron1개 검증.

[사용법](docs/mobile-briefing.md). 기존 자동 동기화 서비스와 Keychain 인증을 유지하며 앱 내부 업로드 기능으로 통합한 것은 아니에요.

## 이후 확장

- [ ] [홈 화면 추가형 모바일 앱(PWA) #8](https://github.com/albireo3754/reels-dashboard/issues/8): 2026-10-31 사용자 선택으로 착수. 기존 브리핑의 로그인·동기화를 재사용하며 설치 안내·standalone·연결 복구를 검증해요. 네이티브 WebView 패키징·PhotosIndex/영상 편집의 모바일 이식은 별도 범위예요.

여러 날짜의 Photos 색인 영속화, 다중 클립 타임라인과 실제 Sites 배포는 다음 확장으로 관리해요. 기존 PhotosIndex의 단일 날짜 메모리 색인 동작을 영속 색인 완료로 표현하지 않아요.

## 편집 중 템플릿 조정 — 2026-10-28

- [x] 재생 화면 옆에 기존 번호 프리셋5종의 구성 예시·선택 상태 표시.
- [x] 영상 장소 안내 묶음, 표지 훅·서명, 표지 장소 핀의 독립 상대 이동과 표지 고정 크기 입력.
- [x] 문구·자막 타이밍·표지 시점 보존, 저장/재열기·미리보기 무효화·실제 내보내기·MCP 설정 계약 연결.
- [x] 단위29·편집 웹21·엔진12·패키징 앱 실제 출력1 통과, 타입/FSD 검사와 패널 이미지 확인.
- [x] 실행 중인 앱을 유지하고 `release/templates/mac-arm64/Reels Dashboard.app`에 새 빌드 준비.

조작과 적용 범위는 [편집기 문서](docs/editor-workflow.md)의 템플릿 항목을 따라요. 영상 프록시 실시간 합성이나 새 다중 클립 타임라인을 추가한 것은 아니에요.

## 콘텐츠 보드 진행·미디어 프리뷰 — 2026-10-28

- [x] 카드에 대표 썸네일·미디어 목록 진입·진행 단계·다음 할 일 표시.
- [x] 네이버 클립 자료 목록/뷰어 구성을 참고해 재생기와 미디어 그리드를 함께 표시.
- [x] 연결 폴더 탐색·24개씩 더 보기·자료 종류 필터·영상/사진/오디오 선택·파일 없음 표시.
- [x] 선택한 영상만 로컬 재생 사본 생성, 등록 경로 한정 접근과 탐색용 Range 지원.
- [x] 새 편집 원본·내보낸 시안/표지를 보드에 연결하고 검토 상태를 실시간 반영.
- [x] 단위30·보드/대시보드 웹6·패키징3 검증, 합성 자료로 화면 확인.

[사용법과 범위](docs/local-content-library.md). 새 빌드는 `release/content-board/mac-arm64/Reels Dashboard.app`이며 공유 웹에는 로컬 미디어가 포함되지 않아요.

## 모바일 게시 문안 동기화 — 2026-10-28

- [x] 등록된 정본 문서의 캡션·댓글·대댓글 복사용 블록을 서버에 저장하고, 문안 수정 시각·초안 상태·부모 댓글을 표시.
- [x] 문안 내용 기반 변경 감지, 열린 상세 자동 갱신, 개별 복사와 콘텐츠 직접 링크.
- [x] 관련 단위5개·타입/FSD·로컬 D1 저장/재조회·브라우저 복사/갱신/모바일 배치·사이트 빌드 통과.
- [x] 기존 비공개 사이트 배포 및 비타민 세 문안과 로컬 정본의 완전 일치 확인. 기존 미디어 읽기 제한 유지.

원인·운영·검증은 [모바일 브리핑 문서](docs/mobile-briefing.md)의 게시 문안 자동 반영 항목을 따라요.

## 서명 있는 팔로우 마지막 장 — 2026-10-29

- [x] 영상 편집 6번 `rosy-follow`: 두 줄 안내·CTA·분홍 손글씨 계정·어둡기 편집, 장소 핀 없는 9:16 PNG.
- [x] 설정·agent patch 저장, 커버 단독 검증, PNG 저장 대화상자, 실제 미리보기와 공통 엔진 연결. 기존 표지·영상 경로 보존.
- [x] 타입/FSD·단위50·웹 템플릿3·내장 엔진13(HDR 포함) 통과. 개발 Electron1 및 패키징 Electron1에서 선택·수정·저장/재열기·실제 PNG 출력 통과.
- [x] `release/follow-template/mac-arm64/Reels Dashboard.app` 빌드. 현재 콘텐츠의 마지막 카드에 같은 엔진을 적용한 27초 v7 출력.

[사용법](docs/editor-workflow.md). 마지막 장 PNG를 내보내며 영상 뒤에 자동 삽입하지 않는다.

## 완성 카드 디자인 보존 — 2026-10-29

- [x] 카드별 선택 옵션 `imageOnly`: 완성 이미지 위에 글자·어둡기를 다시 덧그리지 않음. 문구는 기록/시간 추천용으로 저장. 기본 사진+문구 편집 경로는 유지.
- [x] 타입/FSD·단위50·웹2 통과. 픽셀 동일성, 일반 카드 경로와 분리, 사진 미선택 오류 확인.
- 빌드: `release/card-news-v7/mac-arm64/Reels Dashboard.app`. 기존 `card-news` 번들은 보존.
- [x] 패키징 앱의 실제 사용자 프로필에서 6장 가져오기·저장·앱 재시작 후 다시 열기·미리보기·24초 MP4 출력 확인. 완성 카드 미리보기는 원본 PNG 6장과 RGB 픽셀 동일. 개인 자료는 콘텐츠 작업공간과 앱 user-data에만 저장.

## Photos 위치·OCR MCP 검색 — 2026-10-31

- [x] `reels_photos_search`: GPS 반경·사진/영상 대표 이미지 OCR·선택 날짜 범위 검색.
- [x] `reels_photos_search_page`: 독립 스냅샷·페이지 처리·만료·실패 항목 분리. 날짜 색인은 유지.
- [x] GPS로 먼저 추린 뒤 리소스 조회, OCR 고품질 미리보기 사용.
- [x] 네이티브/TS 테스트 및 실제 stdio MCP→Electron→PhotoKit/Vision 검증, 별도 앱 패키징.
- 사용법·검증 범위: [MCP usage](docs/mcp-usage.md#photos-location-and-ocr-search--2026-10-31).
- 2026-10-31 통합 패키지를 기존 실행 경로에 적용하고 MCP 연결·기존 프로젝트 보존을 재확인했어요. [최종 통합 기록](docs/integration-release.md).

## 미커밋 기능 통합 정리 — 2026-10-31

- [x] 콘텐츠 보드·자료 탐색·프로젝트 통합·지도·카드뉴스·자막 파일·앱 아이콘·SDK의 남은 구현을 함께 검토하고 통합 검증.
- [x] 기존 제목 제거·활성 콘텐츠 기본 필터·preload 계약에 맞춰 Electron 회귀 검사 갱신. 숨김 음악 재생 검사는 실제 출력 장치 의존 제거 후 3회 연속 통과.
- [x] 오래된 편집 런타임을 소스부터 재빌드. 개인 계정 기본값이 남은 과거 번들을 현재 소스의 기본값으로 교체.
- [x] 단위76·웹75·개발Electron35·패키징5·편집엔진13·카드템플릿7 통과. 명시적 opt-in이 필요한 Electron6개는 미실행으로 구분.
- [x] Developer ID Photos 헬퍼·웹·Electron·미디어 런타임을 포함한 최종 앱 패키징 및 기존 경로 재실행. 기존 제작 데이터 보존과 MCP 재연결 확인.
- [x] 공개 소스·구조·타입·명세 보존 검사, 개인 운영 집계를 콘텐츠 작업공간으로 분리.
- 후속으로 명시된 모바일 원본 열기·모바일 앱 구현은 완료로 바꾸지 않아요. 메뉴바의 최종 외관 수동 검수도 자동 검증과 구분해요.

[통합 범위·검증·실행 기록](docs/integration-release.md).

## 이슈 현황 정리 — 2026-10-31

- [x] 구현·검증 근거로 #2(MCP), #3(자막 입출력), #7(배포·동기화)을 완료 처리.
- [x] 모바일 원본 읽기 #13 신규 등록, 로드맵 #9 갱신.
- [ ] 사용자 선택 다음 작업: #8 홈 화면 PWA. #4 일반 다중 클립 타임라인, #5 표지 별도 원본/보정, #6 다중 날짜 영속 색인은 계속 후속 작업으로 유지.

## 사진 기반 경험 질문 폼 — 2026-11-01

- [x] 준비 결과의 질문/근거/사진 계약, 경험 단계와 초안 진입 게이트.
- [x] 사용자 답변 일괄 입력·부분 저장·기억나지 않음/본문 제외·revision 충돌 보호·원문 JSON/Markdown 초안 입력 연결.
- [x] HTTP/CLI/MCP/기존 Desktop bridge 연결. Photos/레퍼런스 준비 작업은 기존 실행 세션이 수행.
- 검증 및 적용 기록: [경험 수집](docs/experience-intake.md).

## 답변 추가 요청의 개별 작업 처리 — 2026-11-02

- [x] 경험 제출→요청분류→개별 추가작업→초안/수정→검토. 원문인용·전체답변 검토ID·결과근거/상태 보존.
- [x] 기존 제출본 재분류 API/CLI/MCP/UI, session 작업 SDK 차단, 보류/재시작/동시입력 보호.
- [x] 단위157·관련14·웹4·패키지1·타입/FSD/빌드 검증. 사용법: docs/experience-intake.md.

## 대시보드·Codex 세션 공통 입력폼 — 2026-11-02

- [x] 그래프와 독립적인 폼/답변/원문 export/반영 이력 서비스와 공통 UI.
- [x] MCP/CLI 생성·조회·저장·제출·변경대기·결과출력·반영·앱창 열기, 기존 워크플로 바인딩.
- [x] 동일 ID/답변 공유·충돌 보호·워크플로 없는 세션 폼·네이티브 입력창 경로 검증.
- 계약과 검증: [공통 입력폼](docs/shared-input-forms.md).

## 분석 후 3단계 선별 — 2026-11-14

- [x] 별도 private 후보/묶음·대표/사용 데이터와 revision 보호 MCP 조회·실행·사람 수정. 후보 전부 보존, dHash·명암 기준 그룹, 분산 기준 대표와 이유, 수동 대표 유지.
- [ ] 후보·대표·사용 UI, 품질 전용 판단(현재 성공 결과 보존 + 수동 제외), 촬영 시각/컬러로 그룹 오탐 개선.
- [ ] 기존 콘텐츠·편집 원본/가져온 사본 경로 매핑을 통한 실제 사용 자동 집계. 현재 MCP로 실제 사용 명시 기록.
