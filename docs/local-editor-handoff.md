# 등록 미디어를 로컬 편집기로 전달

2026-11-02. OpenCut 등 다른 편집기에서 사용할 파일을 Dashboard의 등록 자료에서 준비한다. `ContentLibrary.resolveMedia`의 기존 프로젝트·폴더·심볼릭 링크 검증을 재사용한다. 등록되지 않은 임의 파일은 복사하지 않는다.

```sh
reels prepare-media --project-id 'content-project-id' \
  --selection '/absolute/selection.json' --destination '/absolute/new-media-directory'
```

`--selection`은 절대 경로 JSON 배열이 담긴 파일이고, `-`면 stdin에서 읽는다. 프로젝트 ID와 등록 경로는 `reels prepare-media --list [--project-id <id>]`로 찾는다. 앱을 켜지 않아도 동작한다. 사용자 데이터 경로는 `REELS_USER_DATA`로 바꿀 수 있고, 결과는 JSON 한 건으로 나온다. [CLI 사용법](cli-usage.md#local-media-copy). 기존 스크립트도 호환 경로로 유지한다.

```sh
node --import tsx scripts/prepare-local-media.ts \
  '/absolute/dashboard-user-data' 'content-project-id' \
  '/absolute/selection.json' '/absolute/new-media-directory'
```

`selection.json`은 프로젝트에 연결한 영상/사진의 절대 경로 배열이다. 부모 디렉터리는 먼저 존재해야 하며, 목적지 디렉터리는 새 이름을 사용한다. 로컬 편집 도구가 읽을 수 있는 사용자가 지정한 폴더를 선택한다.

- 선택 전체의 접근 권한과 파일명 충돌을 복사 전에 확인한다.
- 원본 폴더 안으로 출력하지 않고, 기존 목적지나 파일을 덮어쓰지 않는다.
- 복사 전 원본·복사 후 출력의 SHA-256, 원본 크기·수정 시각을 대조한다.
- 완료 후 `receipt.json`에 원본/로컬 경로·크기·해시를 남긴다. 중간 실패 시 부분 출력은 검토를 위해 유지하며 자동 재시도하지 않는다.
- 원본·Photos 삭제, 원본 변환, 외부 업로드·게시는 하지 않는다. 개인 경로와 미디어는 사용자 작업 폴더에만 저장한다.

현재 연결은 **Dashboard 서비스 + 로컬 CLI**(`reels prepare-media`)다. 설치 앱의 새 버튼이나 MCP 도구를 추가한 것은 아니다. 실행 앱 재시작 없이 같은 등록 자료를 읽는다. UI의 Photos 복사 기능은 기존 허용된 export root를 유지하며, 이 명령은 이미 연결된 파일의 편집용 사본을 만든다.

2026-11-12: 촬영본뿐 아니라 원고·컷·자막·스타일을 함께 준비하고 기존 제작 프로젝트에 연결하는 [OpenCut 자막 소개 템플릿](opencut-templates.md)을 추가했다. `npm run opencut:prepare`는 이 사본 준비 함수를 재사용한다.

검증: 등록 자료 복사·영수증, 미등록 자료 일괄 거부, 중복 선택, 원본 내부 출력, 기존 목적지 덮어쓰기 거부 단위 검사; 타입·FSD 검사. 실제 콘텐츠의 실행 근거는 콘텐츠 작업공간에서 관리한다.
