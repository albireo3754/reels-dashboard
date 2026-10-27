"""Build an isolated FFmpeg with zscale when the installed build lacks it.

The installed ffmpeg is never modified. Homebrew is used only to fetch a zimg
bottle and locate existing x264/x265 build dependencies.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parent
BUILD = ROOT / '.build'
FFMPEG_VERSION = '8.1'
FFMPEG_SHA = 'b072aed6871998cce9b36e7774033105ca29e33632be5b6347f3206898e0756a'
ZIMG_VERSION = '3.0.6'
ZIMG_BOTTLE_SHA = 'ee8314ce01c48102e3f977540d6095a444ceb8bce71f1868199c47cad4ce12e4'


def execute(command, **kwargs):
    subprocess.run(command, check=True, stdout=sys.stderr, **kwargs)


def output(command):
    return subprocess.check_output(command, text=True).strip()


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ffmpeg', required=True); parser.add_argument('--ffprobe', required=True)
    args = parser.parse_args()
    prefix = BUILD / 'media'
    marker = prefix / 'build-source.json'
    if marker.exists() and (prefix / 'bin/ffmpeg').is_file():
        print(json.dumps({'ffmpeg': str(prefix / 'bin/ffmpeg'), 'ffprobe': str(prefix / 'bin/ffprobe')})); return
    filters = output([args.ffmpeg, '-hide_banner', '-filters'])
    if ' zscale ' in filters:
        print(json.dumps({'ffmpeg': args.ffmpeg, 'ffprobe': args.ffprobe})); return
    if os.uname().machine != 'arm64':
        raise RuntimeError('Supply FFMPEG_BIN/FFPROBE_BIN built with zscale for this architecture; the private recipe targets Apple Silicon/macOS 15.')
    brew = shutil.which('brew')
    if not brew: raise RuntimeError('Homebrew is required at build time to locate x264/x265 and fetch zimg')
    execute([brew, 'fetch', '--force-bottle', 'zimg'])
    bottle = Path(output([brew, '--cache', 'zimg']))
    if sha(bottle) != ZIMG_BOTTLE_SHA:
        raise RuntimeError('zimg bottle changed. Review and update the pinned source checksum before building.')
    deps = BUILD / 'deps'; deps.mkdir(parents=True, exist_ok=True)
    zimg = deps / 'zimg' / ZIMG_VERSION
    if not zimg.is_dir():
        with tarfile.open(bottle) as archive: archive.extractall(deps, filter='data')
    pc = zimg / 'lib/pkgconfig/zimg.pc'
    pc.chmod(0o644)
    pc.write_text(pc.read_text().replace('@@HOMEBREW_CELLAR@@/zimg/' + ZIMG_VERSION, str(zimg)))
    library = (zimg / 'lib/libzimg.2.dylib').resolve()
    library.chmod(0o755)
    execute(['/usr/bin/install_name_tool', '-id', str(library), str(library)])
    execute(['/usr/bin/codesign', '--force', '--sign', '-', str(library)])
    tarball = BUILD / f'ffmpeg-{FFMPEG_VERSION}.tar.xz'
    if not tarball.exists():
        url = f'https://ffmpeg.org/releases/ffmpeg-{FFMPEG_VERSION}.tar.xz'
        with urllib.request.urlopen(url) as source, tarball.open('wb') as destination:
            shutil.copyfileobj(source, destination)
    if sha(tarball) != FFMPEG_SHA: raise RuntimeError('FFmpeg source checksum mismatch')
    source = BUILD / f'ffmpeg-{FFMPEG_VERSION}'
    if not source.is_dir():
        with tarfile.open(tarball) as archive: archive.extractall(BUILD, filter='data')
    codec_roots = [Path(output([brew, '--prefix', name])) for name in ('x264', 'x265')]
    env = dict(os.environ)
    env['PKG_CONFIG_PATH'] = ':'.join(str(p / 'lib/pkgconfig') for p in [zimg, *codec_roots])
    env['MACOSX_DEPLOYMENT_TARGET'] = '15.0'
    configuration = [str(source / 'configure'), f'--prefix={prefix}', '--enable-shared', '--disable-static',
                     '--disable-doc', '--disable-ffplay', '--enable-gpl', '--enable-version3',
                     '--enable-libx264', '--enable-libx265', '--enable-libzimg', '--enable-videotoolbox',
                     '--enable-audiotoolbox', '--enable-pthreads', '--cc=clang',
                     '--extra-ldflags=-Wl,-headerpad_max_install_names']
    execute(configuration, cwd=source, env=env)
    execute(['make', f'-j{min(8, os.cpu_count() or 2)}'], cwd=source, env=env)
    execute(['make', 'install'], cwd=source, env=env)
    for license_file in source.iterdir():
        if license_file.name.startswith(('COPYING', 'LICENSE')) and license_file.is_file():
            shutil.copy2(license_file, prefix / license_file.name)
    marker.write_text(json.dumps({'ffmpegVersion': FFMPEG_VERSION, 'ffmpegSourceSHA256': FFMPEG_SHA,
                                  'ffmpegSourceURL': f'https://ffmpeg.org/releases/ffmpeg-{FFMPEG_VERSION}.tar.xz',
                                  'zimgVersion': ZIMG_VERSION, 'zimgBottleSHA256': ZIMG_BOTTLE_SHA,
                                  'target': 'arm64-macos15', 'features': ['libx264', 'libx265', 'libzimg', 'videotoolbox', 'audiotoolbox']}, indent=2) + '\n')
    print(json.dumps({'ffmpeg': str(prefix / 'bin/ffmpeg'), 'ffprobe': str(prefix / 'bin/ffprobe')}))


if __name__ == '__main__': main()
