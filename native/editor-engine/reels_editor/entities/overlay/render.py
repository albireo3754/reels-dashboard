"""영상과 썸네일에서 공유하는 장소 핀·훅·서명·테이프 렌더링.

캔버스 배치와 CLI 처리 없이 원래 픽셀 모양을 만드는 함수만 둔다.
"""

import math
import random

from PIL import (
    Image,
    ImageDraw,
    ImageFilter,
    ImageFont,
)
from .config import (
    BYLINE_FONT,
    BYLINE_INDEX,
    BYLINE_TEXT,
    ROSE_ACCENT,
    KR_FONT,
    KR_BOLD,
    KR_PLACE_INDEX,
    PIN_SCALE,
    EMOJI_FONT,
    resolve_japanese_font,
)

KR_PLACE_FONT = KR_FONT
KR_PLACE_FONT_INDEX = KR_PLACE_INDEX
DEFAULT_PIN_SCALE = PIN_SCALE
EMOJI_FONT = "/System/Library/Fonts/Apple Color Emoji.ttc"
EMOJI_STRIKE = 160  # Apple Color Emoji는 고정 스트라이크 크기로만 열린다


def render_brand_emoji(char: str, px: int) -> Image.Image:
    font = ImageFont.truetype(EMOJI_FONT, 160)
    canvas = Image.new("RGBA", (220, 220), (0, 0, 0, 0))
    ImageDraw.Draw(canvas).text((10, 10), char, font=font, embedded_color=True)
    glyph = canvas.crop(canvas.getbbox())
    return glyph.resize((px, round(px * glyph.height / glyph.width)), Image.LANCZOS)

def resolve_place_font(place: str, explicit_font: str | None) -> str | None:
    if explicit_font is not None:
        return explicit_font
    if any("\uac00" <= char <= "\ud7a3" for char in place):
        return KR_PLACE_FONT
    return None


def resolve_text_font() -> tuple[str, int]:
    return resolve_japanese_font()


def render_emoji(char: str, target_h: int) -> Image.Image:
    font = ImageFont.truetype(EMOJI_FONT, EMOJI_STRIKE)
    canvas = Image.new("RGBA", (EMOJI_STRIKE * 2, EMOJI_STRIKE * 2), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.text((EMOJI_STRIKE // 2, EMOJI_STRIKE // 2), char, font=font, embedded_color=True)
    bbox = canvas.getbbox()
    if bbox is None:
        raise RuntimeError(f"emoji {char!r} 렌더링 실패")
    glyph = canvas.crop(bbox)
    scale = target_h / glyph.height
    return glyph.resize((max(1, round(glyph.width * scale)), target_h), Image.LANCZOS)


def render_overlay(
    text: str,
    font_px: int,
    font_path: str | None = None,
    pin_scale: float = DEFAULT_PIN_SCALE,
) -> Image.Image:
    if font_path:
        font = ImageFont.truetype(
            font_path, font_px,
            index=KR_PLACE_FONT_INDEX if font_path == KR_PLACE_FONT else 0,
        )
    else:
        path, index = resolve_text_font()
        font = ImageFont.truetype(path, font_px, index=index)
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    tb = probe.textbbox((0, 0), text, font=font)
    text_w, text_h = tb[2] - tb[0], tb[3] - tb[1]

    pin = render_emoji("📍", round(text_h * pin_scale))
    gap = round(font_px * 0.22)
    pad = round(font_px * 0.6)  # 그림자 블러 여유
    w = pin.width + gap + text_w + pad * 2
    h = max(pin.height, text_h) + pad * 2
    base_y = pad + (max(pin.height, text_h) - text_h) // 2

    # 그림자 레이어 (가독성용 소프트 섀도)
    shadow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    off = max(2, font_px // 28)
    sd.text((pad + pin.width + gap - tb[0] + off, base_y - tb[1] + off),
            text, font=font, fill=(0, 0, 0, 170))
    shadow = shadow.filter(ImageFilter.GaussianBlur(max(2, font_px // 16)))

    overlay = shadow
    d = ImageDraw.Draw(overlay)
    d.text((pad + pin.width + gap - tb[0], base_y - tb[1]),
           text, font=font, fill=(255, 255, 255, 255))
    overlay.alpha_composite(pin, (pad, pad + (max(pin.height, text_h) - pin.height) // 2))
    return overlay


def render_hook_overlay(
    place: str,
    hook_lines: list[str],
    place_font_px: int,
    hook_font_px: int,
    align: str,
    font_path: str | None = None,
    pin_scale: float = DEFAULT_PIN_SCALE,
    order: str = "place-first",
) -> Image.Image:
    if order not in ("place-first", "hook-first"):
        raise ValueError(f"지원하지 않는 오버레이 순서: {order}")
    place_overlay = render_overlay(place, place_font_px, font_path, pin_scale)
    hook_font = ImageFont.truetype(KR_FONT, hook_font_px, index=KR_BOLD)
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    boxes = [probe.textbbox((0, 0), line, font=hook_font) for line in hook_lines]
    text_widths = [box[2] - box[0] for box in boxes]
    inset = round(place_font_px * 0.6)
    gap = round(hook_font_px * 0.1)
    line_height = round(hook_font_px * 1.18)
    width = max(place_overlay.width, max(text_widths) + inset * 2)
    hook_height = line_height * len(hook_lines)
    height = place_overlay.height + gap + hook_height
    overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))

    place_x = inset - round(place_font_px * 0.6) if align == "left" else (width - place_overlay.width) // 2
    if order == "place-first":
        place_top = 0
        hook_top = place_overlay.height + gap
    else:
        hook_top = 0
        place_top = hook_height + gap
    overlay.alpha_composite(place_overlay, (place_x, place_top))
    draw = ImageDraw.Draw(overlay)
    y = hook_top
    stroke = max(2, round(hook_font_px * 0.035))
    for line, box, text_width in zip(hook_lines, boxes, text_widths):
        x = inset if align == "left" else (width - text_width) // 2
        draw.text(
            (x - box[0], y - box[1]),
            line,
            font=hook_font,
            fill=(255, 255, 255, 255),
            stroke_width=stroke,
            stroke_fill=(0, 0, 0, 210),
        )
        y += line_height
    return overlay


def render_byline_overlay(font_px: int) -> Image.Image:
    """썸네일과 같은 Bradley Hand Bold + 로즈핑크 서명을 영상용으로 렌더링한다."""
    font = ImageFont.truetype(BYLINE_FONT, font_px, index=BYLINE_INDEX)
    text = BYLINE_TEXT[:-1].rstrip() if BYLINE_TEXT.endswith("🌹") else BYLINE_TEXT
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    tb = probe.textbbox((0, 0), text, font=font)
    text_w, text_h = tb[2] - tb[0], tb[3] - tb[1]
    rose = render_brand_emoji("🌹", round(font_px * 0.9))
    gap = round(font_px * 0.28)
    stroke = max(1, round(font_px * 0.025))
    pad = max(3, stroke * 2)
    width = text_w + gap + rose.width + pad * 2
    height = max(text_h, rose.height) + pad * 2
    overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    text_y = pad + (max(text_h, rose.height) - text_h) // 2
    draw.text(
        (pad - tb[0], text_y - tb[1]),
        text,
        font=font,
        fill=ROSE_ACCENT,
        stroke_width=stroke,
        stroke_fill=(0, 0, 0, 190),
    )
    overlay.alpha_composite(
        rose,
        (pad + text_w + gap, pad + (max(text_h, rose.height) - rose.height) // 2),
    )
    return overlay


def append_byline(
    content: Image.Image,
    byline: Image.Image,
    gap_px: int,
    align: str,
) -> Image.Image:
    content_bbox = content.getbbox()
    if content_bbox is None:
        raise ValueError("서명을 붙일 콘텐츠가 비어 있습니다")
    width = max(content.width, content_bbox[0] + byline.width)
    height = content.height + gap_px + byline.height
    overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    overlay.alpha_composite(content, (0, 0))
    byline_x = content_bbox[0] if align == "left" else (width - byline.width) // 2
    overlay.alpha_composite(byline, (byline_x, content.height + gap_px))
    return overlay


def render_hook_only_overlay(
    place: str,
    hook_lines: list[str],
    place_font_px: int,
    hook_font_px: int,
    align: str,
    font_path: str | None = None,
    pin_scale: float = DEFAULT_PIN_SCALE,
) -> Image.Image:
    """기존 훅 글꼴·행간을 유지한 채 장소 핀과 서명을 제외한 훅만 렌더링한다."""
    place_overlay = render_overlay(place, place_font_px, font_path, pin_scale)
    combined = render_hook_overlay(
        place,
        hook_lines,
        place_font_px,
        hook_font_px,
        align,
        font_path,
        pin_scale,
    )
    hook_top = place_overlay.height + round(hook_font_px * 0.1) - max(
        2, round(hook_font_px * 0.035))
    return combined.crop((0, hook_top, combined.width, combined.height))


def render_tape_background(width, height):
    """고정된 미세 결과 비대칭 찢김. 글씨 영역의 불투명도는 유지한다."""
    rng = random.Random(23010)
    edge = max(3, round(height*.28))
    step = max(2, round(height*.035))
    top = [(x, round(height*(.035+.03*math.sin(x/width*11))+rng.uniform(0, height*.035)))
           for x in range(edge, width-edge, step)]
    right = [(width-1-round(edge*(.35+.25*math.sin(y/height*8))+rng.uniform(0, edge*.4)), y)
             for y in range(step, height-step, step)]
    bottom = [(x, height-1-round(height*(.035+.03*math.sin(x/width*15))+rng.uniform(0, height*.035)))
              for x in range(width-edge-1, edge-1, -step)]
    left = [(round(edge*(.3+.23*math.sin(y/height*13))+rng.uniform(0, edge*.5)), y)
            for y in range(height-step-1, step-1, -step)]
    outline = top+right+bottom+left
    mask = Image.new("L", (width, height))
    ImageDraw.Draw(mask).polygon(outline, fill=255)
    im = Image.new("RGBA", (width, height), (18, 18, 17, 255))
    draw = ImageDraw.Draw(im)
    for _ in range(width*height//5):
        x, y = rng.randrange(width), rng.randrange(height)
        tone = rng.randrange(15, 25)
        draw.point((x, y), fill=(tone, tone, tone-1, 255))
    # 일부 찢긴 가장자리만 밝게 남겨, 균일한 테두리 대신 종이 단면을 표현한다.
    for a, b in zip(outline, outline[1:]+outline[:1]):
        if rng.random() < .65:
            tone = rng.randrange(75, 145)
            draw.line([a, b], fill=(tone, tone-3, tone-8, 255), width=max(1, height//35))
    im.putalpha(mask)
    return im
