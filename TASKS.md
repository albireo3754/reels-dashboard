# Reels Dashboard 진행 상태

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


## 개발모드·작업공간 탭 — 2026-10-31

- [x] `REELS_DEV_MODE=1`에서만 관리자·IPC·preload API 활성화. Codex 기본, Claude 확장 경계 분리.
- [x] 기존 화면을 유지하는 하단 패널·고정 탭바·Cmd+N/T/W/1–9. 탭 전환·접기 시 터미널 유지, 종료 확인 후 탭 제거.
- [x] 공통 키 정의와 Electron 입력 처리로 미리보기 iframe 포커스 지원. IME·반복 입력·일반모드 분리.
- [x] 독립 리뷰의 iframe 단축키 누락 수정, 통합 개발 Electron13개·패키징4개 검증.

[사용법·검증 범위](docs/development-workspace.md). PR 전용 checkout에서 타입/FSD·명세보존·단위28개·빌드·Electron13개·공개소스 검사를 통과했다.

## 개발 작업공간 — 2026-10-28

- [x] Workdesk 구조를 참고한 호스트 PTY 관리자·공통 계약·FSD 화면 분리.
- [x] Codex·Claude Code·일반 터미널, 세션 전환·출력 복원·종료·소스 폴더 연결.
- [x] 설계·구현·리뷰·수정 프롬프트와 검증 실행, 로컬 웹 미리보기·기존 운영 사이트 열기.
- [x] 통합 개발 checkout 단위41·패키징 Electron4개. 푸시 대상만 분리한 snapshot 단위21·Electron4·타입·FSD·빌드·공개 소스 검사 통과.

사용자가 단계 결과를 전달하는 개선 루프이며 자동 배포나 무인 반복 실행은 포함하지 않아요. [설계·사용법·리뷰 기록](docs/development-workspace.md). 새 앱: `release/workbench/mac-arm64/Reels Dashboard.app`.

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

## 이후 확장

- [ ] WebView 기반 모바일 앱 지원: 기존 React 대시보드 화면을 재사용하고, Capacitor 등 모바일 패키징 방식을 검토해요. 모바일 현황 조회를 우선하며 데이터 동기화·로그인·설치 방식은 구현 시 정해요. Mac 전용 PhotosIndex·영상 편집 기능의 모바일 이식은 별도 범위예요. (2026-10-27 사용자 요청: TODO만 기록, 구현은 추후 진행.)

영상 편집 UI·기존 Python FFmpeg 연결, 여러 날짜의 Photos 색인 영속화, 실제 Sites 배포는 다음 확장으로 관리해요. 기존 PhotosIndex의 단일 날짜 메모리 색인 동작을 영속 색인 완료로 표현하지 않아요.

## Photos 위치·OCR MCP 검색 — 2026-10-31

- [x] `reels_photos_search`: GPS 반경·사진/영상 대표 이미지 OCR·선택 날짜 범위 검색.
- [x] `reels_photos_search_page`: 독립 스냅샷·페이지 처리·만료·실패 항목 분리. 날짜 색인은 유지.
- [x] GPS로 먼저 추린 뒤 리소스 조회, OCR 고품질 미리보기 사용.
- [x] 네이티브/TS 테스트 및 실제 stdio MCP→Electron→PhotoKit/Vision 검증, 별도 앱 패키징.
- 사용법·검증 범위: [MCP usage](docs/mcp-usage.md#photos-location-and-ocr-search--2026-10-31).
- 새 패키지는 `release/photos-search/mac-arm64/Reels Dashboard.app`; 현재 실행 앱 교체는 하지 않음.
