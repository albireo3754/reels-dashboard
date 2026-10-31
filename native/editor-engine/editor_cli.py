"""JSON adapter for the vendored renderer; no shell or original-checkout dependency."""
import argparse
import contextlib
import io
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile

# The frozen executable owns its media tools. Host PATH is never consulted there.
if getattr(sys, 'frozen', False):
    runtime = Path(sys.executable).resolve().parent
    os.environ['PATH'] = str(runtime / 'bin') + ':/usr/bin:/bin'

from reels_editor.features.video_overlay import run as video_main
from reels_editor.features.thumbnail import run as thumbnail_main
from reels_editor.shared.media import probe_video, run_ffmpeg_progress
from follow_cover import render_follow_cover
from card_templates import render_batch


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), file=sys.__stdout__, flush=True)


def probe(source):
    stream, (width, height), duration = probe_video(source)
    if duration is None or not math.isfinite(duration) or duration <= 0:
        raise ValueError('A finite-duration video is required')
    audio = json.loads(subprocess.check_output([
        'ffprobe', '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'json', str(source)]))
    return dict(duration=duration, width=width, height=height,
                hdr=stream.get('color_transfer') in ('arib-std-b67', 'smpte2084'),
                hasAudio=bool(audio.get('streams')), colorTransfer=stream.get('color_transfer'),
                pixelFormat=stream.get('pix_fmt'), colorPrimaries=stream.get('color_primaries'),
                colorSpace=stream.get('color_space'))


def source_path(value):
    if not isinstance(value, str) or not value or '\0' in value:
        raise ValueError('sourcePath must name a video file')
    source = Path(value).expanduser().resolve(strict=True)
    if not source.is_file():
        raise ValueError('Source must be a regular file')
    return source


def output_path(value, source):
    output = Path(value).expanduser().resolve()
    if output == source:
        raise ValueError('Output must not overwrite the source')
    if not output.parent.is_dir():
        raise ValueError('Output directory does not exist')
    return output


def number(value, name, minimum=0, maximum=1):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError(f'{name} must be between {minimum} and {maximum}')
    return str(value)


def offset_arguments(settings, mapping):
    args = []
    for key, flag in mapping:
        if key in settings:
            args += [flag, number(settings[key], key, -1, 1)]
    return args


def video_arguments(request, output, temporary):
    place = request['place']
    if not isinstance(place['name'], str) or not place['name'].strip():
        raise ValueError('A place name is required')
    material = place['material']
    if material not in ('none', 'tape', 'rectangle'):
        raise ValueError('Unsupported description material')
    banner = material != 'none'
    args = [str(source_path(request['sourcePath'])), place['name'], '-o', str(output),
            '--template', 'shimbashi-pin-banner' if banner else 'shimbashi-pin-only',
            '--size', number(place['size'], 'place.size', .001, .2)]
    if not isinstance(place['useDefaultPosition'], bool):
        raise ValueError('place.useDefaultPosition must be a boolean')
    if not place['useDefaultPosition']:
        args += ['--place-x', number(place['x'], 'place.x'), '--place-y', number(place['y'], 'place.y')]
    args += offset_arguments(place, [('offsetX', '--place-offset-x'), ('offsetY', '--place-offset-y')])
    if banner:
        description = place['description']
        if not isinstance(description, str) or not description.strip():
            raise ValueError('A tape or rectangle requires a one-line description')
        args += ['--description', description, '--banner-material', material]
    show_during = place.get('showDuring', '')
    if not isinstance(place['persistent'], bool):
        raise ValueError('place.persistent must be a boolean')
    if show_during and (banner or not place['persistent']):
        args += ['--show-during', show_during]
        if banner and place['persistent']:
            args += ['--persistent-pin']
    captions = request['captions']
    if not isinstance(captions['items'], list):
        raise ValueError('captions.items must be a list')
    if captions['items']:
        config = {'font_size_ratio': captions['fontSizeRatio'], 'y': captions['y'],
                  'captions': [{key: item[key] for key in ('start', 'end', 'text')} for item in captions['items']]}
        path = temporary / 'captions.json'
        path.write_text(json.dumps(config, ensure_ascii=False, allow_nan=False), encoding='utf8')
        args += ['--captions', str(path)]
    return args


def cover_arguments(request, output):
    cover = request['cover']
    if cover['template'] not in ('rosy-auto', 'rosy-large'):
        raise ValueError('Unsupported cover template')
    hook = cover['hook']
    if not isinstance(hook, str):
        raise ValueError('cover.hook must be text')
    args = [str(source_path(request['sourcePath'])), str(output), '--place', request['place']['name'],
            '--hook', hook.replace('\n', '|'), '--template', cover['template'],
            '--t', number(cover['time'], 'cover.time', 0, 86400)]
    if not isinstance(cover['useDefaultPosition'], bool):
        raise ValueError('cover.useDefaultPosition must be a boolean')
    if not cover['useDefaultPosition']:
        args += ['--x', number(cover['x'], 'cover.x'), '--y', number(cover['y'], 'cover.y'),
                 '--place-x', number(cover['placeX'], 'cover.placeX'), '--place-y', number(cover['placeY'], 'cover.placeY')]
    args += offset_arguments(cover, [('hookOffsetX', '--hook-offset-x'), ('hookOffsetY', '--hook-offset-y'),
                                     ('placeOffsetX', '--place-offset-x'), ('placeOffsetY', '--place-offset-y')])
    if cover.get('hookSize') is not None:
        size = cover['hookSize']
        if isinstance(size, bool) or not isinstance(size, int):
            raise ValueError('cover.hookSize must be an integer')
        args += ['--hook-size', number(size, 'cover.hookSize', 1, 185)]
    return args


def proxy(source, output):
    info = probe(source)
    filters = []
    if info['hdr']:
        filters += ['zscale=t=linear:npl=100', 'format=gbrpf32le', 'tonemap=tonemap=hable:desat=0',
                    'zscale=p=bt709:t=bt709:m=bt709:r=tv']
    filters += ['scale=1080:1080:force_original_aspect_ratio=decrease:force_divisible_by=2', 'format=yuv420p']
    command = ['ffmpeg', '-y', '-v', 'error', '-i', str(source), '-map', '0:v:0', '-map', '0:a:0?',
               '-vf', ','.join(filters), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
               '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart']
    if info['hdr']:
        command += ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709']
    subprocess.run([*command, str(output)], check=True)
    return {'outputPath': str(output), 'hdrToSDR': info['hdr']}


def main(argv=None):
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='action', required=True)
    p = sub.add_parser('card-frames'); p.add_argument('request'); p.add_argument('output')
    sub.add_parser('probe').add_argument('source')
    p = sub.add_parser('proxy'); p.add_argument('source'); p.add_argument('output')
    for action in ('preview', 'cover', 'render'):
        p = sub.add_parser(action); p.add_argument('request'); p.add_argument('output')
        if action == 'preview': p.add_argument('--time', type=float, required=True)
    args = parser.parse_args(argv)
    if args.action == 'card-frames':
        emit(render_batch(json.loads(Path(args.request).read_text(encoding='utf8')), args.output)); return
    if args.action == 'probe':
        emit(probe(source_path(args.source))); return
    if args.action == 'proxy':
        source = source_path(args.source)
        emit(proxy(source, output_path(args.output, source))); return
    request = json.loads(Path(args.request).read_text(encoding='utf8'))
    source = source_path(request['sourcePath'])
    output = output_path(args.output, source)
    manifest = output.with_suffix('.style.json')
    captured = io.StringIO()
    with tempfile.TemporaryDirectory(prefix='reels-editor-') as directory, contextlib.redirect_stdout(captured):
        if args.action == 'cover':
            if request['cover']['template'] == 'rosy-follow':
                render_follow_cover(request, output)
            else:
                thumbnail_main(cover_arguments(request, output))
        else:
            arguments = video_arguments(request, output, Path(directory))
            if args.action == 'preview':
                # The legacy preview guard requires a separate logical render output.
                arguments[arguments.index('-o') + 1] = str(Path(directory) / 'unused.mp4')
                arguments += ['--dry-run', '--preview', str(output), '--preview-time', str(args.time)]
                video_main(arguments)
                manifest.write_text(captured.getvalue(), encoding='utf8')
            else:
                video_main(arguments, progress_callback=lambda percent, seconds: emit(
                    {'type': 'progress', 'percent': percent, 'outTimeSeconds': seconds}))
    result = {'outputPath': str(output), 'manifestPath': str(manifest)}
    if args.action == 'render': result['type'] = 'result'
    emit(result)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, RuntimeError, subprocess.CalledProcessError) as error:
        message = str(error)
        if 'scripts/setup_reels_fonts.py' in message:
            message = '기존 일본어 명조체가 없습니다. macOS의 Toppan Bunkyu Midashi Mincho ExtraBold 서체를 설치한 뒤 다시 시도해주세요. 다른 글꼴로 바꾸지 않았어요.'
        print(f'Editor error: {message}', file=sys.stderr)
        raise SystemExit(1)
