"""Apply reviewed face rectangles to derivative images; preserve input files."""
import json,sys
from pathlib import Path
from PIL import Image
plan=json.loads(Path(sys.argv[1]).read_text())
for item in plan['images']:
    src=Path(item['source']);dst=Path(item['output'])
    if src.resolve()==dst.resolve():raise ValueError('Source must be preserved')
    im=Image.open(src).convert('RGB')
    for box in item['boxes']:
        patch=im.crop(tuple(box));w,h=patch.size
        patch=patch.resize((max(3,w//18),max(3,h//18)),Image.Resampling.BOX).resize((w,h),Image.Resampling.NEAREST)
        im.paste(patch,(box[0],box[1]))
    im.save(dst)
    print(dst.name,len(item['boxes']))
