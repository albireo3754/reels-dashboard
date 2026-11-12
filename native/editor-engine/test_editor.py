import contextlib
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
from unittest import mock

from PIL import Image, ImageChops, ImageStat

from check_reels_architecture import audit
import editor_cli
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
        modified = {'reels_editor/features/video_overlay/cli.py', 'reels_editor/shared/media.py',
                    'reels_editor/entities/overlay/render.py', 'reels_editor/features/thumbnail/model.py',
                    'reels_editor/features/thumbnail/cli.py'}
        for item in inventory['files']:
            if item['path'] not in modified:
                self.assertEqual(hashlib.sha256((ROOT / item['path']).read_bytes()).hexdigest(), item['sourceSha256'], item['path'])


HLG_INFO = dict(width=2160, height=3840, hdr=True)
SDR_INFO = dict(width=720, height=1280, hdr=False)


class ProxyPlanTests(unittest.TestCase):
    def test_proxy_size_matches_cpu_scale_box(self):
        self.assertEqual(editor_cli.proxy_size(2160, 3840), (608, 1080))
        self.assertEqual(editor_cli.proxy_size(3840, 2160), (1080, 608))
        self.assertEqual(editor_cli.proxy_size(720, 1280), (608, 1080))
        self.assertEqual(editor_cli.proxy_size(1080, 1080), (1080, 1080))
        self.assertEqual(editor_cli.proxy_size(1001, 333), (1080, 358))

    def test_gpu_command_keeps_frames_on_videotoolbox(self):
        command, size = editor_cli.gpu_proxy_command(Path('in.mov'), Path('out.mp4'), HLG_INFO, {})
        self.assertEqual(size, (608, 1080))
        self.assertEqual(command[command.index('-hwaccel') + 1], 'videotoolbox')
        self.assertEqual(command[command.index('-hwaccel_output_format') + 1], 'videotoolbox_vld')
        self.assertEqual(command[command.index('-vf') + 1],
                         'scale_vt=w=608:h=1080:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709')
        self.assertEqual(command[command.index('-c:v') + 1], 'h264_videotoolbox')
        self.assertEqual(command[command.index('-allow_sw') + 1], '0')
        # Either option would insert a CPU scaler that cannot accept hardware frames.
        self.assertNotIn('-pix_fmt', command)
        self.assertNotIn('-colorspace', command)
        sdr, _ = editor_cli.gpu_proxy_command(Path('in.mov'), Path('out.mp4'), SDR_INFO, {})
        self.assertEqual(sdr[sdr.index('-vf') + 1], 'scale_vt=w=608:h=1080')

    def test_gpu_rotation_follows_display_matrix_and_rejects_mirrors(self):
        def stream(rotation, matrix):
            return {'side_data_list': [{'rotation': rotation, 'displaymatrix': matrix}]}
        cclock = '\n00000000:            0      -65536           0\n00000001:        65536           0           0\n00000002:            0           0  1073741824\n'
        mirrored = '\n00000000:            0       65536           0\n00000001:        65536           0           0\n00000002:            0           0  1073741824\n'
        info = dict(width=1280, height=720, hdr=False)
        for rotation, direction in ((90, 'cclock'), (-90, 'clock'), (180, 'reversal')):
            command, size = editor_cli.gpu_proxy_command(Path('a'), Path('b'), info, stream(rotation, cclock))
            self.assertEqual(command[command.index('-vf') + 1], f'transpose_vt=dir={direction},scale_vt=w=1080:h=608')
            self.assertIn('-noautorotate', command)
        self.assertIsNone(editor_cli.gpu_proxy_command(Path('a'), Path('b'), info, stream(-90, mirrored)))
        self.assertIsNone(editor_cli.gpu_proxy_command(Path('a'), Path('b'), info, stream(45, cclock)))

    def run_proxy(self, gpu_returncode=0, output_size=(608, 1080), transfer='bt709'):
        calls = []
        def run(command, **kwargs):
            calls.append(command)
            gpu = '-hwaccel' in command
            return subprocess.CompletedProcess(command, gpu_returncode if gpu else 0, '', 'boom' if gpu else '')
        def probe_video(path):
            if Path(path).name == 'out.mp4':
                return {'color_transfer': transfer}, output_size, 1.0
            return {}, (2160, 3840), 1.0
        with tempfile.TemporaryDirectory() as folder, \
                mock.patch.object(editor_cli, 'probe', return_value=dict(HLG_INFO)), \
                mock.patch.object(editor_cli, 'probe_video', side_effect=probe_video), \
                mock.patch.object(editor_cli.subprocess, 'run', side_effect=run), \
                contextlib.redirect_stderr(io.StringIO()) as stderr:
            result = editor_cli.proxy(Path(folder) / 'in.mov', Path(folder) / 'out.mp4')
        return result, calls, stderr.getvalue()

    def test_gpu_success_reports_videotoolbox_without_cpu_run(self):
        result, calls, _ = self.run_proxy()
        self.assertEqual(result['accel'], 'videotoolbox')
        self.assertTrue(result['hdrToSDR'])
        self.assertTrue(result['outputPath'].endswith('out.mp4'))
        self.assertEqual(len(calls), 1)

    def test_gpu_failure_or_wrong_output_falls_back_to_cpu_tonemap(self):
        for kwargs in (dict(gpu_returncode=1), dict(output_size=(1080, 608)), dict(transfer='arib-std-b67')):
            result, calls, stderr = self.run_proxy(**kwargs)
            self.assertEqual(result['accel'], 'cpu', kwargs)
            self.assertEqual(len(calls), 2)
            self.assertIn('-hwaccel', calls[0])
            self.assertNotIn('-hwaccel', calls[1])
            self.assertIn('tonemap=tonemap=hable', calls[1][calls[1].index('-vf') + 1])
            self.assertEqual(calls[1][calls[1].index('-allow_sw') + 1], '0')
            self.assertIn('GPU proxy unavailable', stderr)


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

    def test_local_cover_signature_reaches_pixels_and_manifest(self):
        request = copy.deepcopy(self.request)
        config = self.root / 'signature.json'
        images = []
        for index, signature in enumerate(('@your_account 🌹', '@example 🌹', '@example')):
            request['coverSignature'] = signature
            config.write_text(json.dumps(request, ensure_ascii=False))
            output = self.root / f'signature-{index}.png'
            self.call('cover', config, output)
            manifest = json.loads(output.with_suffix('.style.json').read_text())
            self.assertEqual(manifest['signature']['text'], signature)
            images.append(Image.open(output).convert('RGB'))
        self.assertIsNotNone(ImageChops.difference(images[0], images[1]).getbbox())
        self.assertIsNotNone(ImageChops.difference(images[1], images[2]).getbbox())
        request['coverSignature'] = 'invalid\nvalue'
        config.write_text(json.dumps(request))
        self.call('cover', config, self.root / 'invalid-signature.png', ok=False)

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
        self.assertEqual(result['accel'], 'videotoolbox')
        self.assertFalse(result['hdrToSDR'])
        proxy = json.loads(self.call('probe', output).stdout)
        self.assertEqual((proxy['width'], proxy['height']), (608, 1080))
        self.assertTrue(proxy['hasAudio'])

    def frame(self, video, cpu_scale=False):
        image = self.root / f'{Path(video).stem}-{int(cpu_scale)}.png'
        scale = ['-vf', 'scale=1080:1080:force_original_aspect_ratio=decrease:force_divisible_by=2'] if cpu_scale else []
        subprocess.run([self.ffmpeg, '-v', 'error', '-y', '-i', str(video), *scale, '-frames:v', '1', str(image)], check=True)
        with Image.open(image) as loaded:
            return loaded.convert('RGB')

    def test_rotated_source_uses_gpu_with_cpu_orientation(self):
        pattern = self.root / 'pattern.mp4'
        rotated = self.root / 'rotated.mp4'
        subprocess.run([self.ffmpeg, '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=30:d=0.5',
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(pattern)], check=True)
        subprocess.run([self.ffmpeg, '-v', 'error', '-y', '-display_rotation', '90', '-i', str(pattern),
                        '-c', 'copy', str(rotated)], check=True)
        output = self.root / 'rotated-proxy.mp4'
        self.assertEqual(json.loads(self.call('proxy', rotated, output).stdout)['accel'], 'videotoolbox')
        metadata = json.loads(self.call('probe', output).stdout)
        self.assertEqual((metadata['width'], metadata['height']), (1080, 608))
        expected, actual = self.frame(rotated, cpu_scale=True), self.frame(output)
        self.assertEqual(expected.size, actual.size)
        self.assertLess(max(ImageStat.Stat(ImageChops.difference(expected, actual)).mean), 8)

    def test_unsupported_hardware_decoder_falls_back_to_cpu(self):
        source = self.root / 'ffv1.mkv'
        subprocess.run([self.ffmpeg, '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=720x1280:r=30:d=0.5',
                        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.5', '-c:v', 'ffv1', '-c:a', 'aac',
                        '-shortest', str(source)], check=True)
        output = self.root / 'ffv1-proxy.mp4'
        result = self.call('proxy', source, output)
        self.assertEqual(json.loads(result.stdout)['accel'], 'cpu')
        self.assertIn('GPU proxy unavailable', result.stderr)
        metadata = json.loads(self.call('probe', output).stdout)
        self.assertEqual((metadata['width'], metadata['height']), (608, 1080))
        self.assertTrue(metadata['hasAudio'])

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
        self.assertEqual(response['accel'], 'videotoolbox')
        proxy_metadata = json.loads(self.call('probe', proxy).stdout)
        self.assertFalse(proxy_metadata['hdr'])
        self.assertEqual((proxy_metadata['colorTransfer'], proxy_metadata['colorPrimaries'], proxy_metadata['colorSpace']),
                         ('bt709', 'bt709', 'bt709'))
        # Same HLG signal in a codec VideoToolbox cannot decode exercises the CPU zscale/tonemap fallback.
        fallback_source = self.root / 'hdr-ffv1.mkv'
        subprocess.run([self.ffmpeg, '-v', 'error', '-y', '-i', str(source), '-c:v', 'ffv1', '-pix_fmt', 'yuv420p10le',
                        '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc',
                        str(fallback_source)], check=True)
        fallback = self.root / 'hdr-ffv1-proxy.mp4'
        fallback_response = json.loads(self.call('proxy', fallback_source, fallback).stdout)
        self.assertEqual((fallback_response['accel'], fallback_response['hdrToSDR']), ('cpu', True))
        fallback_metadata = json.loads(self.call('probe', fallback).stdout)
        self.assertEqual(fallback_metadata['colorTransfer'], 'bt709')
        # Both routes keep a mid-grey HLG frame near mid-grey instead of clipping or crushing it.
        for video in (proxy, fallback):
            luma = ImageStat.Stat(self.frame(video).convert('L')).mean[0]
            self.assertGreater(luma, 40, video.name)
            self.assertLess(luma, 220, video.name)
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
