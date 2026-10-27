"""영상 템플릿 구성·노출 조건. CLI 진입점을 참조하지 않는다."""
import argparse
import json
import math
from dataclasses import asdict
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from reels_editor.entities.overlay import (
    BYLINE_FONT,
    BYLINE_INDEX,
    BYLINE_RATIO,
    KR_FONT,
    KR_BOLD,
    KR_FILM_FONT,
    KR_PLACE_INDEX,
    PIN_SCALE,
    PIN_BANNER_STYLE,
    OverlayTemplate,
    OVERLAY_TEMPLATES,
    font_record,
    resolve_japanese_font,
)
from reels_editor.entities.overlay import (
    resolve_place_font,
    render_overlay,
    render_byline_overlay,
    append_byline,
    render_hook_only_overlay,
    render_tape_background,
)
from reels_editor.entities.overlay import (
    visible_left,
    visible_top,
    default_pin_top,
    SAFE_TOP,
    SAFE_BOTTOM,
    layer_record,
    OverlayLayer,
    OverlayGroup,
    place_glyph,
    move_groups,
    fit_to_instagram_safe_zone,
)

KR_PLACE_FONT = KR_FONT
KR_PLACE_FONT_INDEX = KR_PLACE_INDEX
DEFAULT_PIN_SCALE = PIN_SCALE
BYLINE_GAP_RATIO = 0.010

def resolve_layout(args: argparse.Namespace) -> OverlayTemplate:
    try:
        base = OVERLAY_TEMPLATES[args.template]
    except KeyError as exc:
        raise ValueError(f"알 수 없는 오버레이 템플릿: {args.template}") from exc
    return OverlayTemplate(
        align=args.align if args.align is not None else base.align,
        x=args.x if args.x is not None else (
            (.5 if args.align == "center" else .055) if args.align else base.x),
        y=args.y if args.y is not None else base.y,
        hook_size=(
            args.hook_size if args.hook_size is not None else base.hook_size
        ),
        place_x=args.place_x if args.place_x is not None else base.place_x,
        place_y=args.place_y if args.place_y is not None else base.place_y,
        order=base.order,
        include_byline=base.include_byline,
    )

def default_output_path(src: Path, template: str | None) -> Path:
    suffix = "pin" if template in (None, "shimbashi-pin-only") else template
    return src.with_name(f"{src.stem}_{suffix}{src.suffix}")

def build_enable_expression(interval_spec: str) -> str:
    """`0-3.8,15.9-end` 형식을 FFmpeg enable 표현식으로 바꾼다."""
    clauses: list[str] = []
    for raw_interval in interval_spec.split(","):
        interval = raw_interval.strip()
        if not interval or interval.count("-") != 1:
            raise ValueError(f"잘못된 노출 구간: {raw_interval!r}")
        start_text, end_text = (part.strip() for part in interval.split("-", 1))
        try:
            start = float(start_text)
        except ValueError as exc:
            raise ValueError(f"잘못된 시작 시간: {start_text!r}") from exc
        if not math.isfinite(start) or start < 0:
            raise ValueError("노출 시작 시간은 0 이상이어야 합니다")
        if end_text.lower() == "end":
            clauses.append(f"gte(t,{start:g})")
            continue
        try:
            end = float(end_text)
        except ValueError as exc:
            raise ValueError(f"잘못된 종료 시간: {end_text!r}") from exc
        if not math.isfinite(end) or end <= start:
            raise ValueError(f"종료 시간은 시작 시간보다 커야 합니다: {interval!r}")
        clauses.append(f"between(t,{start:g},{end:g})")
    if not clauses:
        raise ValueError("노출 구간이 비어 있습니다")
    return "+".join(clauses)

def render_detached_hook_overlay(
    width: int,
    height: int,
    place: str,
    hook_lines: list[str],
    place_font_px: int,
    hook_font_px: int,
    align: str,
    hook_x: float,
    hook_y: float,
    place_x: float,
    place_y: float,
    font_path: str | None = None,
    pin_scale: float = DEFAULT_PIN_SCALE,
    explicit_y: bool = False,
    explicit_place_y: bool = False,
) -> tuple[Image.Image, list[str]]:
    pin, hook, notes = render_persistent_pin_overlays(
        width, height, place, hook_lines, place_font_px, hook_font_px,
        align, hook_x, hook_y, place_x, place_y, font_path, pin_scale,
        explicit_y, explicit_place_y)
    pin.alpha_composite(hook)
    return pin, notes

def render_persistent_pin_overlays(
    width: int,
    height: int,
    place: str,
    hook_lines: list[str],
    place_font_px: int,
    hook_font_px: int,
    align: str,
    hook_x: float,
    hook_y: float,
    place_x: float,
    place_y: float,
    font_path: str | None = None,
    pin_scale: float = DEFAULT_PIN_SCALE,
    explicit_y: bool = False,
    explicit_place_y: bool = False,
    *, hook_renderer=None,
) -> tuple[Image.Image, Image.Image, list[str]]:
    """상시 핀 레이어와 시간 지정 훅·서명 레이어를 만든다."""
    place_overlay = render_overlay(place, place_font_px, font_path, pin_scale)
    hook_renderer = render_hook_only_overlay if hook_renderer is None else hook_renderer
    hook_overlay = hook_renderer(
        place,
        hook_lines,
        place_font_px,
        hook_font_px,
        align,
        font_path,
        pin_scale,
    )
    byline = render_byline_overlay(round(width * BYLINE_RATIO))
    hook_group = append_byline(
        hook_overlay, byline, round(height * BYLINE_GAP_RATIO), align)

    persistent = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    place_left, place_top, place_note = fit_to_instagram_safe_zone(
        place_overlay,
        width,
        height,
        visible_left(place_overlay, width, place_x),
        (visible_top(place_overlay, height, place_y) if explicit_place_y else
         default_pin_top(place_overlay, height, place_y)),
        "상시 장소 핀",
    )
    persistent.alpha_composite(place_overlay, (place_left, place_top))

    timed_hook_signature = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    desired_hook_left = (
        visible_left(hook_group, width, hook_x, align)
    )
    hook_left, hook_top, hook_note = fit_to_instagram_safe_zone(
        hook_group,
        width,
        height,
        desired_hook_left,
        (visible_top(hook_group, height, hook_y) if explicit_y else
         round(height*hook_y-hook_overlay.height/2)),
        "시간 지정 훅+서명",
    )
    timed_hook_signature.alpha_composite(hook_group, (hook_left, hook_top))
    notes = [note for note in (place_note, hook_note) if note]
    return persistent, timed_hook_signature, notes

def render_pin_banner_layers(
    width, height, place, headline, place_font_px, font_path=None,
    *, note=None, hook_ratio=None, pin_scale=DEFAULT_PIN_SCALE,
    pin_x=.5, pin_y=None, material="rectangle",
):
    """기존 핀을 그대로 두고, 그 아래 검은 한 줄 바와 선택적 촬영일을 배치한다."""
    style = PIN_BANNER_STYLE
    if material not in ("rectangle", "tape"):
        raise ValueError("지원하지 않는 한 줄 바 배경입니다")
    default_ratio = style.tape_font_ratio if material == "tape" else style.font_ratio
    ratio = default_ratio if hook_ratio is None else hook_ratio
    if not 0 < ratio <= .082:
        raise ValueError("한 줄 바의 글자 크기가 허용 범위를 벗어납니다")
    for label, value in [("한 줄 문구", headline), ("촬영일/메모", note)]:
        if value is None and label == "촬영일/메모":
            continue
        if not value or not value.strip() or any(c in value for c in "\r\n|"):
            raise ValueError(f"{label}는 비어 있지 않은 한 줄이어야 합니다")

    def centered_position(glyph, top, label):
        left = visible_left(glyph, width, pin_x)
        fit_to_instagram_safe_zone(glyph, width, height, left, top, label)
        return left, top

    pin_glyph = render_overlay(place, place_font_px, font_path, pin_scale)
    pin_top = (default_pin_top(pin_glyph, height) if pin_y is None
               else visible_top(pin_glyph, height, pin_y))
    x, y = centered_position(pin_glyph, pin_top, "장소 핀")
    pin = Image.new("RGBA", (width, height))
    pin.alpha_composite(pin_glyph, (x, y))

    def text_image(text, size, boxed):
        if boxed and material == "tape":
            font = ImageFont.truetype(KR_FILM_FONT, size)
            tracking = width*style.tape_tracking_ratio
            stroke = max(1, round(width/2160))
            positions, boxes, cursor = [], [], 0
            for char in text:
                box = font.getbbox(char, stroke_width=stroke)
                positions.append(cursor)
                boxes.append((cursor+box[0], box[1], cursor+box[2], box[3]))
                cursor += font.getlength(char)+tracking
            left, top = min(b[0] for b in boxes), min(b[1] for b in boxes)
            right, bottom = max(b[2] for b in boxes), max(b[3] for b in boxes)
            px, py = round(width*style.tape_padding_x_ratio), round(width*style.tape_padding_y_ratio)
            w, h = math.ceil(right-left)+2*px, bottom-top+2*py
            if w > math.floor(width*style.tape_max_width_ratio):
                raise ValueError("한 줄 문구가 너무 깁니다. 줄바꿈이나 자동 축소 대신 문구를 줄여주세요")
            im = render_tape_background(w, h)
            draw = ImageDraw.Draw(im)
            for char, x in zip(text, positions):
                draw.text((px+x-left, py-top), char, font=font, fill=(249, 244, 234, 255),
                          stroke_width=stroke, stroke_fill=(249, 244, 234, 255))
            return im
        font = ImageFont.truetype(KR_FONT, size, index=KR_BOLD if boxed else KR_PLACE_INDEX)
        box = font.getbbox(text)
        padding_x = style.tape_padding_x_ratio if material == "tape" else style.padding_x_ratio
        px = round(width*padding_x) if boxed else 3
        py = round(width*style.padding_y_ratio) if boxed else 3
        w, h = box[2]-box[0]+2*px, box[3]-box[1]+2*py
        if w > math.floor(width*style.max_width_ratio):
            raise ValueError("한 줄 문구가 너무 깁니다. 줄바꿈이나 자동 축소 대신 문구를 줄여주세요")
        im = Image.new("RGBA", (w, h), (0, 0, 0, 255) if boxed else (0, 0, 0, 0))
        ImageDraw.Draw(im).text((px-box[0], py-box[1]), text, font=font,
            fill="white", stroke_width=0 if boxed else 1, stroke_fill=(0, 0, 0, 170))
        return im

    font_px = round(width*ratio)
    banner_glyph = text_image(headline, font_px, True)
    banner_y = pin.getbbox()[3]+round(height*style.pin_gap_ratio)
    note_layer = Image.new("RGBA", (width, height))
    banner = Image.new("RGBA", (width, height))

    def place_below(layer, glyph, top, label):
        left, top = centered_position(glyph, top, label)
        layer.alpha_composite(glyph, (left, top))

    place_below(banner, banner_glyph, banner_y, "검은 한 줄 바")
    if note is not None:
        note_glyph = text_image(note, round(width*style.note_font_ratio), False)
        place_below(note_layer, note_glyph,
                    banner_y+banner_glyph.height+round(height*style.note_gap_ratio), "촬영일/메모")
    metadata = {
        "template": "shimbashi-pin-banner", "version": style.version,
        "horizontal_alignment": "visible-bounds-center", "center_x": width*pin_x,
        "size": [width, height], "place": place, "headline": headline, "note": note,
        "pin_bbox": pin.getbbox(), "banner_bbox": banner.getbbox(),
        "note_bbox": note_layer.getbbox(), "headline_font_px": font_px,
        "headline_font": KR_FILM_FONT if material == "tape" else KR_FONT,
        "headline_font_index": 0 if material == "tape" else KR_BOLD,
        "tracking_px": width*style.tape_tracking_ratio if material == "tape" else 0,
        "background_rgba": [18, 18, 17, 255] if material == "tape" else [0, 0, 0, 255],
        "material": material, "material_version": 2 if material == "tape" else 1,
        "text_rgba": [249, 244, 234, 255] if material == "tape" else [255, 255, 255, 255],
        "signature": False, "automatic_wrapping_or_shrinking": False,
    }
    return pin, banner, note_layer, metadata

def render_caption_layers(config, width, height, duration, place, place_font_px, place_font):
    def finite_number(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

    if not isinstance(config, dict) or not {'font_size_ratio', 'y', 'captions'} <= config.keys():
        raise ValueError('자막 JSON에는 font_size_ratio, y, captions 필드가 필요합니다')
    size, y = config['font_size_ratio'], config['y']
    if not finite_number(size) or not finite_number(y):
        raise ValueError('자막 font_size_ratio와 y는 유한한 숫자여야 합니다')
    if not isinstance(config['captions'], list) or not config['captions']:
        raise ValueError('자막 captions는 비어 있지 않은 목록이어야 합니다')
    if not (0 < size <= 0.082 and SAFE_TOP <= y <= SAFE_BOTTOM):
        raise ValueError("자막 크기 또는 세로 위치가 허용 범위를 벗어납니다")
    layers = []
    previous_end = 0
    for caption in config["captions"]:
        if not isinstance(caption, dict) or not {'start', 'end', 'text'} <= caption.keys():
            raise ValueError('각 자막에는 start, end, text 필드가 필요합니다')
        start, end = caption['start'], caption['end']
        if not finite_number(start) or not finite_number(end):
            raise ValueError('자막 start와 end는 유한한 숫자여야 합니다')
        if not isinstance(caption['text'], str):
            raise ValueError('자막 text는 문자열이어야 합니다')
        lines = caption['text'].splitlines()
        if not (previous_end <= start < end <= duration):
            raise ValueError("자막 구간은 순서대로 겹치지 않고 영상 길이 안에 있어야 합니다")
        if not (1 <= len(lines) <= 2 and all(line.strip() for line in lines)):
            raise ValueError("자막은 비어 있지 않은 한 줄 또는 두 줄이어야 합니다")
        glyphs = render_hook_only_overlay(
            place, lines, place_font_px, round(width * size), "center", place_font)
        glyphs = glyphs.crop(glyphs.getbbox())
        left, top, _ = fit_to_instagram_safe_zone(
            glyphs, width, height, round(width / 2 - glyphs.width / 2),
            round(height * y - glyphs.height / 2), "본문 자막")
        layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        layer.alpha_composite(glyphs, (left, top))
        # Fractional frame timestamps can fall just below a decimal cue boundary.
        layers.append((layer, f"gte(round(t*1000000),{round(start * 1000000)})"
                              f"*lt(round(t*1000000),{round(end * 1000000)})"))
        previous_end = end
    if not layers:
        raise ValueError("자막 목록이 비어 있습니다")
    return layers

def resolved_video_style(args, layout, width):
    path = resolve_place_font(args.place, args.font)
    path, index = ((path, KR_PLACE_INDEX if path == KR_FONT else 0)
                   if path else resolve_japanese_font())
    style = {'template': asdict(layout),
             'place_font': font_record(path, index, round(width*args.size)),
             'place_size_ratio': args.size, 'pin_scale': args.pin_scale}
    if args.template == 'shimbashi-pin-banner':
        tape = args.banner_material == 'tape'
        ratio = args.hook_size if args.hook_size is not None else (
            PIN_BANNER_STYLE.tape_font_ratio if tape else PIN_BANNER_STYLE.font_ratio)
        style['description'] = dict(asdict(PIN_BANNER_STYLE), material=args.banner_material,
            font=font_record(KR_FILM_FONT if tape else KR_FONT, 0 if tape else KR_BOLD, round(width*ratio)))
    elif args.hook:
        style['hook_font'] = font_record(KR_FONT, KR_BOLD, round(width*layout.hook_size))
        style['signature_font'] = font_record(BYLINE_FONT, BYLINE_INDEX, round(width*BYLINE_RATIO))
    return style

def build_video_groups(args, layout, width, height, duration, enable_expression):
    """템플릿 구성 → 이름 있는 묶음 → 이동. 인코딩/파일 쓰기는 여기서 하지 않는다."""
    place_font = resolve_place_font(args.place, args.font)
    place_font_px = round(width * args.size)
    place_enable = None if args.persistent_pin else enable_expression
    metadata = {}
    if args.template == 'shimbashi-pin-banner':
        pin, banner, note, metadata = render_pin_banner_layers(
            width, height, args.place, args.hook, place_font_px, place_font,
            note=args.note, hook_ratio=args.hook_size, pin_scale=args.pin_scale,
            material=args.banner_material, pin_x=layout.x, pin_y=args.y)
        layers = [OverlayLayer('pin', pin, place_enable),
                  OverlayLayer('description', banner, enable_expression)]
        if note.getbbox():
            layers.append(OverlayLayer('note', note, place_enable))
        groups = [OverlayGroup('place-guide', 'pin', layers)]
    elif args.template == 'shimbashi-pin-only':
        glyph = render_overlay(args.place, place_font_px, place_font, args.pin_scale)
        pin = place_glyph(glyph, width, height, layout.x, args.y, align=layout.align,
                          top=default_pin_top(glyph, height, layout.y), label='장소 핀')
        groups = [OverlayGroup('place-guide', 'pin', [OverlayLayer('pin', pin, place_enable)])]
    else:
        hook_lines = [line.strip() for line in args.hook.split('|') if line.strip()]
        if not hook_lines:
            raise ValueError('훅 텍스트가 비어 있습니다')
        pin, hook, _ = render_persistent_pin_overlays(
            width, height, args.place, hook_lines, place_font_px,
            round(width*layout.hook_size), layout.align, layout.x, layout.y,
            layout.place_x, layout.place_y, place_font, args.pin_scale,
            explicit_y=args.y is not None, explicit_place_y=args.place_y is not None)
        groups = [OverlayGroup('place-guide', 'pin', [OverlayLayer('pin', pin, place_enable)]),
                  OverlayGroup('hook-signature', 'hook-signature',
                               [OverlayLayer('hook-signature', hook, enable_expression)])]
    if args.captions is not None:
        config = json.loads(args.captions.read_text(encoding='utf-8'))
        captions = render_caption_layers(config, width, height, duration,
                                         args.place, place_font_px, place_font)
        groups.append(OverlayGroup('body-captions', 'caption', [
            OverlayLayer(f'caption-{i}', layer, enable) for i, (layer, enable) in enumerate(captions, 1)]))
    groups = move_groups(groups, offset_x=args.offset_x, offset_y=args.offset_y,
        place_offset_x=args.place_offset_x, place_offset_y=args.place_offset_y,
        hook_offset_x=args.hook_offset_x, hook_offset_y=args.hook_offset_y)
    if metadata:
        guide = groups[0]
        for layer in guide.layers:
            key = {'pin': 'pin_bbox', 'description': 'banner_bbox', 'note': 'note_bbox'}[layer.name]
            metadata[key] = layer.image.getbbox()
        metadata['center_x'] = layer_record(guide.layers[0].image)['center'][0]
    return groups, metadata
