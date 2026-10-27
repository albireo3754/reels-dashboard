"""표지 훅·서명과 장소 핀 구성. 영상 기능과 독립적이다."""
import glob
from PIL import (
    Image,
    ImageDraw,
    ImageFilter,
    ImageFont,
)
from reels_editor.entities.overlay import (
    AUTO_HOOK_MAX,
    AUTO_HOOK_MIN,
    AUTO_HOOK_WIDTH,
    KR_FONT,
    KR_BOLD,
    BYLINE_TEXT,
    BYLINE_FONT,
    BYLINE_INDEX,
    BYLINE_RATIO,
    HOOK_RATIO,
    ROSE_ACCENT,
    render_brand_emoji as render_emoji,
    DEFAULT_THUMBNAIL,
    THUMBNAIL_STYLES,
    ThumbnailStyle,
)
from reels_editor.entities.overlay import render_overlay, render_byline_overlay, resolve_place_font
from reels_editor.entities.overlay import (
    visible_left,
    visible_top,
    default_pin_top,
    move_layer,
    layer_record,
    fit_to_instagram_safe_zone,
    OverlayLayer,
    OverlayGroup,
    place_glyph,
    move_groups,
)

BADGE_BG = (122, 31, 61, 235)

def latin_font(px: int) -> ImageFont.FreeTypeFont:
    hits = sorted(glob.glob(
        "/System/Library/AssetsV2/com_apple_MobileAsset_Font7/*/AssetData/"
        "ToppanBunkyuMidashiMinchoStdN-ExtraBold.otf"))
    if hits:
        return ImageFont.truetype(hits[0], px)
    return ImageFont.truetype(KR_FONT, px, index=KR_BOLD)

def make_mark(height: int = 96) -> Image.Image:
    """🌹 rosy.trip 필(pill) 배지. 스탠드얼론 PNG로도 저장해 재사용."""
    pad_x = round(height * 0.42)
    gap = round(height * 0.22)
    rose = render_emoji("🌹", round(height * 0.62))
    font = latin_font(round(height * 0.42))
    text = "rosy.trip"
    tw = round(ImageDraw.Draw(Image.new("RGB", (1, 1))).textlength(text, font=font))
    w = pad_x + rose.width + gap + tw + pad_x
    badge = Image.new("RGBA", (w, height), (0, 0, 0, 0))
    d = ImageDraw.Draw(badge)
    d.rounded_rectangle([0, 0, w - 1, height - 1], radius=height // 2, fill=BADGE_BG)
    badge.alpha_composite(rose, (pad_x, (height - rose.height) // 2))
    ty = (height - (font.getbbox(text)[3] + font.getbbox(text)[1])) // 2
    d.text((pad_x + rose.width + gap, ty), text, font=font, fill=(255, 250, 246, 255))
    return badge

def render_hook_line(line, font, width, style):
    """측정과 실제 출력에서 같은 획·그림자 렌더링을 사용한다."""
    scale = width/style.reference_width
    probe = ImageDraw.Draw(Image.new('RGBA', (1, 1)))
    padding = round(30*scale)+10
    box = probe.textbbox((0, 0), line, font=font, stroke_width=round(style.stroke*scale))
    glyph = Image.new('RGBA', (box[2]-box[0]+2*padding, box[3]-box[1]+2*padding))
    origin = (padding-box[0], padding-box[1])
    ImageDraw.Draw(glyph).text(
        (origin[0]+round(style.shadow_x*scale), origin[1]+round(style.shadow_y*scale)),
        line, font=font, fill=(0, 0, 0, 140), stroke_width=round(style.stroke*scale))
    glyph = glyph.filter(ImageFilter.GaussianBlur(style.shadow_blur*scale))
    ImageDraw.Draw(glyph).text(origin, line, font=font, fill='white',
        stroke_width=round(style.stroke*scale), stroke_fill='white')
    return glyph, origin


def resolve_thumbnail_hook_size(lines, width, style, explicit_size=None, *, automatic=False):
    """긴 줄의 실제 표시 폭으로 두 줄에 쓸 하나의 크기를 정한다."""
    limit = int(width*AUTO_HOOK_WIDTH)
    scale = width/style.reference_width

    def measured(size):
        font = ImageFont.truetype(KR_FONT, max(1, round(size*scale)), index=KR_BOLD)
        widths = []
        for line in lines:
            # 길이가 극단적인 입력은 큰 임시 이미지를 만들기 전에 거른다.
            box = font.getbbox(line, stroke_width=round(style.stroke*scale))
            if box[2]-box[0] > limit:
                return box[2]-box[0]
            glyph, _ = render_hook_line(line, font, width, style)
            box = glyph.getbbox()
            widths.append(box[2]-box[0])
        return max(widths)

    if explicit_size is not None or not automatic:
        size = explicit_size if explicit_size is not None else style.hook_size
        return size, {'mode': 'fixed', 'requested_size_at_2160': size}
    if measured(AUTO_HOOK_MIN) > limit:
        raise ValueError(f'훅이 자동 크기 하한 {AUTO_HOOK_MIN}px에서도 폭 {AUTO_HOOK_WIDTH:.0%}를 넘습니다. 문구·줄바꿈을 조정하거나 --hook-size를 명시하세요')
    low, high = AUTO_HOOK_MIN, AUTO_HOOK_MAX
    while low < high:
        middle = (low+high+1)//2
        if measured(middle) <= limit:
            low = middle
        else:
            high = middle-1
    return low, {'mode': 'auto-width', 'version': 1,
                 'min_size_at_2160': AUTO_HOOK_MIN, 'max_size_at_2160': AUTO_HOOK_MAX,
                 'width_ratio': AUTO_HOOK_WIDTH, 'width_limit_px': limit,
                 'measured_width_px': measured(low)}

def render_thumbnail_groups(img: Image.Image, hook_lines: list[str], place: str,
                   hook_size: int, keep_existing_pin: bool,
                   style: ThumbnailStyle = THUMBNAIL_STYLES[DEFAULT_THUMBNAIL],
                   *, align='left', x=None, y=None, place_x=None, place_y=None,
                   offset_x=0, offset_y=0, place_offset_x=0, place_offset_y=0,
                   hook_offset_x=0, hook_offset_y=0) -> list[OverlayGroup]:
    w, h = img.size
    scale = w / style.reference_width
    font = ImageFont.truetype(KR_FONT, round(hook_size * scale), index=KR_BOLD)
    anchor_x = x if x is not None else (.5 if align == 'center' else style.left)
    line_height = round(style.line_height * scale)
    hook = Image.new('RGBA', img.size)
    for i, line in enumerate(hook_lines):
        glyph, origin = render_hook_line(line, font, w, style)
        left = visible_left(glyph, w, anchor_x, align)
        top = round(h*style.top)+i*line_height-origin[1]
        fit_to_instagram_safe_zone(glyph, w, h, left, top, '썸네일 훅')
        hook.alpha_composite(glyph, (left, top))
    signature = Image.new('RGBA', img.size)
    glyph = render_byline_overlay(round(style.signature_size*scale))
    left, top, _ = fit_to_instagram_safe_zone(glyph, w, h,
        visible_left(glyph, w, anchor_x, align), round(h*style.signature_y), '서명')
    signature.alpha_composite(glyph, (left, top))
    # Explicit y is the hook's visible centre; the signature moves with the hook.
    dy = round(h*y-(hook.getbbox()[1]+hook.getbbox()[3])/2)/h if y is not None else 0
    groups = [OverlayGroup('hook-signature', 'hook', [
        OverlayLayer('hook', move_layer(hook, 0, dy, '썸네일 훅')),
        OverlayLayer('signature', move_layer(signature, 0, dy, '서명'))])]
    if not keep_existing_pin:
        glyph = render_overlay(place, round(w*style.place_ratio), resolve_place_font(place, None))
        top = default_pin_top(glyph, h, style.place_y) if place_y is None else visible_top(glyph, h, place_y)
        pin = place_glyph(glyph, w, h, .5 if place_x is None else place_x, top=top, label='장소 핀')
        groups.append(OverlayGroup('place-guide', 'pin', [OverlayLayer('pin', pin)]))
    return move_groups(groups, offset_x=offset_x, offset_y=offset_y,
        place_offset_x=place_offset_x, place_offset_y=place_offset_y,
        hook_offset_x=hook_offset_x, hook_offset_y=hook_offset_y)

def draw_shimbashi(img, *args, **kwargs):
    groups = render_thumbnail_groups(img, *args, **kwargs)
    for group in groups:
        img.alpha_composite(group.composite())
    return {layer.name: layer_record(layer.image) for group in groups for layer in group.layers}

def draw_hook(img: Image.Image, hook_lines: list[str], sub: str, *, hook_ratio=HOOK_RATIO) -> None:
    w, h = img.size
    # 하단 가독성 그라데이션
    grad = Image.new("L", (1, h), 0)
    for y in range(h):
        p = max(0.0, (y / h - 0.55) / 0.45)
        grad.putpixel((0, y), round(150 * p))
    black = Image.new("RGBA", (w, h), (10, 8, 14, 255))
    img.alpha_composite(Image.composite(black, Image.new("RGBA", (w, h), (0, 0, 0, 0)),
                                        grad.resize((w, h))))

    d = ImageDraw.Draw(img)
    margin = round(w * 0.055)
    hook_px = round(w * hook_ratio)
    hook_font = ImageFont.truetype(KR_FONT, hook_px, index=KR_BOLD)
    sub_font = ImageFont.truetype(KR_FONT, round(w * 0.034), index=2)
    line_h = round(hook_px * 1.28)
    y = round(h * 0.80) - line_h * len(hook_lines)
    for line in hook_lines:
        d.text((margin, y), line, font=hook_font, fill=(255, 255, 255, 255),
               stroke_width=max(1, round(hook_px * 0.018)),
               stroke_fill=(255, 255, 255, 255))
        y += line_h
    y += round(hook_px * 0.15)
    if sub:
        d.text((margin, y), sub, font=sub_font, fill=(235, 231, 228, 235))
        y += round(w * 0.034 * 1.9)
    by_px = round(w * BYLINE_RATIO)
    if BYLINE_FONT:
        by_font = ImageFont.truetype(BYLINE_FONT, by_px, index=BYLINE_INDEX)
    else:
        by_font = latin_font(by_px)
    text = BYLINE_TEXT
    rose_suffix = text.endswith("🌹")
    if rose_suffix:
        text = text[:-1].rstrip()
    bx = margin + round(w * 0.005)
    d.text((bx, y), text, font=by_font, fill=ROSE_ACCENT)
    if rose_suffix:
        rose = render_emoji("🌹", round(by_px * 0.9))
        tw = round(d.textlength(text, font=by_font))
        # 텍스트 실제 글리프 영역의 세로 중앙에 장미 중심을 맞춘다
        tb = d.textbbox((bx, y), text, font=by_font)
        cy = (tb[1] + tb[3]) // 2
        img.alpha_composite(rose, (bx + tw + round(by_px * 0.28),
                                   cy - rose.height // 2))
