import { execFileSync } from 'node:child_process';
import { mkdirSync, existsSync, copyFileSync, cpSync, readdirSync, realpathSync, readlinkSync, rmSync, renameSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

if (process.platform !== 'darwin') throw new Error('The editor runtime currently targets macOS.');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = path.join(repo, 'native/editor-engine');
const build = path.join(engine, '.build');
const runtime = path.join(build, 'runtime-staging');
mkdirSync(build, { recursive: true });
const command = (file, args, options = {}) => execFileSync(file, args, { cwd: engine, ...options });
const text = (file, args) => command(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const uv = process.env.UV_BIN || text('/usr/bin/which', ['uv']);
const python = path.join(build, 'venv/bin/python');
if (!existsSync(python)) command(uv, ['venv', '--python', '3.12', path.join(build, 'venv')], { stdio: 'inherit' });
command(uv, ['pip', 'install', '--python', python, '-r', path.join(engine, 'requirements-build.txt')], { stdio: 'inherit' });
command(python, [path.join(engine, 'check_reels_architecture.py')], { stdio: 'inherit' });
command(python, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--name', 'reels-editor',
  '--distpath', path.join(build, 'dist'), '--workpath', path.join(build, 'pyinstaller'), '--specpath', build,
  '--paths', engine, path.join(engine, 'editor_cli.py')], { stdio: 'inherit' });
rmSync(runtime, { recursive: true, force: true });
cpSync(path.join(build, 'dist/reels-editor'), runtime, { recursive: true, verbatimSymlinks: true });
for (const directory of ['bin', 'lib', 'licenses']) mkdirSync(path.join(runtime, directory), { recursive: true });

const installedFFmpeg = realpathSync(process.env.FFMPEG_BIN || text('/usr/bin/which', ['ffmpeg']));
const installedFFprobe = realpathSync(process.env.FFPROBE_BIN || text('/usr/bin/which', ['ffprobe']));
const media = JSON.parse(command(python, [path.join(engine, 'build_media.py'), '--ffmpeg', installedFFmpeg, '--ffprobe', installedFFprobe],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }));
const ffmpeg = realpathSync(media.ffmpeg);
const ffprobe = realpathSync(media.ffprobe);
const copied = new Map();
const byName = new Map();
const roots = new Set();
function isSystem(file) { return file.startsWith('/System/Library/') || file.startsWith('/usr/lib/'); }
function dependencies(file) {
  return text('/usr/bin/otool', ['-L', file]).split('\n').slice(1).map(line => line.trim().split(' (')[0]).filter(Boolean);
}
function rpaths(file) {
  const lines = text('/usr/bin/otool', ['-l', file]).split('\n');
  const output = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].trim() === 'cmd LC_RPATH') {
    const match = lines.slice(i + 1, i + 5).join('\n').match(/\bpath (.+?) \(offset /);
    if (match) output.push(match[1].replace('@loader_path', path.dirname(file)));
  }
  return output;
}
function resolveDependency(dependency, owner) {
  if (dependency.startsWith('@loader_path')) return realpathSync(dependency.replace('@loader_path', path.dirname(owner)));
  if (dependency.startsWith('@rpath/')) {
    for (const base of rpaths(owner)) {
      const target = path.join(base, dependency.slice(7));
      if (existsSync(target)) return realpathSync(target);
    }
    throw new Error(`Cannot resolve dependency ${dependency} from ${path.basename(owner)}`);
  }
  if (!path.isAbsolute(dependency)) throw new Error(`Unsupported dynamic dependency ${dependency}`);
  return realpathSync(dependency);
}
function collect(source, destination) {
  source = realpathSync(source);
  if (copied.has(source)) return copied.get(source);
  const name = path.basename(destination);
  const previous = byName.get(name);
  const digest = createHash('sha256').update(readFileSync(source)).digest('hex');
  if (previous && previous.digest !== digest) throw new Error(`Conflicting bundled dylib basename: ${name}`);
  if (previous) { copied.set(source, previous); return previous; }
  const item = { source, destination, digest, dependencies: [] };
  copied.set(source, item); byName.set(name, item);
  copyFileSync(source, destination); chmodSync(destination, 0o755);
  const cellar = source.match(/^(.*\/Cellar\/[^/]+\/[^/]+)\//);
  if (cellar) roots.add(cellar[1]);
  else if (source.includes('/lib/')) roots.add(source.slice(0, source.lastIndexOf('/lib/')));
  for (const dependency of dependencies(source)) {
    if (isSystem(dependency)) continue;
    const actual = resolveDependency(dependency, source);
    if (actual === source) continue; // dylib's own install ID
    const child = collect(actual, path.join(runtime, 'lib', path.basename(actual)));
    item.dependencies.push({ original: dependency, destination: child.destination });
  }
  return item;
}
collect(ffmpeg, path.join(runtime, 'bin/ffmpeg'));
collect(ffprobe, path.join(runtime, 'bin/ffprobe'));
roots.add(path.dirname(path.dirname(ffmpeg)));
for (const item of new Set(copied.values())) {
  if (item.destination.endsWith('.dylib')) command('/usr/bin/install_name_tool', ['-id', `@rpath/${path.basename(item.destination)}`, item.destination]);
  for (const dependency of item.dependencies) {
    const replacement = '@loader_path/' + path.relative(path.dirname(item.destination), dependency.destination);
    command('/usr/bin/install_name_tool', ['-change', dependency.original, replacement, item.destination]);
  }
  command('/usr/bin/codesign', ['--force', '--sign', '-', item.destination], { stdio: 'ignore' });
  const unexpected = dependencies(item.destination).filter(value => value.startsWith('/') && !isSystem(value));
  if (unexpected.length) throw new Error(`Non-system external dependencies remain in ${path.basename(item.destination)}`);
}

const licenseIndex = [];
function copyLicenses(root) {
  const marker = path.join(root, 'build-source.json');
  const label = existsSync(marker) ? `ffmpeg-${JSON.parse(readFileSync(marker, 'utf8')).ffmpegVersion}`
    : path.basename(path.dirname(root)) + '-' + path.basename(root);
  const output = path.join(runtime, 'licenses', label); mkdirSync(output, { recursive: true });
  let count = 0;
  function scan(directory, depth = 0) {
    if (depth > 3) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && !['bin', 'lib', 'include', 'man'].includes(entry.name)) scan(file, depth + 1);
      else if (entry.isFile() && /^(LICENSE|COPYING|NOTICE|COPYRIGHT)/i.test(entry.name)) {
        const relative = path.relative(root, file);
        mkdirSync(path.dirname(path.join(output, relative)), { recursive: true });
        copyFileSync(file, path.join(output, relative)); count++;
      }
    }
  }
  scan(root);
  for (const name of ['INSTALL_RECEIPT.json', 'sbom.spdx.json', 'build-source.json']) {
    if (existsSync(path.join(root, name))) copyFileSync(path.join(root, name), path.join(output, name));
  }
  if (!count) throw new Error(`No license text found for linked dependency ${label}`);
  licenseIndex.push({ component: label, licenseFiles: count });
}
for (const root of roots) copyLicenses(root);
const pythonLicenses = JSON.parse(text(python, ['-c', `import json,sysconfig,importlib.metadata as m
from pathlib import Path
out=[]
for name in ('pillow','pyinstaller','pyinstaller-hooks-contrib','altgraph','macholib','packaging','setuptools'):
 d=m.distribution(name)
 for p in d.files or []:
  if p.name.upper().startswith(('LICENSE','COPYING','NOTICE')):
   out.append([name+'-'+d.version,str(d.locate_file(p))])
p=Path(sysconfig.get_paths()['stdlib'])/'LICENSE.txt'
if p.is_file(): out.append(['python',str(p)])
print(json.dumps(out))`]));
for (const [component, file] of pythonLicenses) {
  const directory = path.join(runtime, 'licenses', component); mkdirSync(directory, { recursive: true });
  copyFileSync(file, path.join(directory, path.basename(file)));
}
writeFileSync(path.join(runtime, 'licenses/components.json'), JSON.stringify(licenseIndex, null, 2) + '\n');
writeFileSync(path.join(runtime, 'licenses/README.txt'), 'This runtime includes Python, Pillow, the PyInstaller bootloader (with its exception), FFmpeg, and linked libraries. Their licenses are included per component. The app source license does not replace these licenses. Before distributing binaries, satisfy corresponding-source and notice requirements for the exact bundled GPL/LGPL components. No Apple fonts are bundled.\n');
writeFileSync(path.join(runtime, 'build-info.json'), JSON.stringify({
  architecture: process.arch, ffmpeg: text(ffmpeg, ['-version']).split('\n')[0],
  libraries: [...new Set(copied.values())].map(item => ({ name: path.basename(item.destination), sourceSha256: item.digest })),
}, null, 2) + '\n');
const minimal = { PATH: '/usr/bin:/bin', HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || '/tmp' };
function auditRuntime(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      if (path.isAbsolute(readlinkSync(file)) || !realpathSync(file).startsWith(runtime + path.sep)) {
        throw new Error(`Runtime symlink escapes the bundle: ${path.relative(runtime, file)}`);
      }
    } else if (entry.isDirectory()) auditRuntime(file);
    else if (entry.isFile()) {
      const magic = readFileSync(file).subarray(0, 4).toString('hex');
      if (['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca'].includes(magic)) {
        const external = dependencies(file).filter(value => value.startsWith('/') && !isSystem(value));
        if (external.length) throw new Error(`Runtime binary links outside the bundle: ${path.relative(runtime, file)}`);
      }
    }
  }
}
auditRuntime(runtime);
command(path.join(runtime, 'reels-editor'), ['--help'], { env: minimal, stdio: 'ignore' });
command(path.join(runtime, 'bin/ffmpeg'), ['-version'], { env: minimal, stdio: 'ignore' });
command(path.join(runtime, 'bin/ffprobe'), ['-version'], { env: minimal, stdio: 'ignore' });
const finalRuntime = path.join(build, 'runtime');
rmSync(finalRuntime, { recursive: true, force: true });
renameSync(runtime, finalRuntime);
console.log(`Editor runtime ready: ${path.relative(repo, finalRuntime)} (${new Set(copied.values()).size} media executables/libraries)`);
