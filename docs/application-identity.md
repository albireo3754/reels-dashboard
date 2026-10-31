# 앱 아이콘과 설명

2026-10-28: 초기 PhotosIndex 중심 설명을 현재 릴스 제작 기능에 맞췄어요.

> 촬영본을 고르고, 영상과 표지를 편집하며, 게시까지의 진행을 관리하는 릴스 제작 앱

패키지 설명과 웹 메타 설명에 반영했으며, macOS 앱 정보에는 같은 의미의 설명과 촬영본 탐색·영상/표지 편집·제작 진행 관리 기능을 표시해요. 게시 자동 실행 기능을 뜻하지 않아요.

기존 화면의 `r`과 포인트 점을 모티프로 전용 아이콘을 만들었어요. Dock/Finder에는 살구색 바탕과 짙은 녹색 심벌, 메뉴바에는 18pt 단색 template 아이콘을 사용해요. 메뉴바 아이콘은 macOS의 밝고 어두운 배경에 맞춰 표시되며 1×/2× 파일을 포함해요.

트레이 메뉴에서 대시보드 열기, 앱 정보, 종료를 선택할 수 있어요. 창이 최소화됐거나 숨겨졌으면 열기 동작이 복원해요. 기존 창 닫기/종료와 진행 중 작업 보호 동작은 유지해요.

## 소스와 재생성

- 원본: `resources/branding/app-icon.svg`, `tray-icon.svg`
- 산출물: `app.icns`, `app.png`, `trayTemplate.png`, `trayTemplate@2x.png`
- 연결: `src/desktop/application-identity.ts`, `package.json`의 mac icon/files 설정
- `npm run build:icons`: 설치된 Playwright Chromium으로 PNG를 만들고 macOS `iconutil`로 ICNS를 생성해요. 아이콘을 바꿀 때만 실행해요. 일반 빌드와 패키징은 저장된 산출물을 사용해요.

## 확인 결과

- 아이콘 원본 PNG를 직접 열어 구도와 투명 여백을 확인했어요.
- `npm run build`, `npm run typecheck`, `npm run check:architecture`, `git diff --check` 통과.
- `electron-builder --mac dir --config.directories.output=release/app-identity` 성공. 번들의 `CFBundleIconFile=icon.icns` 확인.
- `tests/electron/application-identity.spec.ts`: 패키징 앱에서 1/1 통과. 실제 Electron으로 앱 아이콘 1024×1024, 트레이 18×18 및 1×/2× 리소스 로딩, 숨긴 창의 activate 복원, 최소화된 창의 second-instance 복원을 검사했어요.
- 네이티브 UI 도구가 타임아웃되어 메뉴바의 최종 외관과 트레이 메뉴 클릭·앱 정보 패널의 실제 배치는 직접 확인하지 못했어요.

새 빌드: `release/app-identity/mac-arm64/Reels Dashboard.app`. 기존 실행 앱과 user data는 교체하지 않았어요. 기존 앱을 종료한 뒤 새 빌드를 열면 적용돼요.
