import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from reels_editor.shared.hardware import videotoolbox_args, render_dolby_hardware
from reels_editor.shared.timing import enable_at, enable_intervals


class HardwarePolicyTests(unittest.TestCase):
    def test_hardware_is_required_without_software_fallback(self):
        for hdr in (False, True):
            args = videotoolbox_args(hdr)
            self.assertEqual(args[args.index('-allow_sw') + 1], '0')
            self.assertTrue(args[args.index('-c:v') + 1].endswith('_videotoolbox'))

    def test_unsupported_dolby_profile_stops_before_any_encoder(self):
        stream = {'color_transfer': 'arib-std-b67', 'side_data_list': [
            {'side_data_type': 'DOVI configuration record', 'dv_profile': 5}]}
        with patch('reels_editor.shared.hardware.probe_video', return_value=(stream, (100, 100), 1)), \
             patch('reels_editor.shared.hardware.subprocess.Popen') as launch:
            with self.assertRaisesRegex(ValueError, 'CPU fallback is disabled'):
                render_dolby_hardware(Path('source'), Path('out'), 100, 100, 1, [], 1)
            launch.assert_not_called()

    def test_missing_native_binary_does_not_silently_use_cpu(self):
        stream = {'color_transfer': 'arib-std-b67', 'side_data_list': [
            {'side_data_type': 'DOVI configuration record', 'dv_profile': 8, 'dv_bl_signal_compatibility_id': 4}]}
        with patch('reels_editor.shared.hardware.probe_video', return_value=(stream, (100, 100), 1)), \
             patch('reels_editor.shared.hardware.native_binary', return_value=Path('/nonexistent/reels-hardware-render')), \
             patch('reels_editor.shared.hardware.subprocess.Popen') as launch:
            with self.assertRaisesRegex(RuntimeError, 'CPU fallback is disabled'):
                render_dolby_hardware(Path('source'), Path('out'), 100, 100, 1, [], 1)
            launch.assert_not_called()

    def test_native_schedule_keeps_inclusive_description_and_half_open_captions(self):
        self.assertIsNone(enable_intervals(None))
        self.assertTrue(enable_at('between(t,0,0.5)', .5))
        cue = 'gte(round(t*1000000),0)*lt(round(t*1000000),500000)'
        self.assertFalse(enable_at(cue, .4999996))
        self.assertEqual(enable_intervals(cue), [dict(start=0, end=.5, inclusive=False, rounded=True)])

    @unittest.skipUnless(os.environ.get('EDITOR_TEST_DOVI_SOURCE'), 'Requires an explicitly selected real Dolby Vision input')
    def test_real_dolby_hardware_export_with_timed_overlay(self):
        runtime = Path(os.environ['EDITOR_RUNTIME'])
        ffmpeg, ffprobe = runtime.parent/'bin/ffmpeg', runtime.parent/'bin/ffprobe'
        with tempfile.TemporaryDirectory(prefix='reels-dovi-qa-') as folder:
            root = Path(folder); source = root/'source.mp4'; output = root/'output.mp4'
            subprocess.run([str(ffmpeg), '-v', 'error', '-i', os.environ['EDITOR_TEST_DOVI_SOURCE'], '-t', '1',
                            '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-tag:v', 'hvc1', '-strict', 'unofficial', str(source)], check=True)
            source_info = json.loads(subprocess.check_output([str(ffprobe), '-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', str(source)]))['streams'][0]
            self.assertTrue(any(x['side_data_type'] == 'DOVI configuration record' for x in source_info['side_data_list']))
            request = dict(sourcePath=str(source),
                place=dict(name='시험', description='테이프', material='tape', useDefaultPosition=True,
                           x=.5, y=.24, size=.042, persistent=True, showDuring='0-0.4'),
                captions=dict(fontSizeRatio=.045, y=.65, items=[dict(id='cue', start=0, end=.5, text='검증')]),
                cover={})
            config = root/'request.json'; config.write_text(json.dumps(request))
            result = subprocess.run([str(runtime), 'render', str(config), str(output)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr[-3000:])
            manifest = json.loads(output.with_suffix('.style.json').read_text())
            self.assertTrue(manifest['encoding']['hardwareRequired'])
            self.assertFalse(manifest['encoding']['softwareFallback'])
            video = json.loads(subprocess.check_output([str(ffprobe), '-v', 'error', '-show_streams', '-of', 'json', str(output)]))['streams'][0]
            dovi = next(x for x in video['side_data_list'] if x['side_data_type'] == 'DOVI configuration record')
            self.assertEqual((dovi['dv_profile'], dovi['dv_bl_signal_compatibility_id'], dovi['rpu_present_flag']), (8, 4, 1))
            self.assertEqual(video['color_transfer'], 'arib-std-b67')
            decoded = json.loads(subprocess.check_output([str(ffprobe), '-v', 'error', '-read_intervals', '%+0.05', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=side_data_list', '-of', 'json', str(output)]))
            types = {s['side_data_type'] for f in decoded['frames'] for s in f.get('side_data_list', [])}
            self.assertIn('Dolby Vision RPU Data', types)
            frames = []
            for t in (.1, .7):
                png=root/f'{t}.png'
                subprocess.run([str(ffmpeg), '-v','error','-ss',str(t),'-i',str(output),'-frames:v','1',str(png)],check=True)
                with Image.open(png) as im:
                    # The caption is in otherwise dark lower sky of the authorized fireworks test input.
                    box=manifest['layers'][-1]['bbox']
                    frames.append(sum(v > 220 for rgb in im.convert('RGB').crop(tuple(box)).getdata() for v in rgb))
            self.assertGreater(frames[0], frames[1]+100)


if __name__ == '__main__': unittest.main()
