"""표시 영역 기준 배치와 이름 있는 묶음. 글꼴/CLI/인코딩과 독립적이다."""
from dataclasses import dataclass, field
from PIL import Image
from .config import PLACE_Y

SAFE_LEFT, SAFE_RIGHT, SAFE_TOP, SAFE_BOTTOM = .04, .96, .20, .79


def visible_left(glyph, width, x=.5, align='center'):
    left, _, right, _ = glyph.getbbox()
    return round(width*x - ((left+right)/2 if align == 'center' else left))


def visible_top(glyph, height, y):
    _, top, _, bottom = glyph.getbbox()
    return round(height*y - (top+bottom)/2)


def default_pin_top(glyph, height, y=PLACE_Y):
    """기존 템플릿의 세로 배치를 보존. 명시 좌표에는 사용하지 않는다."""
    import math
    return max(round(height*y-glyph.height/2), math.ceil(height*SAFE_TOP-glyph.getbbox()[1]))


def validate_bounds(bbox, width, height, label):
    import math
    left, top, right, bottom = bbox
    if (left < math.ceil(width*SAFE_LEFT) or right > math.floor(width*SAFE_RIGHT)
            or top < math.ceil(height*SAFE_TOP) or bottom > math.floor(height*SAFE_BOTTOM)):
        raise ValueError(f'{label}이 안전영역(x 4~96%, y 20~79%)을 넘습니다: {bbox}. '
                         '좌표/오프셋 또는 문구를 조정하세요. 자동 이동·축소하지 않습니다')


def move_layer(layer, offset_x=0, offset_y=0, label='오버레이'):
    """잘리기 전에 검증하고 최종 이동량을 적용한다."""
    bbox = layer.getbbox()
    if bbox is None:
        return layer
    dx, dy = round(layer.width*offset_x), round(layer.height*offset_y)
    shifted = (bbox[0]+dx, bbox[1]+dy, bbox[2]+dx, bbox[3]+dy)
    validate_bounds(shifted, *layer.size, label)
    result = Image.new('RGBA', layer.size)
    result.alpha_composite(layer, (dx, dy))
    return result


def layer_record(layer):
    bbox = layer.getbbox()
    return {'bbox': bbox, 'center': [(bbox[0]+bbox[2])/2, (bbox[1]+bbox[3])/2] if bbox else None}


def fit_to_instagram_safe_zone(
    overlay: Image.Image,
    frame_width: int,
    frame_height: int,
    desired_left: int,
    desired_top: int,
    label: str,
) -> tuple[int, int, str | None]:
    """요청한 위치를 그대로 검증한다. 안전영역으로 자동 이동하지 않는다."""
    bbox = overlay.getbbox()
    if bbox is None:
        raise ValueError(f"{label} 오버레이가 비어 있습니다")
    validate_bounds((desired_left+bbox[0], desired_top+bbox[1],
                     desired_left+bbox[2], desired_top+bbox[3]),
                    frame_width, frame_height, label)
    return desired_left, desired_top, None



def place_glyph(glyph, width, height, x=.5, y=None, *, align='center', top=None, label='요소'):
    """하나의 표시 영역을 배치한다. 기본 높이는 호출한 템플릿이 정한다."""
    left = visible_left(glyph, width, x, align)
    if y is not None:
        top = visible_top(glyph, height, y)
    if top is None:
        raise ValueError(f'{label}: y 또는 템플릿 기본 top이 필요합니다')
    fit_to_instagram_safe_zone(glyph, width, height, left, top, label)
    layer = Image.new('RGBA', (width, height))
    layer.alpha_composite(glyph, (left, top))
    return layer


@dataclass
class OverlayLayer:
    name: str
    image: Image.Image
    enable: str | None = None

    def record(self):
        return dict(layer_record(self.image), name=self.name, enable=self.enable)


@dataclass
class OverlayGroup:
    name: str
    anchor: str
    layers: list[OverlayLayer] = field(default_factory=list)

    def composite(self):
        canvas = Image.new('RGBA', self.layers[0].image.size)
        for layer in self.layers:
            canvas.alpha_composite(layer.image)
        return canvas

    def shifted(self, x=0, y=0):
        return OverlayGroup(self.name, self.anchor, [
            OverlayLayer(layer.name, move_layer(layer.image, x, y, f'{self.name}/{layer.name}'), layer.enable)
            for layer in self.layers])

    def record(self):
        elements = [layer.record() for layer in self.layers]
        boxes = [element['bbox'] for element in elements if element['bbox']]
        bbox = (min(b[0] for b in boxes), min(b[1] for b in boxes),
                max(b[2] for b in boxes), max(b[3] for b in boxes)) if boxes else None
        return dict(bbox=bbox, center=[(bbox[0]+bbox[2])/2, (bbox[1]+bbox[3])/2] if bbox else None,
                    name=self.name, anchor=self.anchor, elements=elements)


def move_groups(groups, *, offset_x=0, offset_y=0, place_offset_x=0,
                place_offset_y=0, hook_offset_x=0, hook_offset_y=0):
    """묶음별 이동과 전체 이동을 합쳐 한 번 반올림한다. 시간 조건은 보존한다."""
    offsets = {'place-guide': (place_offset_x, place_offset_y),
               'hook-signature': (hook_offset_x, hook_offset_y)}
    return [group.shifted(offset_x+offsets.get(group.name, (0, 0))[0],
                          offset_y+offsets.get(group.name, (0, 0))[1]) for group in groups]
