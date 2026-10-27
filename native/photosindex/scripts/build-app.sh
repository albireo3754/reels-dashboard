#!/bin/zsh
set -euo pipefail

project_root=${0:A:h:h}
cd "$project_root"

swift build -c release --product PhotosIndexApp
swift build -c release --product photosindex

binary_dir=$(swift build -c release --show-bin-path)
app_dir="$project_root/.build/PhotosIndex.app"
# Never copy or codesign over an executable that may still be mapped by a live
# helper. Build and verify a completely new bundle on the same filesystem.
staging_root=$(mktemp -d "$project_root/.build/.PhotosIndex-stage.XXXXXX")
trap 'rm -rf -- "$staging_root"' EXIT
staged_app="$staging_root/PhotosIndex.app"
mkdir -p "$staged_app/Contents/MacOS" "$staged_app/Contents/Resources"
cp "$binary_dir/PhotosIndexApp" "$staged_app/Contents/MacOS/PhotosIndex"
cp "$project_root/AppBundle/Info.plist" "$staged_app/Contents/Info.plist"

"$project_root/scripts/sign-app.sh" \
  "$staged_app" \
  "$project_root/AppBundle/PhotosIndex.entitlements"

plutil -lint "$staged_app/Contents/Info.plist"
codesign --verify --deep --strict "$staged_app"

# macOS renamex_np(RENAME_SWAP) atomically exchanges two nonempty directories.
# The old bundle moves into staging and is unlinked by the trap; its live vnode
# is never modified. If signing, verification or swapping fails, the published
# bundle is untouched. There is no interval with a missing published app.
/usr/bin/python3 - "$staged_app" "$app_dir" <<'PY'
import ctypes
import os
import stat
import sys

source, destination = sys.argv[1:]
if not os.path.lexists(destination):
    os.rename(source, destination)
else:
    info = os.lstat(destination)
    if not stat.S_ISDIR(info.st_mode):
        raise RuntimeError("Refusing to replace a non-directory helper bundle")
    libc = ctypes.CDLL(None, use_errno=True)
    swap = libc.renamex_np
    swap.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    swap.restype = ctypes.c_int
    # RENAME_SWAP from the macOS SDK's sys/stdio.h.
    if swap(os.fsencode(source), os.fsencode(destination), 0x00000002) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
PY
print -r -- "$app_dir"
