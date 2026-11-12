"""Build an isolated FFmpeg with zscale when the installed build lacks it.

The installed ffmpeg is never modified. Homebrew is used only at build time to
fetch a zimg bottle and locate the x264/x265 libraries to link against. After
the build every non-system library (x264, x265, zimg and their dependencies) is
copied into `.build/media/lib` and every reference is rewritten to
`@loader_path`, so later Homebrew upgrades or `brew cleanup` cannot break the
private build. Their license files are kept per component under
`.build/media/vendor-licenses/<name-version>/`.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
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
# Bump when the recipe changes so an older cached build is rebuilt.
RECIPE = 2
MINIMAL_ENV = {'PATH': '/usr/bin:/bin', 'HOME': os.environ.get('HOME', '/tmp'), 'TMPDIR': os.environ.get('TMPDIR', '/tmp')}


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


def is_system(dependency):
    return dependency.startswith(('/System/Library/', '/usr/lib/'))


def dependencies(file):
    lines = output(['/usr/bin/otool', '-L', str(file)]).split('\n')[1:]
    return [line.strip().split(' (')[0] for line in lines if line.strip()]


def is_macho(file):
    with file.open('rb') as stream:
        return stream.read(4).hex() in ('cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca')


def machos(prefix):
    files = [prefix / 'bin/ffmpeg', prefix / 'bin/ffprobe']
    files += sorted(p for p in (prefix / 'lib').iterdir() if p.is_file() and not p.is_symlink() and p.suffix == '.dylib')
    return files


def license_root(real):
    cellar = re.match(r'^(.*/Cellar/[^/]+/[^/]+)/', str(real))
    if cellar: return Path(cellar[1])
    text = str(real)
    return Path(text[:text.rindex('/lib/')]) if '/lib/' in text else real.parent


def vendor(prefix):
    """Copy non-system libraries into prefix/lib and rewrite every reference to @loader_path."""
    lib = prefix / 'lib'
    licenses = prefix / 'vendor-licenses'
    queue, seen = machos(prefix), set()
    while queue:
        file = queue.pop()
        if file in seen: continue
        seen.add(file)
        file.chmod(0o755)
        own = None
        if file.suffix == '.dylib':
            own = file.name
            execute(['/usr/bin/install_name_tool', '-id', f'@loader_path/{file.name}', str(file)])
        for dependency in dependencies(file):
            if is_system(dependency) or dependency.startswith('@loader_path/'): continue
            name = Path(dependency).name
            if name == own: continue
            if dependency.startswith('@'):
                raise RuntimeError(f'Unexpected dependency {dependency} in {file.name}')
            target = lib / name
            if not target.exists():
                real = Path(dependency).resolve()
                shutil.copy2(real, target)
                target.chmod(0o755)
                queue.append(target)
                root = license_root(real)
                destination = licenses / f'{root.parent.name}-{root.name}'
                if not destination.exists():
                    found = [p for p in root.rglob('*') if p.is_file() and re.match(r'(LICENSE|COPYING|NOTICE|COPYRIGHT)', p.name, re.I)
                             and not set(p.relative_to(root).parts[:-1]) & {'bin', 'lib', 'include', 'man'}]
                    if not found: raise RuntimeError(f'No license text found for {root}')
                    for p in found:
                        (destination / p.relative_to(root)).parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(p, destination / p.relative_to(root))
            reference = f'@loader_path/../lib/{name}' if file.parent.name == 'bin' else f'@loader_path/{name}'
            execute(['/usr/bin/install_name_tool', '-change', dependency, reference, str(file)])
    for file in machos(prefix):
        execute(['/usr/bin/codesign', '--force', '--sign', '-', str(file)])


def problems(prefix):
    """Reasons the build cannot be reused: outside references, failed launch or missing encoders."""
    found = []
    for file in machos(prefix):
        outside = [d for d in dependencies(file) if not is_system(d) and not d.startswith('@loader_path/')]
        if outside: found.append(f'{file.name} links {outside}')
    if found: return found
    run = subprocess.run([str(prefix / 'bin/ffmpeg'), '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=64x64:d=0.2',
                          '-vf', 'zscale=w=32:h=32', '-c:v', 'libx265', '-f', 'null', '-'], env=MINIMAL_ENV, capture_output=True, text=True)
    if run.returncode: found.append('ffmpeg x265/zscale smoke test failed: ' + run.stderr.strip()[-300:])
    run = subprocess.run([str(prefix / 'bin/ffprobe'), '-version'], env=MINIMAL_ENV, capture_output=True, text=True)
    if run.returncode: found.append('ffprobe failed to start')
    return found


def cached(prefix):
    marker = prefix / 'build-source.json'
    if not marker.exists() or not (prefix / 'bin/ffmpeg').is_file(): return False
    try:
        if json.loads(marker.read_text()).get('recipe') != RECIPE: return False
    except ValueError:
        return False
    return not problems(prefix)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--ffmpeg', required=True); parser.add_argument('--ffprobe', required=True)
    args = parser.parse_args()
    prefix = BUILD / 'media'
    if cached(prefix):
        print(json.dumps({'ffmpeg': str(prefix / 'bin/ffmpeg'), 'ffprobe': str(prefix / 'bin/ffprobe')})); return
    filters = output([args.ffmpeg, '-hide_banner', '-filters'])
    if ' zscale ' in filters:
        print(json.dumps({'ffmpeg': args.ffmpeg, 'ffprobe': args.ffprobe})); return
    if os.uname().machine != 'arm64':
        raise RuntimeError('Supply FFMPEG_BIN/FFPROBE_BIN built with zscale for this architecture; the private recipe targets Apple Silicon/macOS 15.')
    brew = shutil.which('brew')
    if not brew: raise RuntimeError('Homebrew is required at build time to locate x264/x265 and fetch zimg')
    deps = BUILD / 'deps'; deps.mkdir(parents=True, exist_ok=True)
    zimg = deps / 'zimg' / ZIMG_VERSION
    if not (zimg / 'lib/libzimg.2.dylib').exists():  # an extracted, checksum-verified bottle is reused
        execute([brew, 'fetch', '--force-bottle', 'zimg'])
        bottle = Path(output([brew, '--cache', 'zimg']))
        if sha(bottle) != ZIMG_BOTTLE_SHA:
            raise RuntimeError('zimg bottle changed. Review and update the pinned source checksum before building.')
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
    if source.is_dir(): shutil.rmtree(source)  # a fresh tree so configure options always apply
    with tarfile.open(tarball) as archive: archive.extractall(BUILD, filter='data')
    codec_roots = [Path(output([brew, '--prefix', name])) for name in ('x264', 'x265')]
    env = dict(os.environ)
    env['PKG_CONFIG_PATH'] = ':'.join(str(p / 'lib/pkgconfig') for p in [zimg, *codec_roots])
    env['MACOSX_DEPLOYMENT_TARGET'] = '15.0'
    partial = BUILD / 'media.partial'
    if partial.exists(): shutil.rmtree(partial)
    configuration = [str(source / 'configure'), f'--prefix={partial}', '--enable-shared', '--disable-static',
                     '--disable-doc', '--disable-ffplay', '--enable-gpl', '--enable-version3',
                     '--enable-libx264', '--enable-libx265', '--enable-libzimg', '--enable-videotoolbox',
                     '--enable-audiotoolbox', '--enable-pthreads', '--disable-libxcb', '--disable-xlib', '--cc=clang',
                     '--extra-ldflags=-Wl,-headerpad_max_install_names']
    execute(configuration, cwd=source, env=env)
    execute(['make', f'-j{min(8, os.cpu_count() or 2)}'], cwd=source, env=env)
    execute(['make', 'install'], cwd=source, env=env)
    shutil.rmtree(partial / 'lib/pkgconfig', ignore_errors=True)  # pkg-config files carry the build prefix
    vendor(partial)
    for license_file in source.iterdir():
        if license_file.name.startswith(('COPYING', 'LICENSE')) and license_file.is_file():
            shutil.copy2(license_file, partial / license_file.name)
    (partial / 'build-source.json').write_text(json.dumps({
        'recipe': RECIPE, 'ffmpegVersion': FFMPEG_VERSION, 'ffmpegSourceSHA256': FFMPEG_SHA,
        'ffmpegSourceURL': f'https://ffmpeg.org/releases/ffmpeg-{FFMPEG_VERSION}.tar.xz',
        'zimgVersion': ZIMG_VERSION, 'zimgBottleSHA256': ZIMG_BOTTLE_SHA,
        'target': 'arm64-macos15', 'features': ['libx264', 'libx265', 'libzimg', 'videotoolbox', 'audiotoolbox'],
        'vendored': sorted(p.name for p in (partial / 'vendor-licenses').iterdir()) if (partial / 'vendor-licenses').is_dir() else [],
    }, indent=2) + '\n')
    failed = problems(partial)
    if failed: raise RuntimeError('Private FFmpeg build failed verification: ' + '; '.join(failed))
    if prefix.exists():
        retired = BUILD / 'media.previous'
        if retired.exists(): shutil.rmtree(retired)
        prefix.rename(retired)
        shutil.rmtree(retired)
    partial.rename(prefix)
    print(json.dumps({'ffmpeg': str(prefix / 'bin/ffmpeg'), 'ffprobe': str(prefix / 'bin/ffprobe')}))


if __name__ == '__main__': main()
