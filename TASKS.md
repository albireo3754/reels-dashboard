# Reels Dashboard 진행 상태

기준일: 2026-10-27. 기능 구현 완료와 코드 조사 완료를 구분해요.

## 완료

- [x] 독립 프로젝트 작업공간 생성.
- [x] PhotosIndex의 실제 SwiftUI·CLI·socket·PhotoKit·Vision·Export 코드 확인.
- [x] 기존 React 편집 화면과 Python·FFmpeg 엔진의 재사용 범위 확인.
- [x] 전체 기능 통합 범위와 Electron + Swift + Python 역할을 README에 기록.

## 다음 구현 단위

- [ ] Electron + React 앱 기반과 제한된 preload API 구성.
- [ ] PhotosIndex 상태·버전·권한 확인과 날짜별 sync·groups 조회 연결.
- [ ] 촬영 그룹 갤러리, 페이지 단위 미리보기·OCR·분류 화면 연결.
- [ ] 여러 날짜의 영속 색인과 프로젝트 연결 방식을 정의하고 로컬 저장 구현.
- [ ] decisions.validate, export.plan/apply를 연결하고 계획·결과 표시.
- [ ] move.plan/apply 전체 기능 연결: 원본 삭제를 명시한 실행 UI, 기존 검증·복구 절차 유지.
- [ ] 내보내기 목적지를 허용 범위 안에서 설정할 수 있도록 Swift 서비스 확장.
- [ ] 기존 편집 화면과 최신 CLI 템플릿을 연결하고 출력 일치 확인.
- [ ] 렌더 진행률·취소·결과물 확인 연결.
- [ ] 제작 단계·다음 할 일·게시 링크를 보여주는 로컬 대시보드 구현.
- [ ] native helper·Python·FFmpeg를 포함하는 단일 앱 배포 구성 검증.
- [ ] 선택한 진행 현황의 Sites 동기화와 모바일 조회 구현.

이번 조사에서는 사진 라이브러리 색인·내보내기·이동 명령을 실행하지 않았어요. PhotosIndex 소스와 기존 데이터도 변경하지 않았어요. 새 앱 실행이나 성능 비교는 아직 검증하지 않았어요.
