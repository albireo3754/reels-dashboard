import json
import tempfile
import unittest
from pathlib import Path
from PIL import Image, ImageOps
from face_mosaic import render_mosaic

class FaceMosaicTest(unittest.TestCase):
    def test_review_preview_and_output_preserve_source(self):
        with tempfile.TemporaryDirectory() as directory:
            d = Path(directory)
            source = d / 'source.png'
            image = Image.new('RGB', (40, 40))
            image.putdata([(x * 6, y * 6, 0) for y in range(40) for x in range(40)])
            image.save(source)
            before = source.read_bytes()
            request = {'sourcePath': str(source), 'blockSize': 8, 'regions': [{'x': .25, 'y': .25, 'width': .5, 'height': .5}]}
            render_mosaic(request, d / 'preview.png', True)
            render_mosaic(request, d / 'output.png')
            self.assertEqual(source.read_bytes(), before)
            output = Image.open(d / 'output.png')
            self.assertEqual(output.getpixel((0, 0)), image.getpixel((0, 0)))
            self.assertNotEqual(output.getpixel((12, 12)), image.getpixel((12, 12)))
            self.assertEqual(Image.open(d / 'preview.png').getpixel((10, 10)), (255, 0, 0))
            with self.assertRaises(FileExistsError): render_mosaic(request, d / 'output.png')
            request['regions'][0]['width'] = 2
            with self.assertRaises(ValueError): render_mosaic(request, d / 'invalid.png')

    def test_exif_rotation_maps_normalized_region_to_displayed_orientation(self):
        with tempfile.TemporaryDirectory() as directory:
            d = Path(directory)
            source = d / 'rotated.jpg'
            image = Image.new('RGB', (60, 40))
            image.putdata([(x * 4, y * 6, (x * 11 + y * 7) % 256) for y in range(40) for x in range(60)])
            exif = Image.Exif()
            exif[274] = 6  # Display the stored image rotated 90 degrees clockwise.
            image.save(source, quality=100, subsampling=0, exif=exif)
            before = source.read_bytes()
            with Image.open(source) as original:
                oriented = ImageOps.exif_transpose(original).convert('RGB')
            self.assertEqual(oriented.size, (40, 60))
            request = {'sourcePath': str(source), 'blockSize': 8, 'regions': [{'x': 0, 'y': 0, 'width': .5, 'height': .5}]}
            render_mosaic(request, d / 'output.png')
            with Image.open(d / 'output.png') as output:
                self.assertEqual(output.size, oriented.size)
                self.assertNotEqual(output.getpixel((5, 5)), oriented.getpixel((5, 5)))
                self.assertEqual(output.getpixel((30, 45)), oriented.getpixel((30, 45)))
            self.assertEqual(source.read_bytes(), before)

if __name__ == '__main__': unittest.main()
