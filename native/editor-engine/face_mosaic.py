"""Deterministic, reviewed face rectangles on a new image; never modifies input."""
import math
from pathlib import Path
from PIL import Image, ImageOps, ImageDraw


def render_mosaic(request, output, preview=False):
    source = Path(request['sourcePath']).resolve(strict=True)
    output = Path(output).resolve()
    if source == output:
        raise ValueError('Output must differ from source')
    block = request.get('blockSize', 18)
    if isinstance(block, bool) or not isinstance(block, int) or not 4 <= block <= 100:
        raise ValueError('blockSize must be an integer between 4 and 100')
    regions = request['regions']
    if not isinstance(regions, list) or len(regions) > 100:
        raise ValueError('Invalid regions')
    with Image.open(source) as original:
        image = ImageOps.exif_transpose(original).convert('RGB')
    width, height = image.size
    boxes = []
    for region in regions:
        values = [region[k] for k in ('x', 'y', 'width', 'height')]
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
            raise ValueError('Invalid region coordinates')
        x, y, w, h = values
        if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > 1 or y + h > 1:
            raise ValueError('Region must fit inside image')
        box = (math.floor(x * width), math.floor(y * height), math.ceil((x + w) * width), math.ceil((y + h) * height))
        boxes.append(box)
        if not preview:
            patch = image.crop(box)
            pw, ph = patch.size
            patch = patch.resize((max(1, pw // block), max(1, ph // block)), Image.Resampling.BOX)
            image.paste(patch.resize((pw, ph), Image.Resampling.NEAREST), box[:2])
    if preview:
        draw = ImageDraw.Draw(image)
        for box in boxes:
            draw.rectangle(box, outline='red', width=max(2, min(width, height) // 300))
    if output.suffix.lower() != '.png':
        raise ValueError('Output must be PNG')
    # Exclusive creation also prevents overwrite of a prior output or source symlink.
    with output.open('xb') as f:
        image.save(f, format='PNG')
    return {'outputPath': str(output), 'width': width, 'height': height, 'regions': len(boxes)}
