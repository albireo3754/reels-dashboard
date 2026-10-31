import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from PIL import Image, ImageChops

from check_reels_architecture import audit
from editor_cli import video_arguments, cover_arguments
from reels_editor.shared.timing import enable_at

ROOT = Path(__file__).resolve().parent


class TimingTests(unittest.TestCase):
    def test_caption_cues_are_half_open_at_microsecond_boundaries(self):
        first = 'gte(round(t*1000000),0)*lt(round(t*1000000),500000)'
        second = 'gte(round(t*1000000),500000)*lt(round(t*1000000),1000000)'
        self.assertTrue(enable_at(first, .4999994))
        self.assertFalse(enable_at(first, .4999996))
        self.assertTrue(enable_at(second, .4999996))
        self.assertTrue(enable_at(second, .5))
        self.assertFalse(enable_at(second, 1))

    def test_generated_description_intervals_and_persistent_layers(self):
        self.assertTrue(enable_at(None, 123))
        self.assertTrue(enable_at('between(t,0,0.4)+gte(t,1)', .4))
        self.assertFalse(enable_at('between(t,0,0.4)+gte(t,1)', .5))
        self.assertTrue(enable_at('between(t,0,0.4)+gte(t,1)', 1.1))
        self.assertTrue(enable_at('gte(t,1e+06)', 1000000))
        with self.assertRaises(ValueError):
            enable_at('__import__("os").system("false")', 0)

    def test_fsd_boundaries(self):
        self.assertEqual(audit(), [])

    def test_vendored_source_changes_are_explicit(self):
        inventory = json.loads((ROOT / 'source-inventory.json').read_text())
        modified = {'reels_editor/features/video_overlay/cli.py', 'reels_editor/shared/media.py'}
        for item in inventory['files']:
            if item['path'] not in modified:
                self.assertEqual(hashlib.sha256((ROOT / item['path']).read_bytes()).hexdigest(), item['sourceSha256'], item['path'])


class EngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='reels-editor-test-')
        cls.root = Path(cls.temporary.name).resolve()
        cls.source = cls.root / 'source.mp4'
        cls.ffmpeg = os.environ.get('FFMPEG_TEST_BIN', 'ffmpeg')
        subprocess.run([cls.ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=720x1280:r=30:d=1.2',
                        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.2', '-c:v', 'libx264',
                        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', str(cls.source)], check=True)
        cls.request = {
            'sourcePath': str(cls.source),
            'place': {'name': '서울', 'description': '함께 걷는 길', 'material': 'tape', 'x': .5, 'y': .24,
                      'size': .042, 'persistent': True, 'showDuring': '0-0.4', 'useDefaultPosition': True},
            'captions': {'fontSizeRatio': .045, 'y': .65, 'items': [
                {'id': 'a', 'start': 0, 'end': .5, 'text': '첫 번째 장면이에요'},
                {'id': 'b', 'start': .5, 'end': 1, 'text': '다음 장면을 봐요'}]},
            'cover': {'time': .2, 'hook': '함께 걷는\n가을 산책', 'template': 'rosy-auto', 'x': .07, 'y': .60,
                      'placeX': .5, 'placeY': .21, 'useDefaultPosition': True},
        }
        cls.request_file = cls.root / 'request.json'
        cls.request_file.write_text(json.dumps(cls.request, ensure_ascii=False))

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def call(self, *args, ok=True):
        runtime = os.environ.get('EDITOR_RUNTIME')
        command = [runtime] if runtime else [sys.executable, str(ROOT / 'editor_cli.py')]
        env = dict(os.environ)
        if runtime: env['PATH'] = '/usr/bin:/bin'
        result = subprocess.run([*command, *map(str, args)], capture_output=True, text=True, env=env)
        if ok: self.assertEqual(result.returncode, 0, result.stderr[-3000:])
        else: self.assertNotEqual(result.returncode, 0)
        return result

    def test_signed_follow_card_is_separate_from_place_and_preserves_custom_settings(self):
        request = copy.deepcopy(self.request)
        request['place']['name'] = ''
        request['cover'].update(template='rosy-follow', hook='여행 전에 알아둘 정보를\n더 보고 싶다면',
                                followCta='팔로우해 주세요!', followSignature='@travel_notes 🌹', followDarkness=.4)
        config = self.root / 'follow.json'
        config.write_text(json.dumps(request, ensure_ascii=False))
        output = self.root / 'follow.png'
        self.call('cover', config, output)
        with Image.open(output) as image:
            self.assertEqual(image.size, (1080, 1920))
        manifest = json.loads(output.with_suffix('.style.json').read_text())
        self.assertEqual(manifest['template'], 'rosy-follow')
        self.assertFalse(manifest['placeGuide'])
        self.assertEqual(manifest['sourceTime'], .2)
        self.assertEqual(manifest['signature']['text'], '@travel_notes 🌹')
        self.assertEqual(manifest['layers'][-1]['text'], '팔로우해 주세요!')
        self.assertEqual(manifest['followDarkness'], .4)
        first = Image.open(output).copy()
        request['cover']['followSignature'] = '@another_account'
        config.write_text(json.dumps(request, ensure_ascii=False))
        second = self.root / 'follow-other.png'
        self.call('cover', config, second)
        with Image.open(second) as image:
            self.assertIsNotNone(ImageChops.difference(first, image).getbbox())
        request['cover']['hookOffsetY'] = .9
        config.write_text(json.dumps(request, ensure_ascii=False))
        invalid = self.root / 'follow-invalid.png'
        self.call('cover', config, invalid, ok=False)
        self.assertFalse(invalid.exists())

    def test_probe_and_browser_proxy(self):
        metadata = json.loads(self.call('probe', self.source).stdout)
        self.assertEqual((metadata['width'], metadata['height']), (720, 1280))
        self.assertTrue(metadata['hasAudio'])
        self.assertFalse(metadata['hdr'])
        output = self.root / 'proxy.mp4'
        result = json.loads(self.call('proxy', self.source, output).stdout)
        self.assertEqual(result['outputPath'], str(output))
        proxy = json.loads(self.call('probe', output).stdout)
        self.assertEqual(proxy['height'], 1080)
        self.assertTrue(proxy['hasAudio'])

    def test_default_and_manual_positions_are_distinct(self):
        with tempfile.TemporaryDirectory() as tmp:
            default = video_arguments(self.request, self.root / 'unused.mp4', Path(tmp))
            self.assertNotIn('--place-x', default)
            request = copy.deepcopy(self.request)
            request['place']['useDefaultPosition'] = False
            self.assertIn('--place-x', video_arguments(request, self.root / 'unused.mp4', Path(tmp)))
            request['place']['material'] = 'none'
            self.assertNotIn('--show-during', video_arguments(request, self.root / 'unused.mp4', Path(tmp)))
        self.assertNotIn('--x', cover_arguments(self.request, self.root / 'unused.png'))

    def test_template_adjustments_reach_preview_cover_and_render(self):
        request = copy.deepcopy(self.request)
        request['place']['offsetX'] = .02
        request['place']['offsetY'] = .02
        request['cover'].update(hookOffsetY=-.02, placeOffsetX=.01, hookSize=165)
        file = self.root / 'adjustments.json'
        for material in ('none', 'tape', 'rectangle'):
            request['place']['material'] = material
            file.write_text(json.dumps(request))
            output = self.root / f'adjusted-{material}.png'
            self.call('preview', file, output, '--time', .2)
            manifest = json.loads(output.with_suffix('.style.json').read_text())
            self.assertEqual(manifest['requested']['place_offset_x'], .02)
            self.assertEqual(manifest['requested']['place_offset_y'], .02)
            self.assertEqual(manifest['requested']['offset_y'], 0)
            groups = {g['name']: g for g in manifest['groups']}
            self.assertIn('body-captions', groups)
            if material == 'tape':
                # Export must resolve exactly the same placement as preview.
                video = self.root / 'adjusted-export.mp4'
                self.call('render', file, video)
                rendered = json.loads(video.with_suffix('.style.json').read_text())
                self.assertEqual(rendered['groups'], manifest['groups'])
        for template in ('rosy-auto', 'rosy-large'):
            request['cover']['template'] = template
            file.write_text(json.dumps(request))
            output = self.root / f'adjusted-{template}.png'
            self.call('cover', file, output)
            manifest = json.loads(output.with_suffix('.style.json').read_text())
            self.assertEqual(manifest['hook_size_at_2160'], 165)
            self.assertEqual(manifest['alignment'], 'left')
            self.assertEqual(manifest['requested']['hook_offset_y'], -.02)
            self.assertEqual(manifest['requested']['place_offset_x'], .01)
            self.assertEqual(manifest['requested']['place_offset_y'], 0)
        request['place']['offsetX'] = 2
        with self.assertRaises(ValueError):
            video_arguments(request, self.root / 'bad.mp4', self.root)

    def test_preview_respects_cue_and_description_times(self):
        early = self.root / 'early.png'; boundary = self.root / 'boundary.png'; late = self.root / 'late.png'
        for output, time in [(early, .2), (boundary, .5), (late, 1.1)]:
            result = json.loads(self.call('preview', self.request_file, output, '--time', time).stdout)
            self.assertEqual(result['outputPath'], str(output))
        manifest = json.loads(early.with_suffix('.style.json').read_text())
        groups = {g['name']: g for g in manifest['groups']}
        pin = next(e for e in groups['place-guide']['elements'] if e['name'] == 'pin')['bbox']
        description = next(e for e in groups['place-guide']['elements'] if e['name'] == 'description')['bbox']
        with Image.open(early).convert('RGB') as a, Image.open(boundary).convert('RGB') as b, Image.open(late).convert('RGB') as c:
            self.assertIsNone(ImageChops.difference(a.crop(pin), c.crop(pin)).getbbox())
            self.assertGreater(max(a.crop(description).getextrema()[0]), 100)
            self.assertEqual(c.crop(description).getextrema(), ((0, 0), (0, 0), (0, 0)))
            caption_region = (0, 700, 720, 1000)
            self.assertIsNotNone(ImageChops.difference(a.crop(caption_region), b.crop(caption_region)).getbbox())
            self.assertEqual(c.crop(caption_region).getextrema(), ((0, 0), (0, 0), (0, 0)))

    def test_real_render_cover_progress_and_audio(self):
        video = self.root / 'rendered.mp4'; cover = self.root / 'cover.png'
        events = [json.loads(line) for line in self.call('render', self.request_file, video).stdout.splitlines()]
        self.assertEqual(events[-1]['type'], 'result')
        self.assertTrue(any(e.get('type') == 'progress' and e['percent'] == 100 for e in events))
        self.assertTrue(json.loads(self.call('probe', video).stdout)['hasAudio'])
        self.call('cover', self.request_file, cover)
        manifest = json.loads(cover.with_suffix('.style.json').read_text())
        self.assertEqual(manifest['template'], 'rosy-auto')
        self.assertEqual(manifest['alignment'], 'left')
        with Image.open(cover) as image: self.assertEqual(image.size, (720, 1280))

    def test_preview_uses_requested_source_frame(self):
        source = self.root / 'two-colors.mp4'
        subprocess.run([self.ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', 'color=red:s=720x1280:r=10:d=0.6',
                        '-f', 'lavfi', '-i', 'color=blue:s=720x1280:r=10:d=0.6',
                        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264',
                        '-pix_fmt', 'yuv420p', str(source)], check=True)
        request = copy.deepcopy(self.request); request['sourcePath'] = str(source)
        file = self.root / 'two-colors.json'; file.write_text(json.dumps(request))
        pixels = []
        for index, time in enumerate((.1, .8)):
            preview = self.root / f'frame-{index}.png'
            self.call('preview', file, preview, '--time', time)
            with Image.open(preview).convert('RGB') as image: pixels.append(image.getpixel((5, 5)))
        self.assertGreater(pixels[0][0], 200); self.assertLess(pixels[0][2], 50)
        self.assertGreater(pixels[1][2], 200); self.assertLess(pixels[1][0], 50)

    def test_rejects_invalid_times_and_source_overwrite(self):
        self.call('preview', self.request_file, self.root / 'bad.png', '--time', 2, ok=False)
        self.call('render', self.request_file, self.source, ok=False)
        request = copy.deepcopy(self.request)
        request['captions']['items'][1]['start'] = .4
        file = self.root / 'invalid.json'; file.write_text(json.dumps(request))
        self.call('render', file, self.root / 'bad.mp4', ok=False)

    @unittest.skipUnless(os.environ.get('EDITOR_TEST_HDR') == '1', 'Enable after building the zscale runtime')
    def test_hdr_proxy_is_sdr_while_export_retains_hdr(self):
        source = self.root / 'hdr.mp4'
        subprocess.run([self.ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', 'color=gray:s=720x1280:r=30:d=0.8',
                        '-c:v', 'libx265', '-x265-params', 'log-level=error:colorprim=9:transfer=18:colormatrix=9', '-pix_fmt', 'yuv420p10le',
                        '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
                        '-color_range', 'tv', '-tag:v', 'hvc1', str(source)], check=True)
        original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        self.assertTrue(json.loads(self.call('probe', source).stdout)['hdr'])
        proxy = self.root / 'hdr-proxy.mp4'
        response = json.loads(self.call('proxy', source, proxy).stdout)
        self.assertTrue(response['hdrToSDR'])
        self.assertFalse(json.loads(self.call('probe', proxy).stdout)['hdr'])
        request = copy.deepcopy(self.request)
        request['sourcePath'] = str(source)
        request['captions']['items'] = []
        file = self.root / 'hdr-request.json'; file.write_text(json.dumps(request))
        export = self.root / 'hdr-export.mp4'
        self.call('render', file, export)
        metadata = json.loads(self.call('probe', export).stdout)
        self.assertTrue(metadata['hdr'])
        self.assertIn('10', metadata['pixelFormat'])
        self.assertEqual(metadata['colorTransfer'], 'arib-std-b67')
        self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), original_hash)


if __name__ == '__main__':
    unittest.main()
