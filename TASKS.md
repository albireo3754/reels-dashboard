# Reels Dashboard 진행 상태

기준일: 2026-10-27. 현재 목표는 Electron·React 공통 화면과 PhotosIndex 대체 기능을 구현하고, 별도 웹·Electron QA 후 공개 저장소에 올리는 것이에요.

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
- [x] 패키징 앱 Electron QA7개와 라이선스 포함 확인.
- [x] TypeScript 단위 테스트8개·타입 검사·공개 소스 검사.
- [x] macOS 로컬 QA용 앱 번들 생성.
- [x] 실행 중 서명 바이너리 덮어쓰기 오류 수정 및 실제 재빌드 회귀 검증.
- [x] 단독 CLI의 paired helper 설치·재설치와 한글/공백 경로 종료 검증.

## 완료 확인 대기

- [ ] 실제 Photos 접근 권한 허용 후 작은 범위의 read-only 색인 확인. 현재 권한은 `not-determined`이고 Mac이 잠겨 있어 사용자 잠금 해제·OS 허용이 필요해요.
- [x] GitHub 공개 원격 push, PUBLIC·로컬/원격 HEAD 일치 확인. 구현 커밋의 [GitHub CI](https://github.com/albireo3754/reels-dashboard/actions/runs/40508791211) 전체 통과.

## 검증 범위

내보내기·이동의 실제 개인 사진 삭제는 자동 QA로 수행하지 않아요. 해당 동작은 기존 Swift 서비스 테스트와 synthetic 웹/Electron 시나리오에서 검사했어요. 실제 helper 실행 경로와 권한 거부 처리·종료는 패키징 앱으로 확인했어요.

이 기기에는 Apple Development 인증서가 없어 명시적인 ad-hoc 서명으로 QA했어요. 안정적인 개발 서명과 공증된 배포용 서명은 별도 인증서 설정이 필요해요. 실제 Sites 프로젝트 배포·수신 저장소 구축은 이번 연결 가능한 공통화와 구분해요.

## 이후 확장

영상 편집 UI·기존 Python FFmpeg 연결, 여러 날짜의 Photos 색인 영속화, 실제 Sites 배포는 다음 확장으로 관리해요. 기존 PhotosIndex의 단일 날짜 메모리 색인 동작을 영속 색인 완료로 표현하지 않아요.
