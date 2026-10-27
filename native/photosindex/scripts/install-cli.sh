#!/bin/zsh
set -euo pipefail

project_root=${0:A:h:h}
install_root=${PHOTOSINDEX_INSTALL_ROOT:-$HOME/.local}
[[ "$install_root" == /* ]] || {
  print -u2 -r -- "PHOTOSINDEX_INSTALL_ROOT must be an absolute path"
  exit 64
}
source_cli="$project_root/.build/photosindex"
source_app="$project_root/.build/PhotosIndex.app"
[[ -x "$source_cli" && -d "$source_app" ]] || {
  print -u2 -r -- "Build the bundled native artifacts with node scripts/build-native.mjs first"
  exit 66
}

bin_dir="$install_root/bin"
lib_dir="$install_root/lib"
installed_pair="$lib_dir/reels-dashboard"
mkdir -p "$bin_dir" "$lib_dir"
staging_root=$(mktemp -d "$lib_dir/.reels-dashboard-install.XXXXXX")
launcher_stage=$(mktemp "$bin_dir/.photosindex-launcher.XXXXXX")
trap 'rm -rf -- "$staging_root"; rm -f -- "$launcher_stage"' EXIT
staged_pair="$staging_root/reels-dashboard"
mkdir -p "$staged_pair"
# The destination is new: neither operation may modify a published Mach-O inode.
cp "$source_cli" "$staged_pair/photosindex"
chmod 0755 "$staged_pair/photosindex"
/usr/bin/ditto "$source_app" "$staged_pair/PhotosIndex.app"
codesign --verify --strict "$staged_pair/photosindex"
codesign --verify --deep --strict "$staged_pair/PhotosIndex.app"

cat > "$launcher_stage" <<'LAUNCHER'
#!/bin/zsh
set -euo pipefail
install_root=${0:A:h:h}
paired_root="$install_root/lib/reels-dashboard"
export PHOTOSINDEX_APP_PATH="${PHOTOSINDEX_APP_PATH:-$paired_root/PhotosIndex.app}"
exec "$paired_root/photosindex" "$@"
LAUNCHER
chmod 0755 "$launcher_stage"

# Publish the matched pair atomically; a running helper retains its old vnode.
/usr/bin/python3 - "$staged_pair" "$installed_pair" "$launcher_stage" "$bin_dir/photosindex" <<'PY'
import ctypes
import os
import stat
import sys

source, destination, launcher, installed_launcher = sys.argv[1:]
if not os.path.lexists(destination):
    os.rename(source, destination)
else:
    if not stat.S_ISDIR(os.lstat(destination).st_mode):
        raise RuntimeError("Refusing to replace a non-directory native installation")
    libc = ctypes.CDLL(None, use_errno=True)
    swap = libc.renamex_np
    swap.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    swap.restype = ctypes.c_int
    if swap(os.fsencode(source), os.fsencode(destination), 0x00000002) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
os.replace(launcher, installed_launcher)
PY
print -r -- "$bin_dir/photosindex"
print -r -- "$installed_pair/PhotosIndex.app"
