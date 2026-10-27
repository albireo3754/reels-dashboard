"""영상·썸네일의 공통 글꼴·색상과 템플릿 기본값 정본."""

from dataclasses import dataclass
from pathlib import Path
import glob
import hashlib

from PIL import ImageFont

KR_FONT = "/System/Library/Fonts/AppleSDGothicNeo.ttc"
KR_BOLD = 6
KR_FILM_FONT = "/System/Library/Fonts/Supplemental/AppleMyungjo.ttf"
KR_PLACE_INDEX = 4
PLACE_RATIO = .042
PLACE_Y = .21
PIN_SCALE = 1.45
EMOJI_FONT = "/System/Library/Fonts/Apple Color Emoji.ttc"
BYLINE_TEXT = "@your_account 🌹"
BYLINE_FONT = "/System/Library/Fonts/Supplemental/Bradley Hand Bold.ttf"
BYLINE_INDEX = 0
BYLINE_RATIO = 0.038
HOOK_RATIO = 0.082
ROSE_ACCENT = (255, 170, 190, 255)


@dataclass(frozen=True)
class PinBannerStyle:
    version: int = 2
    font_ratio: float = .032
    tape_font_ratio: float = .036
    tape_padding_x_ratio: float = .024
    tape_padding_y_ratio: float = .012
    tape_tracking_ratio: float = .001
    tape_max_width_ratio: float = .76
    max_width_ratio: float = .72
    padding_x_ratio: float = .016
    padding_y_ratio: float = .008
    pin_gap_ratio: float = .012
    note_font_ratio: float = .026
    note_gap_ratio: float = .008


PIN_BANNER_STYLE = PinBannerStyle()

JP_FONT_NAME = 'ToppanBunkyuMidashiMinchoStdN-ExtraBold.otf'
JP_FONT_SHA256 = 'ba6ec116cc0bcca7faaf1f10f3b3fa2908c87ae683d04cede06a13ff252f6335'
JP_FONT_CACHE = Path.home() / 'Library/Caches/rosy-reels/fonts' / JP_FONT_NAME
DEFAULT_THUMBNAIL = 'rosy-auto'
AUTO_HOOK_MAX = 185
AUTO_HOOK_MIN = 132
AUTO_HOOK_WIDTH = .80


@dataclass(frozen=True)
class ThumbnailStyle:
    hook_size: int
    version: int = 1
    reference_width: int = 2160
    left: float = .07
    top: float = .60
    line_height: float = 177 * 1.28
    stroke: int = 3
    shadow_x: int = 4
    shadow_y: int = 6
    shadow_blur: int = 6
    signature_size: int = 82
    signature_y: float = .74
    place_ratio: float = PLACE_RATIO
    place_y: float = PLACE_Y


# 새 표지는 폭 자동 조절, 과거 고정 템플릿 값은 재현용으로 보존한다.
THUMBNAIL_STYLES = {
    'rosy-auto': ThumbnailStyle(hook_size=AUTO_HOOK_MAX),
    'rosy-standard': ThumbnailStyle(hook_size=165, version=2),
    'rosy-large': ThumbnailStyle(hook_size=185),
    'shimbashi': ThumbnailStyle(hook_size=165),
}


def resolve_japanese_font() -> tuple[str, int]:
    candidates = [JP_FONT_CACHE, *map(Path, sorted(glob.glob(
        '/System/Library/AssetsV2/com_apple_MobileAsset_Font7/*/AssetData/' + JP_FONT_NAME
    )))]
    for path in candidates:
        if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() == JP_FONT_SHA256:
            return str(path), 0
    raise RuntimeError(
        '기존 일본어 명조체가 없습니다. 다른 글꼴로 대체하지 않습니다. '
        'uv run --with pillow python scripts/setup_reels_fonts.py를 실행하세요.'
    )


def font_record(path: str, index: int, size: int) -> dict:
    font = ImageFont.truetype(path, size, index=index)
    return {'path': path, 'index': index, 'size': size,
            'family': list(font.getname()),
            'sha256': hashlib.sha256(Path(path).read_bytes()).hexdigest()}


@dataclass(frozen=True)
class OverlayTemplate:
    align: str
    x: float
    y: float
    hook_size: float
    place_x: float | None = None
    place_y: float | None = None
    order: str = "place-first"
    include_byline: bool = True


OVERLAY_TEMPLATES = {
    "shimbashi-pin-only": OverlayTemplate(
        align="center", x=0.5, y=PLACE_Y, hook_size=HOOK_RATIO,
        include_byline=False,
    ),
    "shimbashi-pin-banner": OverlayTemplate(
        align="center", x=0.5, y=PLACE_Y,
        hook_size=PIN_BANNER_STYLE.font_ratio, include_byline=False,
    ),
    "food-center": OverlayTemplate(
        align="center",
        x=0.5,
        y=0.38,
        hook_size=0.072,
        place_x=0.50,
        place_y=0.22,
    ),
    "lower-left": OverlayTemplate(
        align="left",
        x=0.055,
        y=0.66,
        hook_size=HOOK_RATIO,
        place_x=0.50,
        place_y=0.22,
    ),
    "lower-left-detached": OverlayTemplate(
        align="left",
        x=0.055,
        y=0.65,
        hook_size=HOOK_RATIO,
        place_x=0.20,
        place_y=0.24,
    ),
}
