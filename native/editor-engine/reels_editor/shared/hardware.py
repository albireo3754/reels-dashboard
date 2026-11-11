"""Hardware-only encoding policy and bundled native Dolby Vision export."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

from .media import probe_video
from .timing import enable_intervals


def videotoolbox_args(hdr=False):
    return ['-c:v', 'hevc_videotoolbox' if hdr else 'h264_videotoolbox',
            '-allow_sw', '0', '-profile:v', 'main10' if hdr else 'high',
            '-pix_fmt', 'p010le' if hdr else 'yuv420p',
            '-b:v', '80M' if hdr else '20M', *(['-tag:v', 'hvc1'] if hdr else [])]


def dolby_config(stream):
    return next((s for s in stream.get('side_data_list', [])
                 if s.get('side_data_type') == 'DOVI configuration record'), None)


def native_binary():
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).resolve().parent / 'bin/reels-hardware-render'
    return Path(__file__).resolve().parents[2] / '.build/reels-hardware-render'


def render_dolby_hardware(source, output, width, height, bitrate, layers, duration, callback=None):
    stream, _, _ = probe_video(source)
    config = dolby_config(stream)
    if not config or config.get('dv_profile') != 8 or config.get('dv_bl_signal_compatibility_id') != 4 or stream.get('color_transfer') != 'arib-std-b67':
        raise ValueError('Hardware Dolby Vision export supports Profile 8.4 HLG only. CPU fallback is disabled.')
    binary = native_binary()
    if not binary.is_file():
        raise RuntimeError('Bundled hardware renderer is missing. Rebuild the editor runtime; CPU fallback is disabled.')
    with tempfile.TemporaryDirectory(prefix='reels-hardware-') as folder:
        root = Path(folder)
        recipe = dict(source=str(source.resolve()), output=str(root/'video.mov'),
                      width=width, height=height, bitrate=bitrate, layers=[])
        for index, (image, enable) in enumerate(layers):
            png = root/f'layer-{index}.png'; image.save(png)
            recipe['layers'].append(dict(path=str(png), intervals=enable_intervals(enable)))
        request = root/'request.json'; request.write_text(json.dumps(recipe), encoding='utf8')
        process = subprocess.Popen([str(binary), str(request)], stdout=subprocess.PIPE, text=True)
        completed = None
        try:
            for line in process.stdout:
                event = json.loads(line)
                if callback: callback(min(98.0, event['percent']*.98), event['seconds'])
                if event.get('hardwareRequired'): completed = event
            if process.wait() != 0 or not completed:
                raise RuntimeError('Native hardware Dolby Vision encoding failed; no software fallback was attempted.')
        finally:
            if process.poll() is None:
                process.terminate(); process.wait()
        encoded, _, _ = probe_video(root/'video.mov')
        encoded_config = dolby_config(encoded)
        if not encoded_config or encoded_config.get('dv_profile') != 8 or encoded_config.get('dv_bl_signal_compatibility_id') != 4 or not encoded_config.get('rpu_present_flag'):
            raise RuntimeError('Hardware encoder did not produce Dolby Vision 8.4 metadata. Output was not delivered.')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(root/'video.mov'), '-i', str(source),
                        '-map', '0:v:0', '-map', '1:a:0?', '-c', 'copy', '-tag:v', 'hvc1',
                        '-strict', 'unofficial', '-movflags', '+faststart', str(output)], check=True)
        final, _, _ = probe_video(output)
        final_config = dolby_config(final)
        if (not final_config or final_config.get('dv_profile') != 8
                or final_config.get('dv_bl_signal_compatibility_id') != 4
                or not final_config.get('rpu_present_flag')
                or final.get('color_transfer') != 'arib-std-b67'
                or final.get('color_primaries') != 'bt2020' or '10' not in final.get('pix_fmt', '')):
            output.unlink(missing_ok=True)
            raise RuntimeError('Muxed output lost Dolby Vision metadata; output removed.')
        if callback: callback(100.0, duration)
        return dict(encoder='Apple VideoToolbox HEVC', hardwareRequired=True, softwareFallback=False,
                    compositor='Metal', dolbyVision='8.4 regenerated', frames=completed['frames'], targetBitrate=completed['targetBitrate'])

__all__ = ['videotoolbox_args', 'dolby_config', 'render_dolby_hardware']
