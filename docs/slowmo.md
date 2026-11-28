# GPU 슬로우 모션(프레임 보간) — 2026-11-27

30fps로 찍은 영상을 0.5배로 늘리면 초당 실제 장면이 15장뿐이라 같은 프레임이 두 번씩 나와 끊겨 보인다. 이 기능은 이웃한 두 프레임 사이의 움직임(광학 흐름)을 GPU에서 계산하고, 그 사이 장면을 새로 그려 넣어 부드러운 슬로우 사본을 만든다.

## 진입점

- MCP/CLI `reels_start_slowmo` → `reels_get_slowmo_job`로 끝날 때까지 확인, 필요하면 `reels_cancel_slowmo`. CLI 그룹은 `render`.
- 보드 미디어 보기에서 영상을 열면 **부드러운 슬로우 만들기**. 속도(0.5·0.25·0.75배)와 시작·끝(초, 비우면 전체)을 고르고 저장 위치를 정하면 끝날 때까지 기다렸다가 결과(파일명·길이·해상도·fps·보간 프레임 수·크기·소요 시간·경고)를 보여 준다. 프로젝트 자료로 자동 등록하지 않는다.

## 입력과 결과

```json
{"sourcePath": "/abs/IMG_5431.MOV", "outputPath": "/abs/IMG_5431-slow50.mov",
 "start": 8, "end": 12, "speed": 0.5, "fps": 30, "overwrite": false}
```

- `sourcePath`·`outputPath`(.mov/.mp4)만 필수다. 기본값: 전체 길이, `speed` 0.5(0.1~0.9), `fps`는 원본 fps 반올림(최대 60, 직접 주면 24~120).
- 원본 구간은 한 번에 60초, 결과는 600초까지다.
- 원본은 바꾸지 않는다. 같은 이름의 출력은 `overwrite: true`일 때만 교체한다. 같은 폴더의 숨김 `.partial` 파일에 쓴 뒤 성공하면 이름을 바꾸고, 실패·취소하면 지운다.
- 소리는 넣지 않는다. 늘어진 소리는 쓸 일이 거의 없고, 음악은 편집에서 따로 넣는다.
- 작업은 한 번에 하나씩 순서대로 돈다. 작업 기록은 메모리에만 있어서 앱을 다시 켜면 사라진다. 진행 중에는 앱 종료를 막는다.

결과 `job.result`: `outputPath, bytes, width, height(회전 반영 화면 기준), fps, speed, durationSeconds, start, end, sourceDurationSeconds, sourceFps, frames, interpolatedFrames, hdr, codec(h264|hevc-main10), elapsedMs, audio:"removed", warnings[]`.

## 방식

네이티브 도구 `editor-runtime/bin/reels-slowmo`(`native/editor-engine/slowmo_render.swift`, `build:editor`가 빌드·서명)를 쓴다. Apple 프레임워크만 쓰고 외부 모델이나 바이너리는 받지 않는다.

1. AVFoundation이 구간 프레임과 실제 표시 시각(PTS)을 읽는다. SDR은 BGRA 8bit, HDR(HLG/PQ)은 64RGBAHalf로 읽고 톤매핑하지 않는다.
2. 출력 프레임 k의 원본 시각 `s = start + k / fps × speed`를 앞뒤 원본 프레임 A·B 사이의 비율 `t`로 바꾼다. 가변 프레임레이트 원본도 실제 PTS 기준이다.
3. Vision `VNGenerateOpticalFlowRequest`(revision 2, 정확도 high)로 A→B, B→A 흐름을 한 쌍에 한 번씩 계산한다. 긴 변 1920px 넘는 원본은 흐름 계산용으로만 줄인다.
4. Metal 커널이 Super SloMo 방식 근사로 중간 시각에서 A·B로 가는 흐름을 만들고, 두 프레임을 그 시각으로 끌어와 섞는다. 왕복 흐름 오차가 큰 픽셀(가려진 곳)은 보이는 쪽 프레임 비중을 높인다. `t=0`인 원본 프레임도 같은 GPU 경로를 그대로 지난다.
5. 하드웨어 인코더만 쓴다(`RequireHardwareAcceleratedVideoEncoder`). SDR은 H.264 High, HDR은 HEVC Main10에 원본 색 정보(primaries·transfer·matrix)를 붙인다. 회전은 원본 `preferredTransform`을 그대로 쓴다. 비트레이트는 원본 추정 비트레이트(최소 10Mbps, SDR 60Mbps·HDR 80Mbps 상한)다.

macOS 15.4 이상의 VideoToolbox `VTFrameRateConversion`(Apple ML 보간)은 개발 Mac이 15.3이고 SDK에도 없어서 쓰지 않았다. RIFE(ncnn-vulkan)도 후보였지만 외부 실행 파일·모델을 받아 실행해야 해서 이번에는 넣지 않았다.

## 한계

- 화면을 빠르게 가로지르는 물체, 서로 겹치며 지나가는 사람, 전선 같은 얇은 선, 장면 전환(컷) 지점은 늘어지거나 번질 수 있다. 결과를 직접 재생해서 확인하고, 깨지는 구간은 빼거나 속도를 덜 늦춘다.
- Dolby Vision 동적 메타데이터는 유지하지 않는다. HDR 원본은 HLG/PQ HEVC Main10으로 나온다.
- 원본이 이미 60fps 이상이면 0.5배에도 보간이 거의 필요 없다(경고로 알린다). 슬로우로 쓸 장면은 60fps·슬로모 촬영이 가장 깨끗하다.

## 검증 — 2026-11-27

- 실제 원본: 아이폰 1080p 30fps SDR 세로 영상(`IMG_5431.MOV`) 8~12초를 0.5배 30fps로 만드는 데 약 10~11초(M1 Pro). 240프레임 중 214개를 보간했고 회전 정보(-90°)가 유지됐다. 정지 프레임으로 본 사람·간판 경계에 뚜렷한 깨짐이 없었고, 걷는 다리 끝이 조금 뭉개졌다.
- 합성 HLG 10bit 1280×720 30fps를 0.25배 60fps로 만들면 HEVC Main10·`arib-std-b67`·BT.2020이 유지된다. 원본과 시각이 같은 출력 프레임은 해당 원본 프레임과 PSNR 37dB로, 한 프레임 앞 원본과는 20dB로 나와 시각 정렬도 맞았다.
- Electron background QA `tests/electron/slowmo.spec.ts`(2026-11-28 정리): 합성 세로 영상(소리 포함)으로 보드 버튼(구간·저장 위치 → 결과 줄 `0.5배 · 2초 · 180×320 · 30fps`)과 실제 MCP `reels_start_slowmo`→`reels_get_slowmo_job` 한 번(0.25배 → 120프레임·30fps·180×320·h264·소리 제거)을 확인한다. 파일의 실제 프레임 수, 원본 불변, 같은 출력 재요청 거절은 단위 테스트가 맡는다.
- 전체 검증: typecheck, check:architecture, audit:public 통과. `npm test` 995개 중 986 통과·6 건너뜀·3 실패이고, 실패 3개(Notes 녹음 선택·전사)는 develop 원본에서도 같은 조건으로 실패한다.
- GitHub 호스트 macOS 러너(가상 머신)에서는 Vision 광학 흐름이 `memFullErr`(-108)로 실패한다. 그래서 실제 GPU 경로를 쓰는 단위 테스트 1개와 Electron spec은 `GITHUB_ACTIONS`에서 건너뛰고 실제 Mac에서 확인한다. CI는 `build:editor`의 `reels-slowmo` 빌드·서명과 나머지 단위 테스트를 확인한다.
- 단위 테스트 `tests/unit/slowmo.test.ts`(7개, 2026-11-28 정리):
  - 계획: 기본 0.5배·원본 fps 반올림, 길이 넘는 `end`는 원본 끝으로, 원본 60초 상한, 결과 600초, 기본 fps 최대 60, 고fps 원본 경고.
  - 입력 스키마: mov/mp4만, 속도·구간·절대 경로 검사.
  - 디스패치: 세 도구가 슬로우 포트로 가고, 포트가 없으면 `UNSUPPORTED`, `reels_get_slowmo_job`은 읽기 전용. 도구 등록 자체는 `reels-cli.test.ts`(모든 도구가 그룹 하나에 속함)와 MCP 목록 테스트가 맡는다.
  - 서비스(가짜 실행기): 같은 폴더의 숨김 partial 파일에 쓰고 성공 시에만 이름 바꾸기, 기존 출력(`SLOWMO_OUTPUT_EXISTS`)·원본 덮어쓰기·영상 아닌 원본·없는 폴더 거절, 실패·취소 시 partial 삭제, 원본 불변.
  - 실제 GPU: 빌드된 `.build/reels-slowmo`(또는 `SLOWMO_BIN`)와 Homebrew ffmpeg가 있으면 합성 세로 영상으로 프레임 수·fps·회전 유지·보간 수·원본 바이트 불변을 확인한다. `GITHUB_ACTIONS`에서는 건너뛴다.
