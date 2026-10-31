"""Signed 9:16 follow card, shared by editor previews and PNG exports."""
import json
import math
from pathlib import Path
import re

from PIL import Image, ImageDraw, ImageFont, ImageOps
from reels_editor.shared.media import extract_frame
from reels_editor.entities.overlay import (
    KR_FONT, KR_BOLD, BYLINE_FONT, BYLINE_INDEX, ROSE_ACCENT,
    render_brand_emoji,
)

WIDTH, HEIGHT = 1080, 1920
DEFAULT_CTA = '팔로우해 주세요!'
DEFAULT_SIGNATURE = '@your_account 🌹'


def bounded(value, name, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f'{name}: {minimum}~{maximum} 범위를 확인해주세요.')
    return value


def text(value, name, limit):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or '\0' in value:
        raise ValueError(f'{name} 문구를 확인해주세요.')
    return value


def signature_layer(value, size):
    rose = value.endswith(' 🌹')
    account = value[:-2] if rose else value
    font = ImageFont.truetype(BYLINE_FONT, size, index=BYLINE_INDEX)
    box = ImageDraw.Draw(Image.new('RGBA', (1, 1))).textbbox((0, 0), account, font=font)
    glyph = render_brand_emoji('🌹', round(size * .9)) if rose else None
    gap = round(size * .28) if rose else 0
    width = box[2] - box[0] + (glyph.width if glyph else 0) + gap + 8
    height = max(box[3] - box[1], glyph.height if glyph else 0) + 8
    layer = Image.new('RGBA', (width, height))
    draw = ImageDraw.Draw(layer)
    y = (height - (box[3]-box[1])) // 2 - box[1]
    draw.text((4-box[0]+1, y+2), account, font=font, fill=(0, 0, 0, 180))
    draw.text((4-box[0], y), account, font=font, fill=ROSE_ACCENT)
    if glyph:
        layer.alpha_composite(glyph, (4+box[2]-box[0]+gap, (height-glyph.height)//2))
    return layer


def render_follow_cover(request, output):
    cover = request['cover']
    hook = text(cover['hook'], '안내', 600).replace('|', '\n').split('\n')
    if len(hook) != 2 or any(not line.strip() for line in hook):
        raise ValueError('팔로우 마지막 장 안내 문구는 두 줄로 입력해주세요.')
    cta = text(cover.get('followCta', DEFAULT_CTA), '팔로우', 100)
    if '\n' in cta or '\r' in cta:
        raise ValueError('팔로우 문구는 한 줄로 입력해주세요.')
    signature = text(cover.get('followSignature', DEFAULT_SIGNATURE), '서명', 80)
    if not re.fullmatch(r'@?[A-Za-z0-9_.]{1,30}(?: 🌹)?', signature):
        raise ValueError('서명은 영문 계정명과 선택적인 🌹로 입력해주세요.')
    darkness = bounded(cover.get('followDarkness', .30), '배경 어둡기', 0, .85)
    at = bounded(cover['time'], '배경 시점', 0, 86400)
    if not isinstance(cover['useDefaultPosition'], bool):
        raise ValueError('기본 배치 옵션을 확인해주세요.')
    x = .07 if cover['useDefaultPosition'] else bounded(cover['x'], '가로 위치', 0, 1)
    y = 185/1920 if cover['useDefaultPosition'] else bounded(cover['y'], '세로 위치', 0, 1)
    x += bounded(cover.get('hookOffsetX', 0), '가로 이동', -1, 1)
    y += bounded(cover.get('hookOffsetY', 0), '세로 이동', -1, 1)
    x, y = round(x*WIDTH), round(y*HEIGHT)
    explicit = cover.get('hookSize')
    if explicit is not None:
        if isinstance(explicit, bool) or not isinstance(explicit, int):
            raise ValueError('글자 크기는 정수여야 해요.')
        bounded(explicit, '글자 크기', 1, 185)
    factor = explicit / 184 if explicit is not None else 1
    measure = ImageDraw.Draw(Image.new('RGBA', (1, 1)))

    def make_layers(factor):
        layers = []
        for value, size, top, role, color in zip(
            [*hook, cta], [70, 92, 95], [0, 125, 260],
            ['message-1', 'message-2', 'cta'], [(255,250,245,255)]*2+[ROSE_ACCENT],
        ):
            px = max(1, round(size*factor))
            font = ImageFont.truetype(KR_FONT, px, index=KR_BOLD)
            box = measure.textbbox((0, 0), value, font=font)
            layers.append(dict(text=value, font=font, fontSize=px, top=round(top*factor),
                               role=role, box=box, width=box[2]-box[0], height=box[3]-box[1], color=color))
        sig = signature_layer(signature, max(1, round(48*factor)))
        return layers, sig

    layers, sig = make_layers(factor)
    widest = max([layer['width'] for layer in layers]+[sig.width])
    available = WIDTH*.83
    if explicit is None and widest > available:
        factor *= available/widest
        if factor < .70:
            raise ValueError('마지막 장 문구가 너무 길어요. 문장을 줄여주세요.')
        layers, sig = make_layers(factor)
    all_bounds = [(x, y+l['top'], x+l['width'], y+l['top']+l['height']) for l in layers]
    sy = y + round(445*factor)
    all_bounds.append((x, sy, x+sig.width, sy+sig.height))
    if any(left < WIDTH*.03 or top < HEIGHT*.05 or right > WIDTH*.92 or bottom > HEIGHT*.88
           for left, top, right, bottom in all_bounds):
        raise ValueError('마지막 장 문구가 안전영역을 넘어요. 위치 또는 글자 크기를 조정해주세요.')
    frame = extract_frame(Path(request['sourcePath']), at)
    image = ImageOps.fit(frame, (WIDTH, HEIGHT), method=Image.Resampling.LANCZOS).convert('RGBA')
    overlay = Image.new('RGBA', image.size)
    shade = ImageDraw.Draw(overlay)
    for row in range(HEIGHT):
        extra = .06 + .12*max(0, (row-400)/(HEIGHT-400))
        shade.line((0, row, WIDTH, row), fill=(5,10,17,round(255*min(.95, darkness+extra))))
    image = Image.alpha_composite(image, overlay)
    draw = ImageDraw.Draw(image)
    for layer in layers:
        origin = (x-layer['box'][0], y+layer['top']-layer['box'][1])
        draw.text((origin[0]+1, origin[1]+3), layer['text'], font=layer['font'], fill=(0,0,0,150))
        draw.text(origin, layer['text'], font=layer['font'], fill=layer['color'])
    image.alpha_composite(sig, (x, sy))
    image.convert('RGB').save(output, 'PNG')
    manifest = dict(template='rosy-follow', templateVersion=1, outputSize=[WIDTH,HEIGHT], sourceTime=at,
                    followDarkness=darkness, alignment='left', placeGuide=False,
                    fontPath=KR_FONT, signatureFontPath=BYLINE_FONT, scale=factor,
                    layers=[dict(role=l['role'], text=l['text'], fontSize=l['fontSize'], bounds=list(b))
                            for l, b in zip(layers, all_bounds)],
                    signature=dict(text=signature, fontSize=max(1,round(48*factor)), bounds=list(all_bounds[-1])))
    Path(output).with_suffix('.style.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    return manifest
