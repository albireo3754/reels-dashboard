# PhotosIndex UI·기능 이관 명세

기준일: 2026-10-27. 실제 Swift 소스와 테스트를 읽어 작성한 이관 기준이에요. 이 문서의 **기존 동작**은 구현에서 확인한 계약이며, **대체 앱 요구사항**과 **QA**는 이후 구현·검증해야 하는 항목이에요. 문서 작성만으로 기능 이관이나 실기기 검증이 완료된 것은 아니에요.

아래 소스 경로는 이관할 `native/photosindex/` 아래의 상대 경로예요. 원본 작업공간의 절대경로, 사진 데이터, 계정 정보는 이 문서에 포함하지 않아요.

## 1. 목표와 대체 범위

Electron + React 앱이 PhotosIndex의 사용자 기능 전체를 제공해야 해요. PhotoKit·Vision·원본 복사와 검증된 이동은 Swift 구현을 유지하고, 서명된 native helper를 배포 앱에 포함해요. 기존 PhotosIndex 앱이 별도로 설치되어 있거나 실행 중이어야 하는 방식은 개발 중 연결 수단일 수 있지만, 대체 앱의 완료 기준은 아니에요.

기존 `photosindex` CLI 명령·JSON 계약·Swift 테스트를 보존해요. Electron renderer는 제한된 bridge를 사용하며, 임의 shell 명령이나 Photos 내부 식별자에 직접 접근하지 않아요. 공통 React 화면과 공개 데이터 형식은 웹 renderer 및 Sites에서 재사용하고, native 기능은 명시적인 desktop capability로 구분해요.

## 2. 현재 SwiftUI 화면의 정확한 범위

근거: `Sources/PhotosIndexApp/Views/ContentView.swift`, `ViewModels/AppViewModel.swift`, `PhotosIndexApp.swift`.

| 현재 요소 | 실제 동작 | 대체 앱 요구사항 |
| --- | --- | --- |
| 최소 640×420 창 | SwiftUI `WindowGroup` | 창 크기와 화면 축소 시 주요 작업을 사용할 수 있어야 해요. |
| 좌측 Timeline, Groups | `Label` 두 개이며 선택·탐색 처리가 없어요. | 실제 촬영 날짜 선택과 그룹 탐색 화면을 구현해요. |
| 앱 제목 | PhotosIndex | Reels Dashboard로 식별하되 native 구성요소 상태도 확인할 수 있어야 해요. |
| Photos permission | 초기 권한 상태와 버튼 실행 후 결과를 표시해요. | 권한별 안내·새로고침·재시도를 제공해요. |
| CLI socket | 현재 경로 표시와 텍스트 선택 | 일반 화면에는 연결 상태를, 진단 화면에는 필요한 연결 정보를 표시해요. |
| 오류 | `lastError`를 빨간 텍스트로 표시해요. | 작업별 실패·복구 방법·재시도를 표시해요. |
| Request Photos Access | PhotoKit `.readWrite` 권한 요청 | 사용자 클릭으로 native 권한 요청을 실행하고 결과를 반영해요. |

현재 SwiftUI에는 갤러리·영상 재생·분류·내보내기 버튼·진행률·작업 기록 화면이 없어요. 아래 기능은 기존 CLI/native 서비스에 구현되어 있고, Electron UI에서 새로 노출해야 해요.

## 3. 기능별 입력·출력 계약

근거: `Sources/PhotosIndexCLI/{PhotosIndexCLI,ExportCLICommands,MoveCLICommands}.swift`, `Sources/PhotosIndexApp/AppCommandRouter.swift`, `Sources/PhotosIndexCore/{Models,ExportModels,MoveModels}.swift`.

| ID | 명령/작업 | 입력 | 성공 결과와 UI |
| --- | --- | --- | --- |
| PI-01 | `status` | 없음 | 앱 버전, protocol 버전, Photos 권한. 연결됨·연결 불가·버전 불일치를 구분해요. |
| PI-02 | `authorize` | 사용자 권한 요청 | 갱신된 권한 문자열. 권한 허용을 추정하거나 자동 허용으로 표시하지 않아요. |
| PI-03 | `sync` | 로컬 날짜 `YYYY-MM-DD` | `indexRunID`, 날짜, asset/coarse/fine 개수. 완료 후 그룹을 조회해요. |
| PI-04 | `groups.list` | 날짜 선택값, `coarse` 또는 `fine` | schema/index run/level과 그룹 목록. 그룹의 시간 범위·자산 수·warnings를 표시해요. |
| PI-05 | `groups.show` | 그룹 ID와 현재 index run | 그룹 및 자산 메타데이터. 자산 종류·촬영 시각·길이·해상도·공개 파일명·위치 유무를 표시해요. |
| PI-06 | `groups.inspect` | 그룹 ID, index run, evidence 출력 디렉터리, samples 1~12, page≥1, page size 1~12 | JPEG 경로, evidence JSON, Markdown 요약, OCR·privacy flags, 페이지 및 남은 asset IDs. 페이지별 갤러리로 표시해요. |
| PI-07 | `decisions.validate` | `ModelDecision` JSON | valid, index/group ID, 포함·제외 개수. 실패 시 해당 선택·판단을 수정할 수 있어야 해요. |
| PI-08 | `export.plan` | decision 파일, 허용 목적지, `dated-group`, 새 plan 파일 | canonical export plan + SHA-256 digest. 실제 복사 전 대상·제외 수·목적지·경고를 검토해요. |
| PI-09 | `export.apply` | 발급된 plan 파일과 정확한 digest | 파일별 bytes/hash/path/reused를 포함한 receipt. Photos 원본은 유지해요. |
| PI-10 | `move.plan` | export 계획과 같은 입력 | exportPlan을 포함한 MovePlan, 이동 전용 digest, `delete-source-after-verified-upload`. 원본 삭제가 포함됨을 명확히 보여줘요. |
| PI-11 | `move.apply` | move plan과 이동 전용 digest | export receipt, 삭제 확인된 public asset IDs, 완료 시각, warnings. 부분 실패와 복구를 구별해요. |

모든 CLI 명령은 `--format json` 경로를 유지해요. `sync --wait`는 현재 parser에 있으나 실제 작업은 동기 요청이며 별도의 비동기 job 조회 프로토콜이 없어요. 현재 완료 계약을 진행률 API가 이미 존재하는 것으로 해석하지 않아요.

## 4. 탐색·증거·분류 화면

### 날짜와 그룹

- 현재 native index는 한 날짜를 메모리에 유지해요. 새 sync는 새로운 run ID를 만들고 이전 상태를 대체해요. 원본 구현의 timezone은 `Asia/Seoul`이에요.
- 사진과 동영상만 조회하며 hidden 자산은 제외해요. 날짜 구간은 시작 포함·다음날 시작 제외예요.
- `groups.list`에 현재와 다른 날짜를 요청하면 `index-date-mismatch`예요. 재색인 후 선택·분류·plan의 run ID가 오래되었다면 다시 확인해야 해요.
- Electron에서 여러 날짜 목록을 영속화하는 기능은 새 기능이에요. 캐시된 화면의 과거 run ID로 native apply를 호출하면 안 돼요.
- 빈 날짜, 단일 그룹, 여러 coarse/fine 그룹, 시간·파일명 미상, 경고가 있는 그룹을 모두 표시해요.

### 미리보기와 OCR

- 페이지당 최대 12개는 전체 그룹의 제한이 아니에요. 다음 페이지로 끝까지 검토하고 이미 검토한 페이지와 미검토 자산을 구별해요.
- 실제 PhotoKit provider는 동영상에도 Photos 관리 포스터 이미지를 요청해요. `videoFrame` 필드 이름만 보고 임의 타임스탬프 프레임 추출·전체 영상 시청을 완료했다고 표시하지 않아요.
- 현재 기본 JPEG 최대 변은 1024px, 품질은 0.82예요. PhotoKit 네트워크 접근이 허용되어 iCloud 미리보기를 가져올 수 있어요.
- OCR 문자열의 이메일·전화번호·긴 숫자 식별자를 redact하고 얼굴 감지 등 privacy flags를 표시해요. privacy flag가 이미지 자체의 익명화를 뜻하지는 않아요.
- 미리보기 출력은 로컬 경로로 유지해요. 웹 renderer는 fixture 또는 전달받은 안전한 URL을 사용하고, 원본 절대경로를 Sites에 노출하지 않아요.

### 분류 결정

`ModelDecision`은 `schemaVersion`, `indexRunID`, `groupID`, `label`, `confidence`, `includedAssetIDs`, `excludedAssetIDs`, `evidenceReferences`, `unknowns`를 포함해요. native 앱은 의미 분류 모델을 내장하지 않아요.

- 전체 그룹 자산을 중복·겹침 없이 포함 또는 제외로 완전히 나눠야 해요.
- 최소 1개를 포함해야 하며 기본 최대 포함 개수는 120개예요.
- 기본 최소 confidence는 0.80이고 unresolved unknowns는 허용하지 않아요.
- 다른 그룹의 자산, 누락, 중복, 오래된 index run은 거부해요.
- UI는 포함·제외·미정 개수를 표시하고, decision 파일 불러오기·편집·저장과 native 검증을 제공해요. 단순 체크박스 조작만으로 검증 통과로 표시하지 않아요.

## 5. 복사·이동·복구 UX

근거: `ExportCommandService.swift`, `Sources/PhotosIndexExport/{ExportPlanner,ExportApplier,MoveApplier,PendingMoveStore,ExportSupport,ExportTypes}.swift`.

### 계획과 실행 분리

현재 native 목적지 허용 루트는 홈 아래 iCloud Drive의 `Naver Clip` 폴더예요. 생성 폴더는 날짜와 정규화된 label을 사용하고 파일은 `originals/` 아래에 둬요. 이 명칭은 iCloud 폴더이며 별도 클라우드 서비스 연동을 의미하지 않아요.

대체 앱은 사용 가능한 목적지를 표시하고 native 허용 루트와 일치시켜요. 임의 폴더를 허용하도록 검증을 우회하지 않아요. label과 실제 생성 경로가 달라질 수 있으므로 반환된 plan의 경로를 표시해요.

`plan`은 원본을 복사·삭제하지 않지만 CLI가 요청한 새 JSON 파일을 쓰며, 기존 plan 파일은 덮어쓰지 않아요. UI에서도 계획 생성과 실제 실행을 구별해요. plan·선택·목적지가 변경되면 기존 실행 확인 상태를 무효화해요.

### 복사 내보내기

1. native가 발급한 plan의 canonical digest와 현재 index를 검증해요.
2. 선택 원본을 staging에 준비하고 bytes·SHA-256을 확인해요.
3. 목적지 파일을 배타적으로 복사해요. 기존 파일이 있으면 동일 bytes/hash인 경우에만 재사용하고, 충돌은 덮어쓰지 않아요.
4. `manifest.json`과 `receipt.json`을 기록하고 성공한 staging을 정리해요.
5. UI에 실제 파일 수·총 bytes·재사용 여부·목적지를 표시해요. 성공 receipt가 없으면 완료로 표시하지 않아요.

### 검증 후 이동

이동은 복사 성공 후에도 추가 검증이 있어요. UI의 실행 버튼에는 Photos 원본이 최근 삭제 항목으로 이동한다는 점과 정확한 대상 개수를 표시해요. 일반 복사 버튼과 혼동하지 않게 하고, 사용자 실행 없이 자동 이동하지 않아요.

순서는 **복사/기존 receipt 확인 → 목적지 hash 확인 → iCloud 업로드 확인 → 목적지 hash 재확인 → digest 이름의 move plan 저장 → private pending journal 저장 → 선택 원본 삭제 → 삭제 대상 일치 확인 → move receipt 저장 → journal 제거**예요. UI는 백엔드가 내보내는 실제 상태만 표시하고, 현재 API가 주지 않는 세부 진행률을 임의 숫자로 만들지 않아요.

업로드·hash 확인 실패 시 원본 삭제 전 멈춰요. 삭제 후 receipt 기록 전에 종료될 수 있으므로 같은 plan과 digest를 이용한 재개가 필요해요. 재개를 새 이동 계획으로 대체하지 않아요.

### 재시작과 실패 복구

- export/move 발급 digest 집합은 현재 메모리 상태예요. 일반 export는 앱 재시작 후 그대로 적용할 수 있다고 가정하지 않아요.
- move는 일치하는 저장 plan과 private journal 또는 완료 receipt가 있으면 현재 index 없이 재개할 수 있어요. helper가 제공하는 이 경로를 UI의 ‘기존 이동 복구’에서 사용할 수 있어야 해요.
- 복구 화면은 기존 plan 선택·digest 확인·목적지 확인·동일 작업 재시도를 제공해요. private journal과 Photos 원본 식별자는 UI·Sites·공개 로그로 노출하지 않아요.
- 원본 삭제 후 일어난 실패와 업로드 대기 실패를 구분해요. 모든 실패에 단순히 ‘처음부터 다시 실행’만 안내하지 않아요.

## 6. 연결·권한·오류 계약

근거: `Sources/PhotosIndexCommand/{Protocol,UnixSocket}.swift`, `Sources/PhotosIndexCLI/{AppConnection,StatusRunner}.swift`, `AppContainer.swift`, `AppBundle/`.

- protocol v1은 newline으로 구분한 canonical JSON을 사용해요. request는 `protocolVersion`, `id`, `method`, 문자열 arguments예요. response는 동일 ID/version, `ok`, payload 또는 `code/message/recovery`예요.
- Swift `Data`인 response payload는 wire envelope에서 Base64로 인코딩돼요. CLI JSON 출력은 이를 decode한 payload 객체예요. Electron에서 socket을 직접 사용하면 이 차이를 처리해야 해요.
- 소켓은 소유자 전용 권한·동일 UID peer 검증을 유지해요. 활성 소켓·일반 파일·symlink를 stale socket으로 간주해 지우지 않아요.
- 요청/응답 한 줄과 외부 JSON 입력은 크기 제한이 있어요. router의 JSON 파일은 절대경로의 일반 파일·비symlink·최대 1 MiB만 허용해요.
- 현재 CLI는 transport 실패 시 앱을 실행하고 다시 연결해요. 대체 앱은 bundled helper를 찾아 실행해야 하며 외부 설치 경로에 우연히 연결된 상태를 QA 성공으로 처리하지 않아요.
- Photos 권한은 `not-determined`, `authorized`, `limited`, `denied`, `restricted`, `unknown`을 구분해요. sync는 authorized/limited일 때만 가능해요. limited는 전체 라이브러리 접근이 아니므로 상태를 숨기지 않아요.
- Swift helper의 PhotoKit usage description·entitlement·code identity와 Electron 앱 패키징을 확인해요. 개발 CLI의 성공은 설치 앱의 TCC 권한 동작을 증명하지 않아요.

| 오류 | UI 처리 |
| --- | --- |
| `photos-permission-required` | 권한 상태와 요청 또는 시스템 설정 안내를 표시해요. |
| `index-date-mismatch`, `stale-index-run` | 현재 선택을 보존하되 적용을 막고 해당 날짜 재조회·재검토를 안내해요. |
| `invalid-arguments`, 잘못된 JSON/decision | 해당 입력을 수정할 수 있게 오류를 보여줘요. |
| `evidence-timeout` | 미리보기 생성이 완료되지 않았음을 표시하고 해당 페이지 재시도를 제공해요. |
| `icloud-upload-timeout` | 복사와 업로드 완료를 구분하고 동일 move 재시도를 안내해요. |
| `icloud-upload-verification-failed` | native 검증 실패를 표시하고 원본 이동 성공으로 표시하지 않아요. |
| `source-delete-failed` | 사본 유지와 pending journal 기반 동일 작업 재개를 안내해요. |
| `unknown-command`, protocol 불일치 | 앱/helper 호환성 오류로 표시하고 기능 실행을 차단해요. |
| 파일 충돌·digest 불일치·미발급 digest | 덮어쓰기·검증 우회를 제공하지 않고 계획을 확인하도록 안내해요. |
| 기타 `command-failed`, helper 종료·연결 실패 | 실패한 작업과 실제 메시지를 표시하고 재연결/안전한 재시도 가능 여부를 구분해요. |

현재 CLI의 `CommandRunner`는 서버 실패의 message만 CLI error로 전달해요. Electron이 code/recovery를 활용하려면 원본 protocol envelope를 유지하는 adapter가 필요해요. UI 테스트 fixture만 풍부한 오류 객체를 쓰고 production 경로에서는 이를 잃는 구현을 피해야 해요.

## 7. 웹 공통화와 Sites 경계

공통 React 화면은 명령 호출을 transport interface로 전달해요. 웹 테스트는 같은 화면에 fixture adapter를 주입하고, Electron은 native adapter를 사용해요. Sites에서는 로컬 Photos 작업을 실행할 수 있는 것처럼 보이지 않도록 capability와 접근 가능한 데이터를 명시해요.

Sites 연결 가능의 최소 계약은 버전이 있는 dashboard snapshot, 허용된 요약 필드, 마지막 동기화 시각, 오류 상태, import/검증과 desktop publish adapter예요. 상태를 mock/localStorage에만 저장하는 웹 시안은 실제 동기화를 증명하지 않아요. 원본 사진·정밀 GPS·Photos 내부 식별자·native 절대경로·private journal은 기본 공유 데이터에서 제외해요.

## 8. 테스트 범위와 기존 공백

전체 Swift 테스트 매핑은 [테스트 명세](photosindex-test-spec.md)를 따라요. 기존 테스트를 그대로 가져오는 것과 새 UI 동작을 검증하는 것은 별도예요.

기존 `AppViewModelTests.testDisplaysCurrentPermissionAndSocketState`는 문자열 상태와 제목을 검증해요. `ModuleTests.testModuleLoads`는 UI 동작 증거가 아니에요. router/service/CLI 테스트는 기능 계약을 검증하지만 SwiftUI 클릭·Electron preload·실제 브라우저 화면·설치 앱 권한을 검증하지 않아요.

### 웹 renderer 필수 UI 시나리오

1. 권한 6가지 상태, 연결 불가, protocol 불일치, 재시도.
2. 날짜 선택·sync·빈 결과·coarse/fine 전환·그룹 상세·다른 날짜 재색인.
3. evidence 첫/중간/마지막 페이지, 12개 초과 그룹, OCR·privacy 표시, timeout 후 재시도.
4. decision 파일 불러오기·수정·저장, 포함/제외/미정, 검증 성공과 실패, 선택 변경 시 plan 무효화.
5. export 계획 검토와 실행, 복사-only 안내, digest 오류, 파일 충돌, 성공 receipt.
6. move 별도 확인, 업로드 대기/실패, 삭제 실패, 동일 plan 복구, 완료 receipt. 테스트는 synthetic fixture를 사용하고 실제 원본을 삭제하지 않아요.
7. 작업 중 중복 실행 방지, 키보드 접근, 버튼·입력의 accessible name, 작은 창/모바일 폭에서 주요 정보 접근.
8. Sites 모드에서 desktop-only 작업 비활성 또는 명시적 안내, snapshot 유효성·동기화 시각·누락 데이터 처리.

### Electron QA 필수 시나리오

1. 실제 Electron 실행, preload 노출 API와 renderer 격리, console 오류와 navigation 확인.
2. 외부 PhotosIndex 설치에 의존하지 않는 bundled helper 시작·정상 종료·재시작과 protocol 검증.
3. 실제 dialog 경로 선택, 공백·한글 경로, helper 실패/누락, 안전한 로컬 preview 로딩.
4. native Swift 전체 테스트와 실제 bridge를 통한 상태·그룹·inspection·plan·apply 계약. destructive apply는 synthetic native fixture로 검증해요.
5. 패키징한 앱의 bundle 구조·서명·Photos 권한 요청·허용/거부·재실행. 실기기 사용자 권한이 없으면 해당 항목을 미검증으로 남겨요.
6. move 복구는 helper 재시작 후에도 같은 plan/digest/journal로 동작해야 해요. mock UI 성공만으로 복구 완료를 주장하지 않아요.

웹 UI 테스트 통과, Electron bridge 테스트 통과, 실제 Photos 권한·작은 범위의 read-only 실기기 확인, 패키징 QA를 각각 기록해야 해요. 확인하지 않은 항목은 전체 대체 완료의 근거로 사용하지 않아요.
