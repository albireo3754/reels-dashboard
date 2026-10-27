"""rosy.trip 영상에 장소 핀만 추가한다. 원래 자막과 음원은 유지한다.

기본: python3 pin_overlay.py input.mov "서울" -o out.mp4
위치 조정: 위 명령에 --offset-x 0.02 --offset-y 0.01 추가
사전 확인: 위 명령에 --dry-run --preview /tmp/pin.png 추가

기본은 shimbashi-pin-only, 표시 영역의 가로 중심 50%다. 기존 높이는 유지한다.
--x/--y는 핀 전용·바 템플릿에서는 핀, 그 외에는 훅+서명 묶음에 적용한다.
바·메모는 핀을 따라간다. 분리 핀은 --place-x/--place-y로 조정한다.
템플릿 기본값 → 명시 좌표 → 전체 오프셋 순으로 적용한다.
실제 표시 영역이 x 4~96%, y 20~79%를 넘으면 이동·축소 없이 오류로 멈춘다.
훅·서명은 기본적으로 make_thumbnail.py로 썸네일에 넣는다.
영상 훅은 명시적으로 요청받았을 때만 다른 --template으로 선택한다.

의존성: Pillow, ffmpeg (macOS 시스템 폰트 사용)"""
import argparse
import json
import math
import subprocess
import sys
import tempfile
from dataclasses import asdict
from pathlib import Path
from PIL import Image
from reels_editor.entities.overlay import (
    KR_FONT,
    KR_PLACE_INDEX,
    PLACE_RATIO,
    PIN_SCALE,
    OVERLAY_TEMPLATES,
)
from reels_editor.entities.overlay import add_position_arguments, position_request
from reels_editor.shared.cli import render_options
from reels_editor.shared.media import probe_video, extract_frame, run_ffmpeg_progress
from reels_editor.shared.timing import enable_at

DEFAULT_PIN_SCALE = PIN_SCALE

from .model import (
    build_enable_expression,
    build_video_groups,
    default_output_path,
    resolve_layout,
    resolved_video_style,
)

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    add_position_arguments(parser)
    parser.add_argument("input", type=Path)
    parser.add_argument("place", help="장소명 (예: 七里ヶ浜)")
    parser.add_argument("-o", "--output", type=Path)
    parser.add_argument(
        "--template",
        choices=tuple(OVERLAY_TEMPLATES),
        default="shimbashi-pin-only",
        help="기본: shimbashi-pin-only (장소 핀만). 영상 훅은 다른 템플릿을 명시해야 합니다",
    )
    parser.add_argument("--size", type=float, default=PLACE_RATIO,
                        help="장소 글자 크기 = 영상폭 × size (default 0.042)")
    parser.add_argument("--pin-scale", type=float, default=DEFAULT_PIN_SCALE,
                        help="📍 높이 = 장소 글자 높이 × pin-scale (default 1.45)")
    copy = parser.add_mutually_exclusive_group()
    copy.add_argument("--hook", help="영상 도입 훅, 줄바꿈은 |. 기존 바 명령에서도 사용 가능")
    copy.add_argument("--description", help="장소 설명 한 줄. shimbashi-pin-banner 전용")
    parser.add_argument("--note", help="pin-banner의 검은 바 아래 작은 한 줄 (예: 촬영일)")
    parser.add_argument("--banner-material", choices=("rectangle", "tape"), default="rectangle",
                        help="pin-banner 배경: 기본 사각형 또는 찢어진 무광 검정 테이프")
    parser.add_argument("--dovi-maxrate", type=int, default=80000,
                        help="Dolby Vision 재인코딩 최대 비트레이트(kbps), 기본 80000")
    parser.add_argument("--hook-size", type=float,
                        help="훅 글자 크기 = 영상폭 × hook-size")
    parser.add_argument(
        "--show-during",
        help="오버레이 노출 구간. 예: 0-3.8,15.9-end (기본: 영상 전체)",
    )
    parser.add_argument(
        "--persistent-pin",
        action="store_true",
        help="핀은 상시 노출하고 --show-during을 훅·서명 묶음에 적용",
    )
    parser.add_argument("--crf", type=int, default=18)
    parser.add_argument("--captions", type=Path,
                        help="명시적으로 요청한 본문 자막 JSON (font_size_ratio, y, captions)")
    parser.add_argument("--preview-time", type=float,
                        help="선택 시점의 실제 프레임과 활성 오버레이만 미리보기")
    parser.add_argument(
        "--font",
        help="장소명 폰트 파일 경로 (기본: 한글 Apple SD Gothic Neo SemiBold, 그 외 일본어 명조)",
    )
    return parser

def main(argv: list[str] | None = None, *, preset=None, progress_callback=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    requested = position_request(args)
    options = render_options(args)
    if not args.place.strip():
        parser.error("장소명이 비어 있습니다")
    for name, value, maximum in [("--size", args.size, .2), ("--hook-size", args.hook_size, .2),
                                  ("--pin-scale", args.pin_scale, 5)]:
        if value is not None and (not math.isfinite(value) or not 0 < value <= maximum):
            parser.error(f"{name}는 0보다 크고 {maximum} 이하여야 합니다")
    if args.description is not None:
        if args.template != 'shimbashi-pin-banner':
            parser.error('--description은 shimbashi-pin-banner의 장소 설명입니다')
        args.hook = args.description
    if args.template in ('shimbashi-pin-only', 'shimbashi-pin-banner'):
        if args.hook_offset_x or args.hook_offset_y:
            parser.error('이 템플릿에는 훅·서명 묶음이 없습니다. --place-offset-x/--place-offset-y를 쓰세요')
        for axis in ('x', 'y'):
            place_value = getattr(args, f'place_{axis}')
            if place_value is not None:
                if getattr(args, axis) is not None:
                    parser.error(f'--{axis}와 --place-{axis}는 같은 장소 안내 묶음 좌표이므로 함께 지정하지 마세요')
                if args.align == 'left':
                    parser.error('--place-x/--place-y는 중심 좌표입니다. --align left와 혼용하지 마세요')
                setattr(args, axis, place_value)
    if args.template == "shimbashi-pin-only" and args.hook_size is not None:
        parser.error("--hook-size는 훅이 있는 템플릿 전용입니다")
    if args.template not in ('shimbashi-pin-only', 'shimbashi-pin-banner') and not args.hook:
        parser.error('이 템플릿에는 --hook이 필요합니다. 장소 핀만 넣으려면 기본 템플릿을 쓰세요')
    if args.dovi_maxrate <= 0:
        sys.exit("--dovi-maxrate는 양수여야 합니다")
    layout = resolve_layout(args)
    if args.template == "shimbashi-pin-only" and args.hook:
        sys.exit("기본 영상은 장소 핀만 추가합니다. 훅은 make_thumbnail.py --hook으로 썸네일에 넣으세요. 영상 훅을 명시적으로 요청받았다면 다른 --template을 선택하세요.")
    is_banner = args.template == "shimbashi-pin-banner"
    if args.note is not None and not is_banner:
        sys.exit("--note는 shimbashi-pin-banner 템플릿에서 사용하세요")
    if args.banner_material != "rectangle" and not is_banner:
        sys.exit("--banner-material은 shimbashi-pin-banner 템플릿에서 사용하세요")
    if is_banner and (not args.hook or layout.align != "center"):
        sys.exit("shimbashi-pin-banner에는 한 줄 --hook과 중앙 정렬이 필요합니다")
    try:
        enable_expression = (
            build_enable_expression(args.show_during)
            if args.show_during is not None
            else None
        )
    except ValueError as exc:
        sys.exit(str(exc))

    src = args.input.expanduser()
    if not src.exists():
        sys.exit(f"입력 파일 없음: {src}")
    out = args.output or default_output_path(src, args.template)
    if out.resolve() == src.resolve():
        sys.exit("입력 원본과 다른 출력 경로를 지정하세요")

    video_stream, (width, height), duration = probe_video(src)
    if duration is None:
        parser.error("길이를 확인할 수 있는 영상을 입력하세요. 정지 이미지는 make_thumbnail.py를 사용하세요")
    if args.preview_time is not None and (not args.preview or not math.isfinite(args.preview_time)
                                         or not 0 <= args.preview_time < duration):
        parser.error('--preview-time은 --preview와 함께 영상 길이 안의 시점으로 지정하세요')
    preserve_hdr = video_stream.get("color_transfer") in ("arib-std-b67", "smpte2084")
    if preserve_hdr:
        if "10" not in video_stream["pix_fmt"]:
            sys.exit("HDR 입력은 10bit 원본이 필요합니다")
        encoding_args = [
            "-c:v", "hevc_videotoolbox", "-profile:v", "main10",
            "-pix_fmt", "p010le", "-b:v", "80M", "-tag:v", "hvc1",
        ]
        if any(
            data.get("side_data_type") == "DOVI configuration record"
            for data in video_stream.get("side_data_list", [])
        ):
            encoding_args = [
                "-c:v", "libx265", "-preset", "veryfast", "-crf", str(args.crf),
                "-pix_fmt", "yuv420p10le", "-dolbyvision", "1",
                "-x265-params", f"vbv-maxrate={args.dovi_maxrate}:vbv-bufsize={args.dovi_maxrate*2}:log-level=error",
                "-tag:v", "hvc1", "-strict", "unofficial",
            ]
        for key, option in (
            ("color_primaries", "-color_primaries"),
            ("color_transfer", "-color_trc"),
            ("color_space", "-colorspace"),
            ("color_range", "-color_range"),
        ):
            if key not in video_stream or video_stream[key] == "unknown":
                sys.exit(f"HDR 원본의 {key} 정보를 확인할 수 없습니다")
            encoding_args.extend([option, video_stream[key]])
        print("원본 HDR·10bit 유지: 색보정·톤매핑 없이 핀 합성", file=sys.stderr)
    else:
        encoding_args = [
            "-c:v", "libx264", "-crf", str(args.crf), "-preset", "medium",
            "-pix_fmt", "yuv420p",
        ]

    if args.persistent_pin and (not args.hook or enable_expression is None):
        parser.error('--persistent-pin에는 --hook/--description과 --show-during이 필요합니다')
    groups, banner_metadata = build_video_groups(args, layout, width, height, duration, enable_expression)
    overlay_layers = [(layer.image, layer.enable) for group in groups for layer in group.layers]
    manifest = dict(banner_metadata)
    manifest.update(template=args.template, source=str(src.resolve()), size=[width, height],
                    placement_version=1, layout=asdict(layout),
                    render_options=options, requested=requested,
                    coordinate_units='frame-ratio; visible bounds',
                    show_during=args.show_during, persistent_pin=args.persistent_pin,
                    groups=[group.record() for group in groups],
                    layers=[layer.record() for group in groups for layer in group.layers],
                    resolved_style=resolved_video_style(args, layout, width))

    if preset is not None:
        manifest['preset'] = preset
    if args.preview:
        if args.preview.resolve() in (src.resolve(), out.resolve(), out.with_suffix(".style.json").resolve()):
            parser.error('--preview는 입력/출력과 다른 PNG 경로여야 합니다')
        preview = (extract_frame(src, args.preview_time) if args.preview_time is not None
                   else Image.new('RGBA', (width, height)))
        for layer, enable in overlay_layers:
            if args.preview_time is None or enable_at(enable, args.preview_time):
                preview.alpha_composite(layer)
        preview.save(args.preview, format='PNG')
    if args.dry_run:
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return 0
    with tempfile.TemporaryDirectory() as tmp_dir:
        overlay_paths: list[str] = []
        for index, (layer, _) in enumerate(overlay_layers, start=1):
            layer_path = str(Path(tmp_dir) / f"overlay-{index}.png")
            layer.save(layer_path)
            overlay_paths.append(layer_path)
        filter_parts: list[str] = []
        previous = "[0:v]"
        for index, (_, layer_enable) in enumerate(overlay_layers, start=1):
            is_last = index == len(overlay_layers)
            output_label = "" if is_last else f"[v{index}]"
            part = f"{previous}[{index}:v]overlay=0:0"
            if preserve_hdr:
                part += ":format=yuv420p10"
            if layer_enable is not None:
                part += f":enable='{layer_enable}'"
            part += output_label
            filter_parts.append(part)
            previous = output_label
        overlay_filter = ";".join(filter_parts)
        if enable_expression is not None:
            print(f"오버레이 노출 구간: {args.show_during}")
        cmd = ["ffmpeg", "-y", "-i", str(src)]
        for overlay_path in overlay_paths:
            cmd.extend(["-i", overlay_path])
        cmd.extend([
               "-filter_complex", overlay_filter,
               "-fps_mode", "passthrough",
               *encoding_args,
               "-c:a", "copy", "-movflags", "+faststart",
               str(out)])
        if progress_callback is None:
            subprocess.run(cmd, check=True)
        else:
            run_ffmpeg_progress(cmd, duration, progress_callback)
    out.with_suffix('.style.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(f"완료: {out}")
    return 0
