# 무음 반복 GIF 변환 — 2026-11-12

블로그 동작 영상(건배, 음식 자르기 등)을 소리 없는 무한 반복 GIF로 만든다. 소리가 새지 않으니 영상을 1~2초로 자르지 않고 **원본 전체 길이**를 기본으로 쓴다. 구간이 필요하면 `start`/`end`로 지정한다.

## 진입점

- MCP/CLI `reels_convert_gif` (`reels convert-gif`).
- 보드 미디어 보기에서 영상을 열면 **무음 GIF 만들기** 버튼. 저장 위치를 고르면 기본값으로 변환하고 결과(파일명·길이·해상도·fps·크기·소요 시간·경고)를 보여 준다. 프로젝트 자료로 자동 등록하지 않는다.

## 입력과 결과

```json
{"sourcePath": "/abs/clip.mov", "outputPath": "/abs/clip.gif",
 "start": 0, "end": 3.5, "crop": {"x": 0, "y": 0.15, "width": 1, "height": 0.85},
 "width": 480, "fps": 15,
 "dither": "bayer", "maxBytes": 20000000, "overwrite": false}
```

`sourcePath`·`outputPath`만 필수다. 기본값: 전체 길이, 폭 480(회전 반영 후, 확대 안 함), 15fps(원본보다 높이지 않음), `bayer` 디더링, 무한 반복. 구간은 최대 60초다. 원본은 바꾸지 않고, 같은 이름의 출력은 `overwrite: true`일 때만 교체한다. 출력은 같은 폴더의 숨김 `.partial` 파일에 쓴 뒤 이름을 바꾼다.

결과: `outputPath, bytes, width, height, fps, frames, durationSeconds, start, end, sourceDurationSeconds, elapsedMs, accel(videotoolbox|cpu), hdrToSDR, rotation, crop, dither, loop:"infinite", audio:"removed", metadata:"removed", attempts[], warnings[]`.

- 20MB를 넘으면 경고한다. 네이버 블로그 GIF 상한은 공식 문서로 확인하지 못했고, 20MB는 제3자 자료에서 흔히 보이는 수치일 뿐이다.
- `maxBytes`를 주면 넘을 때 fps를 먼저(10까지), 그다음 폭을(240까지) 낮춰 최대 4번 다시 만든다. 모든 시도를 `attempts`에 남긴다.
- `crop`(선택, 2026-11-12 추가)은 회전을 반영한 **화면 기준** 비율 `{x, y, width, height}`(0~1, 왼쪽 위 기준)다. 위 15% 제거 = `{"x":0,"y":0.15,"width":1,"height":0.85}`. `x+width`·`y+height`가 1을 넘거나 폭·높이가 0이면 스키마 오류, 잘라낸 영역이 원본 화면 픽셀로 16px 미만이면 `GIF_CROP` 오류다. `width`(기본 480, 확대 안 함)·`fps`·`maxBytes` 재시도는 잘라낸 영역에 그대로 적용된다. 결과의 `crop`은 요청 비율과 원본 화면 픽셀 사각형 `pixels{x,y,width,height}`이고, 자르지 않으면 `null`이다. CLI는 `reels convert-gif --source-path … --output-path … --crop '{"x":0,"y":0.15,"width":1,"height":0.85}'` 또는 `--input` JSON. 보드의 **무음 GIF 만들기** 버튼에는 크롭 UI를 붙이지 않았다(기본값 변환).
- `dither: "smooth"`(sierra2_4a 오차 확산)는 부드러운 그라데이션이 중요할 때 쓴다. 기본 `bayer`보다 2~3배 느리고 20%쯤 크다.

## 파이프라인

번들 ffmpeg 8.1(`editor-runtime/bin/ffmpeg`, `.build/media`에서 빌드)만 쓴다. 새 의존성은 없다.

1. ffprobe로 크기·길이·fps·HDR(HLG/PQ)·디스플레이 행렬 회전을 읽는다. 해석은 재생 사본(`editor_cli.py proxy`)과 같다.
2. **GPU 단계 (VideoToolbox):** `-hwaccel videotoolbox` 디코드 → `transpose_vt`(회전) → `scale_vt`(축소, HDR이면 BT.709 SDR 변환) → `hwdownload`. 프레임은 다운로드 직전까지 GPU에 있다.
   - **크롭(GPU 경로 유지):** `scale_vt`가 회전된 전체 프레임을 "남길 영역이 출력 크기가 되는 크기"로 줄이고(예: 1080×1920 → 480×854), `hwdownload` 직후 이미 작아진 프레임에서 `crop=w:h:x:y:exact=1`로 자른다(480×726, y=128). 디코드·회전·톤매핑·축소는 그대로 GPU에서 하고, CPU는 출력 크기만큼 행을 복사한다. 오프셋은 짝수로 맞춰 4:2:0 색차가 어긋나지 않는다. CPU 경로도 같은 지점(축소 뒤, 톤매핑 전)에서 같은 사각형을 자른다.
   - 다른 후보 실측: VideoToolbox 프레임에 `crop`을 먼저 걸고 `scale_vt`로 줄이는 방식도 이 ffmpeg 8.1에서는 같은 영역이 나왔다(PSNR 54dB). 하지만 하드웨어 프레임의 crop 필드를 `scale_vt`가 따르는 동작에 기대므로 무시되면 늘어진 영상이 조용히 나온다. 디코더 `-apply_cropping`은 비트스트림/컨테이너 크롭 정보만 적용하고 임의 사각형을 받지 않는다. 원본 해상도로 내려받아 CPU에서 자르면 같은 속도였지만 내려받는 양이 크다. 그래서 위 방식을 택했다. 8초 영상 프레임 처리만(GIF 인코딩 제외) 0.81초로 크롭 없음과 같다.
3. **CPU 단계:** 팔레트(`palettegen=stats_mode=full`)는 구간 전체에서 약 48프레임만 뽑아 만든다(전체 프레임 대비 3~4배 빠르고 결과 차이 없음). 이어 `paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`로 모든 프레임을 하나의 팔레트에 맞추고 GIF로 쓴다. `-an -map_metadata -1 -loop 0`.
4. GPU 경로가 실패하거나 반전·비직각 회전이면 CPU 경로(소프트웨어 디코드, lanczos 축소, zscale+hable 톤매핑)로 바꾸고 `accel: "cpu"`와 경고를 남긴다.

GIF 양자화·디더링·LZW 인코딩은 CPU 작업이라 GPU로 옮길 수 없다. 소요 시간의 대부분이 이 단계다.

## 라이브러리 선택

| 후보 | 결론 |
| --- | --- |
| **번들 ffmpeg palettegen/paletteuse + VideoToolbox (선택)** | 이미 앱에 있고(번들 증가 0), LGPL/GPL 고지가 이미 있다. 디코드·회전·HDR 변환·축소를 GPU로 하고 팔레트는 샘플링으로 줄였다. |
| gifski 1.34 (libimagequant) | 품질(프레임별 팔레트·temporal dithering)과 같은 품질 대비 용량은 가장 좋다. 하지만 **AGPL-3.0**(상용 라이선스 별도)이고, libimagequant도 GPLv3/상용이다. 새 바이너리와 ffmpeg 의존이 추가된다. 실측 속도는 이 경로와 비슷했다. |
| ImageIO `CGImageDestination` | 양자화·디더링 제어가 거의 없어 그라데이션 밴딩 위험이 크다. |
| MIT/Apache 양자화 crate(quantette 등) | 새 네이티브 빌드가 필요해 가볍지 않다. 현재 결과로 충분해 보류했다. |

## 실측 (Apple Silicon, 2026-11-12)

원본: iPhone HEVC 10bit HLG, 저장 1920×1080 + 디스플레이 회전 −90°(세로 1080×1920), 30fps, 8초, 오디오 포함.

| 방식 | 시간 | 크기 |
| --- | --- | --- |
| 이 구현 기본값(480×854, 15fps, bayer) | 4.1~5.0초(첫 실행 8.0초) | 23.1MB |
| 이 구현 `maxBytes: 20000000` | 7.8초(2회 시도, 15→12fps) | 18.5MB |
| 이 구현 `dither: "smooth"` | 12.8초 | 28.3MB |
| 기준선: CPU 디코드+zscale 톤매핑+palettegen(diff, 전체 프레임)+sierra2_4a 한 번에 | 22.8초 | 28.2MB |
| 참고: gifski 1.34 `-Q 90` (GPU로 뽑은 PNG 입력, PNG 저장 0.8초 포함) | 5.5초 | 20.2MB |
| 참고: gifski 1.34 `-Q 80` | 5.2초 | 16.3MB |

육안 확인: 회전 정상(세로), HDR→SDR 톤 자연스러움(색 바램·과포화 없음), 맥주 거품·튀김 종이 그라데이션에 큰 밴딩 없음. `bayer`는 흰 종이에 아주 옅은 격자 무늬, `smooth`는 얼룩진 계조가 보이는 정도다. 결과 GIF에 오디오 스트림·위치 정보 없음, NETSCAPE2.0 반복 횟수 0(무한)을 확인했다.

크롭 실측(2026-11-12, `IMG_7360.MOV` 같은 원본, `crop {x:0,y:0.15,width:1,height:0.85}`, `maxBytes: 10000000`): `accel: "videotoolbox"`, 경고 없음, 3회 시도(480×726@15fps 20.7MB → @10fps 13.9MB → 396×598@10fps **9.99MB**), 14.2초(같은 조건 두 번째 실행 10.9초). 같은 `maxBytes`로 크롭 없이 하면 4회 시도 끝에 334×594@10fps 8.4MB, 23.6초였다. 크롭하면 버리는 위쪽 픽셀이 없어 같은 용량에서 폭을 더 남긴다. 결과 프레임은 회전·톤 정상, 위쪽만 잘렸다.

실제 블로그 동작 영상은 손떨림으로 매 프레임 전체가 바뀌어 프레임당 약 150~190KB가 나온다. 8초짜리를 20MB 안에 넣으려면 12fps 이하나 폭 400 안팎이 필요하다.

## 제한

- 네이버 블로그 GIF 업로드 상한 미확인. 실제 업로드로 확인해야 한다.
- 반전 영상은 CPU 경로로만 처리한다. 비직각 회전은 지원하지 않는다.
- 변환은 한 번에 하나씩 순서대로 한다. 60초 넘는 구간은 거절한다.
