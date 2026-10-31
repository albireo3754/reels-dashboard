# 제작 프로젝트 모델

대시보드의 카드 하나가 하나의 제작 프로젝트다. 주제·진행 상태·문안·원본 자료를 프로젝트에서 관리하고, 영상 편집과 카드뉴스 구성은 프로젝트에 소속된 편집 작업이다. 구성이나 출력 버전이 늘어나도 별도 콘텐츠 카드로 분리하지 않는다.

## 스키마

- [JSON Schema](../schemas/dashboard.schema.json): Dashboard → Project → production의 전체 저장 형식.
- [타입·관계 검증](../src/shared/production-project.ts), [저장 검증](../src/shared/data.ts).
- 생성: `node --import tsx scripts/write-project-schema.ts`. JSON Schema는 필드 구조를 검증하고, 소유권·참조 무결성은 저장 시 `validateProductionLinks`가 검증한다.

| 단위 | 키와 소유 관계 | 저장 내용 |
| --- | --- | --- |
| Dashboard | 프로젝트 ID가 유일한 projects 배열 | schemaVersion, updatedAt |
| Project | 콘텐츠 수명 동안 유지하는 id | 제목·진행·날짜·문안/자료 링크·공유 상태 |
| 편집 구성 | (kind, id), 한 프로젝트에만 소속 | video 또는 card-news. 기존 편집 파일을 참조 |
| 출력 이력 | UUID, 편집 구성과 연결 자료 참조 | path, role, recordedAt |
| 병합된 카드 | mergedIds, 다른 카드/별칭과 중복 금지 | 이전 ID 재생성 방지와 내보내기 소유자 해석 |

`production`은 `{schemaVersion:1, edits:[], exports:[], mergedIds:[]}`다. 기존 dashboard schemaVersion 1에 선택 필드로 추가한다. 기존 기록을 추측해서 일괄 합치거나 편집 구성 ID를 바꾸지 않는다. 실제 연결·병합·내보내기 때 모델이 저장된다. 독립적으로 시작한 편집은 처음에는 자기 ID의 카드를 가지며, 사용자가 대표 프로젝트에 연결/합친 뒤 모든 후속 출력이 그곳으로 들어간다.

`resources`는 현재 자료 목록, `exports`는 어떤 편집에서 생성된 출력인지 추적하는 이력이다. 동일 경로·역할·편집 조합은 중복 기록하지 않는다. `recordedAt`은 이력 등록 시각이며 과거 파일의 실제 생성/게시 시각을 뜻하지 않는다. 기존 수동 연결 자료는 편집 구성을 추측해 출력 이력으로 바꾸지 않는다. 이전 독립 편집 카드와 저장된 구성 ID가 정확히 같은 경우에만 병합 때 이력을 연결한다.

영상/표지 출력 및 카드뉴스 MP4 출력은 편집 소유자를 조회해 같은 프로젝트에 자료·이력을 추가한다. 대표 제목·날짜·공유 설정을 유지하고, 이미 게시한 프로젝트는 재출력으로 미게시 상태가 되지 않는다. 편집 설정·개인 미디어는 원래 파일에 남는다. 공유 snapshot에는 편집 ID·별칭·출력 경로를 포함하지 않는다.

## 앱 사용법

콘텐츠 카드의 **수정 → 프로젝트로 묶기**에서:

1. 저장된 편집 구성을 선택해 연결한다. 다른 카드에 속한 구성은 그 카드를 먼저 합친다.
2. 중복 카드에서는 **이 카드를 합칠 프로젝트**에 대표 카드를 선택한다.
3. 표시된 병합 내용을 확인하고 **선택한 프로젝트로 합치기**를 누른다.

제목 등 수정 중인 내용은 먼저 저장해야 한다. 대표 프로젝트의 제목·날짜·진행·공유 상태를 유지하고 자료·편집 연결·출력 이력·메모를 합친다. 다른 게시 링크가 있으면 자동으로 버리지 않고 병합을 거절한다. 원본 미디어·편집 파일은 삭제하지 않는다.

병합은 dashboard revision 확인 후 한 번의 원자적 저장으로 수행한다. 성공 전 전체 기존 dashboard를 앱 user-data의 `documents/project-merge-backup-*.json`에 보관한다. 데이터 한도를 초과하거나 잘못된 참조가 있으면 저장하지 않는다. 자동 되돌리기 UI는 없으며 복구는 앱을 종료한 뒤 백업을 검토해 적용한다. 이후 변경이 생겼다면 전체 백업으로 덮어쓰지 말고 필요한 프로젝트만 복구해야 한다.

## MCP

- `reels_list_project_edits`: 저장된 편집과 대표 프로젝트 조회.
- `reels_link_project_edit`: projectId + edit(kind/id) + expectedUpdatedAt.
- `reels_merge_projects`: targetId + sourceIds + expectedUpdatedAt. 결과에 dashboard와 backupPath 포함.

프로젝트 병합은 콘텐츠 조직 변경이다. 게시·업로드·원본 이동/삭제가 아니다. 예전 카드 ID로 upsert하면 대표 ID를 사용하라는 오류를 반환한다. 이름·파일명 유사성만으로 자동 병합하지 않는다.


## 검증 — 2026-10-31

단위 검사 전체, 타입·FSD·빌드 통과. 프로젝트 관계 단위4개는 병합 백업·자료 보존·충돌·재시작·이전 ID 재생성 방지·소유권과 출력 참조를 검증한다. 개발/패키징 Electron 각각3개에서 UI 병합·재시작, 카드뉴스 병합 후 두 번째 실제 MP4 출력, 영상/표지 실제 출력의 대표 프로젝트 연결을 확인했다. 실제 사용자 라이브러리에서도 승인된 중복 콘텐츠 한 쌍만 병합하고 저장된 편집3개를 연결했으며 다른 프로젝트 불변을 확인했다. 새 앱 `release/production-projects/mac-arm64/Reels Dashboard.app`을 실행했다. 과거 수동 등록 자료 전체의 출력 생성 이력을 추정 복원하지는 않는다.
