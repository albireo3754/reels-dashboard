"""rosy.trip 릴스 썸네일 생성기.

자막 없는 촬영 원본에 장소 핀·두 줄 훅·분홍 서명을 넣는다.
기본 rosy-auto는 최대185px에서 실제 문구 폭에 맞춰 두 줄을 같은 크기로 조절한다.

기본: python3 make_thumbnail.py input.mov out.png --place "서울" --hook "첫 줄|둘째 줄" --t 0
위치 조정: 위 명령에 --offset-x 0.02 --offset-y 0.01 추가
사전 확인: 위 명령에 --dry-run --preview /tmp/cover.png 추가

기본은 훅·서명 왼쪽 정렬(여백 7%), 장소 핀 가로 중앙(50%), 기존 높이 유지다.
--x/--y는 훅에 적용하고 서명도 함께 이동한다. --place-x/--place-y는 별도 핀이다.
--align center를 명시하면 훅·서명만 중앙 정렬한다. 용어 정본: templates/editing-glossary.md
템플릿 기본값 → 명시 좌표 → 전체 오프셋 순으로 적용한다.
실제 표시 영역이 x 4~96%, y 20~79%를 넘으면 이동·축소 없이 오류로 멈춘다.
legacy는 기존 배치 유지, 새 배치 옵션은 표준 템플릿 전용이다."""
import argparse
import json
from dataclasses import asdict
import sys
from pathlib import Path
from PIL import Image
from reels_editor.entities.overlay import (
    KR_FONT,
    KR_BOLD,
    BYLINE_FONT,
    BYLINE_INDEX,
    DEFAULT_THUMBNAIL,
    THUMBNAIL_STYLES,
    resolve_japanese_font,
    font_record,
    KR_PLACE_INDEX,
)
from reels_editor.entities.overlay import resolve_place_font
from reels_editor.entities.overlay import layer_record
from reels_editor.entities.overlay import add_position_arguments, position_request
from reels_editor.shared.cli import render_options
from reels_editor.shared.media import probe_video
from reels_editor.shared.media import extract_frame, STILL_IMAGE_SUFFIXES
from .model import draw_hook, make_mark, render_thumbnail_groups, resolve_thumbnail_hook_size


def main(argv=None, *, preset=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, allow_abbrev=False,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    add_position_arguments(ap)
    ap.add_argument("video")
    ap.add_argument("output")
    ap.add_argument("--hook", required=True, help="훅 텍스트, 줄바꿈은 | 로 구분")
    ap.add_argument("--place", help="장소 핀 (기본 템플릿 필수)")
    ap.add_argument("--keep-existing-pin", action="store_true",
                    help="사용자가 지정한 완성 영상의 기존 핀을 유지하고 새 핀은 합성하지 않음")
    ap.add_argument("--hook-size", type=int,
                    help="명시적 크기 변경 (2160px 폭 기준). 생략하면 기본 rosy-auto는 실제 표시 폭에 맞춰 132~185px 자동 선택")
    ap.add_argument("--template", choices=(*THUMBNAIL_STYLES, "legacy"), default=DEFAULT_THUMBNAIL)
    ap.add_argument("--sub", default="", help="훅 아래 서브 텍스트(장소명)")
    ap.add_argument("--no-badge", action="store_true", help="좌측 배지 생략")
    ap.add_argument("--t", type=float, default=3.0, help="영상 프레임 추출 시점(초). PNG/JPG/WebP는 정지 이미지 그대로 사용")
    ap.add_argument("--badge-y", type=float, default=0.235, help="배지 세로 위치 비율")
    args = ap.parse_args(argv)
    import math
    if not math.isfinite(args.t) or args.t < 0:
        ap.error('--t는 0 이상의 유한한 초 단위 값이어야 합니다')
    position_keys = ('align', 'x', 'y', 'place_x', 'place_y')
    if args.template == 'legacy' and (any(getattr(args, key) is not None for key in position_keys)
            or any(getattr(args, key) for key in ('offset_x', 'offset_y', 'place_offset_x',
                 'place_offset_y', 'hook_offset_x', 'hook_offset_y')) or args.dry_run or args.preview):
        ap.error('배치 옵션과 --dry-run/--preview는 표준 썸네일 템플릿 전용입니다')
    if args.keep_existing_pin and (args.place_x is not None or args.place_y is not None
                                  or args.place_offset_x or args.place_offset_y):
        ap.error('--keep-existing-pin으로 원본에 박힌 핀의 위치를 바꿀 수 없습니다')
    if args.hook_size is not None and not 1 <= args.hook_size <= 185:
        ap.error("--hook-size는 1~185 범위여야 합니다")
    if args.template == "legacy" and args.hook_size is not None:
        ap.error("--hook-size는 표준 썸네일 템플릿 전용입니다")
    if args.template == "legacy" and args.keep_existing_pin:
        ap.error("--keep-existing-pin은 표준 썸네일 템플릿 전용입니다")

    lines = [line.strip() for line in args.hook.split("|")]
    if args.template in THUMBNAIL_STYLES:
        if not args.place or not args.place.strip():
            ap.error("--place에 장소명을 넣으세요")
        if len(lines) != 2 or not all(lines):
            ap.error("--hook은 '첫 줄|둘째 줄' 형식의 두 줄이어야 합니다")
        if args.sub:
            ap.error("기본 템플릿의 장소명은 --place로 지정합니다. --sub는 --template legacy 전용입니다")

    video = Path(args.video).expanduser()
    if not video.exists():
        sys.exit(f"영상 없음: {video}")

    output = Path(args.output).expanduser()
    if output.resolve() == video.resolve():
        ap.error('입력 원본과 다른 출력 경로를 지정하세요')
    if args.preview and args.preview.resolve() in (video.resolve(), output.resolve(), output.with_suffix(".style.json").resolve()):
        ap.error('--preview는 입력/출력과 다른 PNG 경로여야 합니다')
    if video.suffix.lower() not in STILL_IMAGE_SUFFIXES:
        _, (w, h), duration = probe_video(video)
        if duration is not None and args.t >= duration:
            ap.error(f'--t {args.t:g}초는 영상 길이 {duration:g}초보다 작아야 합니다. 시작 프레임은 --t 0을 쓰세요')
        img = Image.new('RGBA', (w, h)) if args.dry_run and not args.preview else extract_frame(video, args.t)
    else:
        img = extract_frame(video, args.t)
    w, h = img.size

    manifest = None
    if args.template in THUMBNAIL_STYLES:
        style = THUMBNAIL_STYLES[args.template]
        hook_size, sizing = resolve_thumbnail_hook_size(lines, w, style, args.hook_size,
                                                        automatic=args.template == 'rosy-auto')
        groups = render_thumbnail_groups(img, lines, args.place, hook_size, args.keep_existing_pin, style,
            align=args.align or 'left', x=args.x, y=args.y,
            place_x=args.place_x, place_y=args.place_y, offset_x=args.offset_x, offset_y=args.offset_y,
            place_offset_x=args.place_offset_x, place_offset_y=args.place_offset_y,
            hook_offset_x=args.hook_offset_x, hook_offset_y=args.hook_offset_y)
        for group in groups:
            img.alpha_composite(group.composite())
        layers = {layer.name: layer_record(layer.image) for group in groups for layer in group.layers}
        place_font = None
        if not args.keep_existing_pin:
            kr_path = resolve_place_font(args.place, None)
            path, index = (kr_path, KR_PLACE_INDEX) if kr_path else resolve_japanese_font()
            place_font = font_record(path, index, round(w * style.place_ratio))
        manifest = {
            'template': args.template, 'version': style.version, 'style': asdict(style),
            'placement_version': 2, 'layers': layers, 'alignment': args.align or 'left',
            'render_options': render_options(args),
            'coordinate_units': 'frame-ratio; visible bounds',
            'requested': position_request(args),
            'groups': [group.record() for group in groups],
            'source': str(video.resolve()),
            'source_kind': 'image' if video.suffix.lower() in STILL_IMAGE_SUFFIXES else 'video',
            'source_time': None if video.suffix.lower() in STILL_IMAGE_SUFFIXES else args.t, 'size': [w, h],
            'hook': lines, 'place': args.place, 'keep_existing_pin': args.keep_existing_pin,
            'hook_size_at_2160': hook_size, 'hook_sizing': sizing,
            'hook_font': font_record(KR_FONT, KR_BOLD, round(hook_size * w / style.reference_width)),
            'place_font': place_font,
            'signature_font': font_record(BYLINE_FONT, BYLINE_INDEX, round(style.signature_size * w / style.reference_width)),
        }
    else:
        if not args.no_badge:
            mark = make_mark(round(h * 0.05))
            img.alpha_composite(mark, (0 - mark.height // 2, round(h * args.badge_y)))
        draw_hook(img, lines, args.sub)
    if preset is not None and manifest is not None:
        manifest['preset'] = preset
    if args.preview:
        img.convert('RGB').save(args.preview, format='PNG')
    if args.dry_run:
        print(json.dumps(manifest, ensure_ascii=False, indent=2))
        return
    img.convert("RGB").save(output, quality=95)
    if manifest is not None:
        output.with_suffix('.style.json').write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    print(f"완료: {args.output}")
