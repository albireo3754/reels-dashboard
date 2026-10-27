# PhotosIndex 테스트 기반 마이그레이션 명세

2026-10-27 기준 기존 Swift 패키지의 `Tests/` 전체를 읽어 작성했어요. **26개 Swift 파일·7개 테스트 target·75개 테스트 메서드**를 빠짐없이 매핑했어요. 각 파일의 fixture·stub·helper도 함께 확인했어요. 함수 이름만으로 동작을 추정하지 않고 실제 assertion과 전달 인자를 기준으로 적었어요.

아래 계약은 **기존 테스트 코드가 요구하는 동작**이에요. 이 문서 작성 담당자는 소스를 읽었고, 통합 담당 에이전트가2026-10-27 원본 패키지에서 `swift test`를 실행해 **75개 통과·실패0개**를 보고했어요. 이 결과는 이관 전 기준선이며 Electron·React·설치 앱·실제 Photos 라이브러리 QA의 통과를 뜻하지 않아요. 이관 완료는 새 실행 결과와 웹·Electron QA 증거로 별도 판정해요.

기계 판독용 정본은 [photosindex-test-inventory.json](photosindex-test-inventory.json)이에요. ID, suite, method, 이관 예정 경로, 원본 선언 줄, 파일 SHA-256, 검증 계약을 포함해요. 경로는 공개 저장소의 `native/photosindex/`를 기준으로 표기했으며 개인 홈 경로나 실제 라이브러리 데이터는 넣지 않았어요. 이관 중 namespace·bundle 이름 등이 바뀌면 원본 hash는 출처 증거로 남기고 새 실행 증거를 연결해요.

## 보존할 동작

- 날짜 색인, coarse/fine 그룹, 결정적 순서, indexRunID의 유효 범위를 유지해요.
- 증거는 페이지별 최대12개로 만들고, 전체 선택 최대120개 제한과 구분해요. 이미지 생성 일부 실패도 성공으로 숨기지 않고 partial-evidence를 표시해요.
- 공개 payload에는 PhotoKit 내부 식별자·정밀 좌표를 노출하지 않아요. OCR 이메일·전화·긴 숫자 식별자를 가려요.
- 복사 내보내기와 원본 이동을 구분하고, 서로 다른 digest domain을 유지해요. 선택 변경·잘못된 digest·경로 충돌·symlink를 거절해요.
- 이동은 목적지 업로드 검증과 이후 bytes 검증을 통과한 뒤에만 포함 대상을 삭제해요. 삭제 결과가 다르면 성공 receipt를 만들지 않아요.
- 삭제 후 receipt 실패와 앱 재시작을 pending journal로 복구하며, 이미 삭제된 원본을 다시 materialize하지 않아요.
- 로컬 socket의0600 권한, 활성 소켓 탈취 방지, 독립 status 응답, client deadline을 유지해요.

## 테스트 범위와 한계

- 테스트 중 PhotoKit 조회·권한·원본 삭제·Vision 분석·iCloud 업로드 대부분은 fake/stub이에요. 실제 Photos 권한 창, Vision OCR 정확도, iCloud 완료, 실물 원본 삭제의 성공을 입증하지 않아요.
- 로컬 Unix socket과 임시 파일을 쓰는 통합 테스트는 실제 OS socket·파일 동작을 일부 검증해요. 다른 UID peer 거부, 설치된 앱 서명·권한 귀속, 배포 앱 자동 실행은 별도 QA가 필요해요.
- SwiftUI는 view model의 제목·권한·socket 상태를 검사하는 테스트1개뿐이에요. SwiftUI 렌더링·탭 클릭·갤러리·편집기 UI 테스트는 없어요.
- `testModuleLoads` 5개 중 App/CLI의2개는 `XCTAssertTrue(true)` 자리표시자예요. 나머지3개도 타입 로드 확인이며 기능 커버리지로 세지 않아요.
- 아래에서 특정 값만 검사한 경우 전체 경계를 검증한 것으로 넓혀 쓰지 않았어요. 예를 들어 confidence=1.1 거절은 음수·0·1 경계를, 121개 거절은 정확히120개 허용을 입증하지 않아요.
- 영속적인 여러 날짜 색인, React 대시보드, Electron IPC, Sites 동기화, 영상 편집·렌더링은 이75개 테스트의 기존 범위 밖이에요. 새 기능별 테스트가 필요해요.

## target별 집계

| target | 메서드 수 |
| --- | ---: |
| PhotosIndexAppTests | 16 |
| PhotosIndexCLITests | 12 |
| PhotosIndexCommandTests | 7 |
| PhotosIndexCoreTests | 10 |
| PhotosIndexEvidenceTests | 7 |
| PhotosIndexExportTests | 19 |
| PhotosIndexPhotosTests | 4 |

## 메서드별 계약

각 행은 JSON inventory의 동일 ID와1:1 대응해요. 경로·선언 줄은 이관 전 기준이며, 테스트 통과 상태가 아니에요.

### AppCommandRouterTests

소스: `native/photosindex/Tests/PhotosIndexAppTests/AppCommandRouterTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-001 | `testRoutesDecisionValidationFromDecisionFile` · L11 | decisions.validate는 JSON 파일을 읽어 현재 run/group과 포함 1·제외 0의 유효 결과를 반환한다. |
| PI-002 | `testRoutesSyncAndFineGroupList` · L75 | sync→fine 목록→상세→증거 요청을 연결한다. 다른 날짜는 index-date-mismatch, 오래된 run은 stale-index-run, samples=13은 invalid-arguments, 생성 timeout은 evidence-timeout으로 반환한다. 기본 증거 페이지에 해당 asset이 포함된다. |
| PI-003 | `testInspectRoutesTheRequestedAssetPage` · L211 | 26개 그룹의 page=2/page-size=12 요청은 13~24번째 asset만 서비스에 전달하고 totalPages=3, 남은 2개를 반환한다. |
| PI-004 | `testAuthorizeReturnsUpdatedPermission` · L286 | authorize는 기존 not-determined 상태 대신 권한 요청 결과 authorized를 반환한다. |
| PI-005 | `testSyncRequiresPhotosPermission` · L305 | 권한이 not-determined이면 sync를 실패시키고 photos-permission-required를 반환한다. |
| PI-006 | `testRoutesExportPlanAndApplyFromFiles` · L324 | decision 검증→export.plan→plan 파일→digest-bound apply 흐름이 원본 1개와 manifest를 만든다. decision JSON symlink는 command-failed로 거절한다. |
| PI-007 | `testRoutesMovePlanAndApplyFromFiles` · L431 | move.plan/apply는 deleteSourceAfterVerifiedUpload operation을 보존하며 선택한 공개 asset ID만 삭제 대상으로 전달하고 receipt에 기록한다. |
| PI-008 | `testRoutesPendingMoveRecoveryWithoutCurrentIndex` · L519 | 삭제 후 receipt 기록이 실패한 작업은 새 서비스·빈 현재 인덱스에서도 저장한 plan과 digest로 복구하며 선택한 asset의 삭제 완료 결과를 반환한다. |

### AppViewModelTests

소스: `native/photosindex/Tests/PhotosIndexAppTests/AppViewModelTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-009 | `testDisplaysCurrentPermissionAndSocketState` · L6 | view model은 생성 시 전달한 Photos 권한·socket 경로와 PhotosIndex 제목을 보존한다. 실제 SwiftUI 화면 렌더링을 검사하는 테스트는 아니다. |

### EvidenceInspectionServiceTests

소스: `native/photosindex/Tests/PhotosIndexAppTests/EvidenceInspectionServiceTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-010 | `testInspectCancelsAndReturnsTypedTimeoutWhenGenerationDoesNotFinish` · L9 | 멈춘 증거 provider가 있을 때 timeout=0.05초 설정에서 timedOut 오류를 0.5초 이내 반환한다. provider는 취소 확인을 수행하고 테스트 정리에서 해제된다. |

### ExportCommandServiceTests

소스: `native/photosindex/Tests/PhotosIndexAppTests/ExportCommandServiceTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-011 | `testPlansAndAppliesMoveWithMoveSpecificIssuedDigest` · L10 | 발급한 move digest로 선택 asset 이동이 성공한다. 같은 exportPlan의 copy digest와 move digest는 다르며 copy digest로 이동 apply하면 digestMismatch다. |
| PI-012 | `testResumesPendingMoveAfterServiceRestartWithoutIssuedDigest` · L68 | 삭제 후 receipt 실패로 남은 파일 journal은 서비스 재시작 후 메모리 발급 digest와 원본 재materialize 없이 복구할 수 있고, 성공하면 journal을 지운다. |
| PI-013 | `testValidatesPlansAndAppliesDigestBoundCopy` · L129 | 완전한 decision을 검증하고 날짜_라벨 목적지와 결정적 digest를 생성하며 apply 결과에 originals 경로와 manifest가 남는다. |
| PI-014 | `testRejectsOutsideRootAndDigestMismatch` · L178 | 허용 루트 밖 export 계획을 거절하고, 정상 계획이라도 잘못된 digest로 apply하면 digestMismatch다. |

### IndexRuntimeTests

소스: `native/photosindex/Tests/PhotosIndexAppTests/IndexRuntimeTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-015 | `testSyncBuildsCoarseSessionsAndFineSegments` · L8 | 같은 위치에서 0·10·45분에 촬영한 3개 fixture를 색인하면 coarse 1개·fine 2개로 나누고 비어 있지 않은 run ID를 반환한다. |

### PhotosIndexAppModuleTests

소스: `native/photosindex/Tests/PhotosIndexAppTests/ModuleTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-016 | `testModuleLoads` · L5 | XCTest에서 XCTAssertTrue(true)를 수행하는 자리표시자다. 앱 기능 또는 화면 동작 증거가 아니다. |

### AppConnectionTests

소스: `native/photosindex/Tests/PhotosIndexCLITests/AppConnectionTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-017 | `testEnvironmentAppPathTakesPriority` · L8 | PHOTOSINDEX_APP_PATH 환경 설정이 앱 경로 탐색에서 우선한다. |
| PI-018 | `testPreservesCommandFailureInsteadOfReportingLaunchFailure` · L16 | 실제 socket에서 수신한 Photos 권한 필요 오류는 앱 실행 실패로 바꾸지 않고 원래 명령 오류 메시지로 전달한다. |

### CommandParsingTests

소스: `native/photosindex/Tests/PhotosIndexCLITests/CommandParsingTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-019 | `testGroupsInspectParsesAssetPageOptions` · L6 | groups inspect의 --page 2와 --page-size 12를 정확히 파싱한다. |
| PI-020 | `testDecisionAndExportCommandsParse` · L23 | decisions validate, export plan/apply, move plan/apply 예제 인자가 각각 올바른 CLI command 타입으로 파싱된다. |

### CommandRunnerTests

소스: `native/photosindex/Tests/PhotosIndexCLITests/CommandRunnerTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-021 | `testSyncSendsDateAndReturnsCanonicalPayload` · L8 | 실제 테스트 socket으로 sync method와 date를 전달하고 반환된 canonical JSON을 IndexSyncPayload로 읽어 asset/fine group 개수를 보존한다. |
| PI-022 | `testGroupsListSendsLevelAndReturnsGroups` · L37 | 실제 테스트 socket으로 groups.list와 fine level을 전달하고 응답 level·indexRunID를 보존한다. |

### ExportCommandExecutionTests

소스: `native/photosindex/Tests/PhotosIndexCLITests/ExportCommandExecutionTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-023 | `testExportPlanCommandWritesCanonicalPlanFile` · L9 | CLI export plan은 정규화된 decision·목적지 경로와 layout을 전송하고 응답 plan을 canonical JSON 파일로 기록한다. 저장 파일의 digest가 응답 digest와 일치한다. |
| PI-024 | `testExportApplyCommandSendsPlanPathAndDigest` · L71 | CLI export apply는 plan 경로를 정규화하고 대문자로 받은 digest를 소문자로 전달한다. |

### PhotosIndexCLIModuleTests

소스: `native/photosindex/Tests/PhotosIndexCLITests/ModuleTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-025 | `testModuleLoads` · L5 | XCTest에서 XCTAssertTrue(true)를 수행하는 자리표시자다. CLI 기능 증거가 아니다. |

### MoveCommandExecutionTests

소스: `native/photosindex/Tests/PhotosIndexCLITests/MoveCommandExecutionTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-026 | `testMovePlanWritesCanonicalMovePlan` · L9 | CLI move plan은 정규화된 decision 경로를 전송하고 MovePlan을 canonical JSON 파일로 저장한다. 저장 객체·digest가 응답과 일치한다. |
| PI-027 | `testMoveApplySendsCanonicalPlanPathAndLowercaseDigest` · L45 | CLI move apply는 plan 경로를 정규화하고 대문자 입력 digest를 소문자로 전송한다. |

### StatusRunnerTests

소스: `native/photosindex/Tests/PhotosIndexCLITests/StatusRunnerTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-028 | `testRunnerReturnsCanonicalStatusPayload` · L7 | 실제 테스트 socket의 status 결과를 canonical JSON으로 받아 authorized 권한과 protocolVersion=1을 보존한다. |

### PhotosIndexCommandModuleTests

소스: `native/photosindex/Tests/PhotosIndexCommandTests/ModuleTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-029 | `testModuleLoads` · L5 | PhotosIndexCommandModule 타입을 참조할 수 있다는 module smoke 확인이다. |

### UnixSocketTests

소스: `native/photosindex/Tests/PhotosIndexCommandTests/UnixSocketTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-030 | `testStatusRoundTripOverRealUnixSocket` · L6 | Unix socket host/client의 실제 왕복 통신이 ok 응답과 앱 버전·권한 payload를 보존한다. |
| PI-031 | `testHostRefusesSymlinkAtSocketPath` · L32 | socket 예정 위치가 symlink이면 unsafeExistingPath로 host 시작을 거절한다. |
| PI-032 | `testSocketPermissionsAreOwnerOnly` · L51 | 생성된 Unix socket의 POSIX mode가 0600이다. |
| PI-033 | `testSecondHostCannotStealActiveOwnerSocket` · L64 | 같은 활성 socket을 두 번째 host가 차지하려 하면 socketAlreadyActive로 실패하고 첫 host가 계속 응답한다. |
| PI-034 | `testBlockedCommandDoesNotBlockIndependentStatusClient` · L91 | 다른 명령이 semaphore에서 멈춰도 별도 status client는 0.25초 미만에 응답한다. |
| PI-035 | `testClientReceiveHasDeadline` · L128 | 응답하지 않는 host에 receive/send timeout=0.05초를 지정하면 client는 오류를 0.5초 미만에 반환한다. |

### EvidencePageTests

소스: `native/photosindex/Tests/PhotosIndexCoreTests/EvidencePageTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-036 | `testPagesOrderedAssetsWithoutSkippingCoverage` · L5 | 26개 ordered asset을 12·12·2개로 순서 보존 분할하며 totalPages=3과 각 remainingAssetIDs를 정확히 계산한다. |
| PI-037 | `testRejectsInvalidPageAndPageSize` · L33 | page=0, page-size=13, 존재하지 않는 두 번째 페이지를 각각 invalidPageNumber·invalidPageSize·pageOutOfRange로 거절한다. |

### GroupingTests

소스: `native/photosindex/Tests/PhotosIndexCoreTests/GroupingTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-038 | `testCoarseBoundaryIsInclusive` · L8 | 동일 좌표의 촬영 간격이 정확히 120분이면 coarse 그룹 하나에 포함한다. |
| PI-039 | `testFineGapOverThirtyMinutesSplitsSegments` · L26 | 위치 없는 촬영 간격 30분+1초는 같은 coarse 안의 두 fine segment로 나누며 양쪽에 some_assets_without_location 경고를 포함한다. |
| PI-040 | `testSortingUsesAssetIDForEqualCaptureDates` · L45 | 동일 촬영 시각의 입력 순서가 b,a여도 asset ID 기준 a,b로 정렬한다. |

### ModelsTests

소스: `native/photosindex/Tests/PhotosIndexCoreTests/ModelsTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-041 | `testEvidencePacketCanonicalJSONIsStableAndPrivate` · L6 | 동일 evidence packet을 두 번 인코딩한 bytes가 같고 localIdentifier·latitude·longitude 필드가 포함되지 않는다. |
| PI-042 | `testDecisionRejectsConfidenceOutsideUnitInterval` · L48 | confidence=1.1인 ModelDecision 생성을 거절한다. 이 테스트는 음수나 정확한 경계값을 직접 검사하지 않는다. |

### MoveModelsTests

소스: `native/photosindex/Tests/PhotosIndexCoreTests/MoveModelsTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-043 | `testMoveDigestIsDomainSeparatedFromCopyOnlyExport` · L6 | MovePlan SHA-256은 길이 64이고 자체 검증을 통과하며 동일 exportPlan의 copy digest와 다르다. |
| PI-044 | `testMoveDigestRejectsTamperedSelection` · L20 | digest 발급 뒤 포함 asset을 변경한 move plan은 digestMismatch로 거절한다. |
| PI-045 | `testMoveReceiptRoundTripsOnlyPublicDeletionIdentifiers` · L38 | MoveReceipt를 canonical JSON으로 왕복해 동일 객체를 얻고 localIdentifier가 노출되지 않는다. |

### EvidenceGeneratorTests

소스: `native/photosindex/Tests/PhotosIndexEvidenceTests/EvidenceGeneratorTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-046 | `testSamplingIsDeterministicMixedAndCappedAtTwelve` · L7 | 20개 사진·영상 fixture에서 최대 12개를 결정적으로 선택한다. 입력을 뒤집어도 sample asset 순서와 evidence JSON bytes가 같고 photoThumbnail·videoFrame 종류와 JPG 12개가 나온다. |
| PI-047 | `testOCRRedactionPreservesFoodAndPlaceTerms` · L56 | OCR의 장소·음식 표현은 유지하고 이메일·전화·긴 숫자 식별자를 redaction 토큰으로 바꿔 evidence JSON/summary에 원문 민감값이 남지 않는다. |
| PI-048 | `testOutputsExcludePrivateSourceIdentifierAndExactLocation` · L95 | evidence JSON/summary에는 sourceIdentifier에 넣은 private ID·정밀 좌표를 포함하지 않고 hasLocation=true만 노출한다. |
| PI-049 | `testProviderFailureProducesPartialPacketAndWarning` · L130 | 3개 중 1개 preview 생성이 실패하면 성공한 2개만 남기고 asset별 sample-generation-failed와 중복 없는 partial-evidence 경고를 기록하며 JSON·summary 파일은 생성한다. |
| PI-050 | `testGeneratesIndependentAssetsConcurrently` · L161 | 4개의 독립 asset preview 요청에서 관측한 최대 동시 요청 수가 1보다 크다. |
| PI-051 | `testRequestsOnePreviewPerAssetWithoutDuplicateVideoPositions` · L185 | 사진 1개·영상 2개 각각 preview 요청은 정확히 한 번이고 모든 sample position은 nil이며 asset 순서를 유지한다. |

### PhotosIndexEvidenceModuleTests

소스: `native/photosindex/Tests/PhotosIndexEvidenceTests/ModuleTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-052 | `testModuleLoads` · L5 | PhotosIndexEvidenceModule 타입을 참조할 수 있다는 module smoke 확인이다. |

### ExportApplierTests

소스: `native/photosindex/Tests/PhotosIndexExportTests/ExportApplierTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-053 | `testApplierReusesIdenticalFileAndWritesManifestAndReceipt` · L9 | 동일 경로의 동일 bytes 파일은 reused=true로 재사용한다. manifest·receipt를 생성하고 staging을 제거한다. 같은 계획을 다시 apply해도 같은 receipt를 반환한다. |
| PI-054 | `testApplierRejectsCollisionForDifferentBytesAtSamePath` · L67 | 같은 목적지 파일 경로에 다른 bytes가 존재하면 덮어쓰지 않고 collision으로 거절한다. |
| PI-055 | `testApplierRejectsSymlinkDestinationRoot` · L106 | 목적지 root가 symlink이면 symlinkPath 오류로 export를 거절한다. |
| PI-056 | `testApplierRejectsSymlinkManifestEvenWhenTargetStaysInsideDestination` · L142 | manifest.json이 symlink이면 대상이 목적지 안에 있어도 symlinkPath 오류로 거절한다. |

### ExportPlannerTests

소스: `native/photosindex/Tests/PhotosIndexExportTests/ExportPlannerTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-057 | `testPlannerAcceptsCompletePartitionAndCanonicalizesOrder` · L10 | 완전한 include/exclude partition을 수락하고 그룹 순서로 포함·제외 ID를 정규화하며 run·group·confidence·warning을 보존한다. plan digest는 반복 계산이 동일하고 길이 64다. |
| PI-058 | `testPlannerRejectsRunMismatchLowConfidenceUnknownsAndDuplicatePartition` · L53 | 다른 run, confidence=0.4(최소0.8), 비어 있지 않은 unknowns, 중복 포함 ID를 각각 indexRunMismatch·lowConfidence·unknownsNotAllowed·duplicateAssetIDs로 거절한다. |
| PI-059 | `testPlannerAcceptsSelectionAcrossMultipleBoundedEvidencePages` · L146 | 증거 한 페이지 제한과 선택 전체 제한을 구분하며 24개 asset의 완전한 포함 선택을 수락한다. |
| PI-060 | `testPlannerRejectsSelectionBeyondMoveSafetyLimit` · L172 | 121개 포함 선택은 최대120 제한을 초과해 selectionLimitExceeded로 거절한다. 정확히120 경계는 이 테스트가 직접 검사하지 않는다. |

### MoveApplierTests

소스: `native/photosindex/Tests/PhotosIndexExportTests/MoveApplierTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-061 | `testMoveDeletesOnlyIncludedAssetAfterVerifiedUpload` · L9 | 업로드 검증을 수행한 뒤 포함 asset ID만 deleter에 전달하고 receipt.deletedAssetIDs와 move-receipt.json에 완료를 기록한다. |
| PI-062 | `testMoveNeverDeletesWhenUploadVerificationFails` · L34 | 업로드 검증이 실패하면 해당 오류를 전파하고 deleter를 통해 삭제된 ID는 없어야 한다. |
| PI-063 | `testMoveRechecksDestinationHashAfterUploadWaitBeforeDeleting` · L55 | 업로드 대기 중 목적지 bytes가 바뀌면 destinationMismatch로 실패하고 원본을 삭제하지 않는다. |
| PI-064 | `testMoveAdoptsCompatibleVerifiedExportFromEarlierIndexRun` · L78 | 이전 run의 호환되는 export receipt·파일을 재사용해 원본 재materialize 없이 이동을 완료하고 현재 move digest를 이름으로 한 계획 파일을 남긴다. |
| PI-065 | `testMoveRejectsExistingExportWithDifferentSelectionWithoutDeleting` · L124 | 기존 export receipt의 선택이 현재 계획과 다르면 existingReceiptMismatch로 실패하고 원본을 삭제하지 않는다. |
| PI-066 | `testMoveDoesNotWriteReceiptWhenDeletionResultDoesNotMatch` · L164 | deleter 결과가 선택 ID와 일치하지 않으면 sourceDeletionMismatch이며 성공 move receipt를 쓰지 않는다. |
| PI-067 | `testMoveRecoversReceiptWhenFirstWriteFailsAfterDeletion` · L186 | 원본 삭제 뒤 첫 receipt write 실패 시 pending journal을 남긴다. 빈 assets와 실패하도록 설정한 materializer로 재실행해도 이미 삭제된 선택을 복구·기록하고 제외 원본은 보존하며 journal을 제거한다. |
| PI-068 | `testFilePendingMoveStoreRoundTripsWithOwnerOnlyPermissions` · L238 | 파일 journal을 저장·조회·삭제할 수 있고 journal 디렉터리는0700, 파일은0600이다. |
| PI-069 | `testMoveRecoveryDeletesOnlyTargetsThatRemainPresent` · L273 | 일부 원본이 이미 사라진 journal 복구는 남아 있는 대상만 실제 삭제하고 전체 목표 ID의 완료 receipt를 반환하며 journal을 제거한다. |
| PI-070 | `testUploadStateTreatsTransientErrorAsPendingThenAllowsSuccess` · L320 | deadline 전 임시 업로드 오류는 lastUploadError를 담은 pending이다. 이후 ubiquitous·uploaded·current 상태가 확인되면 complete가 된다. |
| PI-071 | `testUploadStateFailsPersistentErrorOnlyAtDeadline` · L354 | deadline에 도달한 지속적인 업로드 오류 상태는 uploadFailed로 실패한다. |

### PhotosIndexPhotosModuleTests

소스: `native/photosindex/Tests/PhotosIndexPhotosTests/ModuleTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-072 | `testModuleLoads` · L5 | PhotosIndexPhotosModule 타입을 참조할 수 있다는 module smoke 확인이다. |

### PhotoKitMappingTests

소스: `native/photosindex/Tests/PhotosIndexPhotosTests/PhotoKitMappingTests.swift`

| ID | 테스트 메서드 · 선언 줄 | 보존할 계약과 assertion 범위 |
| --- | --- | --- |
| PI-073 | `testPublicIDIsStableAndDoesNotExposeLocalIdentifier` · L7 | 동일 private localIdentifier에서 같은 ast_ 공개 ID가 생성되며 private 원문을 포함하지 않는다. |
| PI-074 | `testMapsVideoMetadataWithoutInventingByteSize` · L17 | 영상 metadata의 촬영일·종류·원본 파일명을 보존하고 알 수 없는 exactBytes는 nil로 둔다. |
| PI-075 | `testDeletionReconciliationSelectsOnlyTargetsStillPresent` · L38 | 삭제 재조정은 조회 결과에 아직 존재하는 localIdentifier의 대상만 선택하며 모두 없으면 빈 목록이다. |

## 마이그레이션 완료 판정에 연결할 증거

1. 이 inventory와 이관된 Swift 테스트의 파일·메서드 집합을 대조해 누락을 검출해요. 동작 변경 때문에 이름이나 target을 바꾸면 이전 ID에 새 테스트를 연결해요.
2. 이관된 전체 Swift 테스트를 실제 실행하고 결과·환경·실행 시점을 남겨요. 기존 module smoke를 기능 테스트로 계산하지 않아요.
3. 공통 React 화면은 웹 렌더러에서 권한 상태, 날짜/그룹 탐색, 증거 페이지, 포함/제외, 검증 오류, 계획 검토, 복사/이동 구분, 복구/오류 상태를 검증해요.
4. Electron QA는 실제 preload/main/native 경계를 통해 최소 status·index·group·evidence를 확인하고, 파일 선택과 계획·작업 결과 표시를 확인해요. fixture mode 성공과 실제 native mode 성공을 분리해요.
5. 파괴적인 실제 원본 이동을 무단으로 실행해서 QA하지 않아요. 이동의 실패·복구 조건은 격리 fixture로 검사하고, 실제 라이브러리 작업의 미검증 범위는 명시해요.
6. Sites에는 공개 허용한 요약만 전송되는지 별도 계약 테스트를 두고 desktop 전용 작업이 웹에서 실행되지 않도록 검사해요.
