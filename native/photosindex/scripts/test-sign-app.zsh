#!/bin/zsh
set -euo pipefail
project_root=${0:A:h:h}
sign_app="$project_root/scripts/sign-app.sh"
test_root=$(mktemp -d "${TMPDIR:-/tmp}/photosindex-signing.XXXXXX")
trap 'rm -rf -- "$test_root"' EXIT
mkdir -p "$test_root/PhotosIndex.app"
touch "$test_root/entitlements"
cat > "$test_root/security" <<'SCRIPT'
#!/bin/zsh
case "$SIGNING_FIXTURE" in
  normal)
    print -r -- '  1) AAAA "Developer ID Application: Example (TEAM123)"'
    print -r -- '  2) AAAA "Developer ID Application: Example (TEAM123)"'
    print -r -- '  3) BBBB "Apple Development: Example (TEAM123)"';;
  multiple)
    print -r -- '  1) AAAA "Developer ID Application: Example (TEAM123)"'
    print -r -- '  2) CCCC "Developer ID Application: Other (TEAM456)"';;
  missing) print -r -- '  1) BBBB "Apple Development: Example (TEAM123)"';;
esac
SCRIPT
cat > "$test_root/codesign" <<'SCRIPT'
#!/bin/zsh
print -rl -- "$@" > "$PHOTOSINDEX_CODESIGN_LOG"
SCRIPT
chmod +x "$test_root/security" "$test_root/codesign"
run_sign() {
  env -u PHOTOSINDEX_SIGNING_IDENTITY \
    CI=false PHOTOSINDEX_SIGNING_MODE=developer-id SIGNING_FIXTURE=normal \
    PHOTOSINDEX_CODESIGN_COMMAND="$test_root/codesign" \
    PHOTOSINDEX_CODESIGN_LOG="$test_root/sign.log" \
    PHOTOSINDEX_SECURITY_COMMAND="$test_root/security" \
    "$@" zsh "$sign_app" "$test_root/PhotosIndex.app" "$test_root/entitlements"
}
assert_pair() {
  [[ $(awk -v key="$1" '$0 == key { getline; print; exit }' "$test_root/sign.log") == "$2" ]] || { print -u2 -- "Unexpected $1"; exit 1; }
}
reject() {
  rm -f "$test_root/sign.log"
  if run_sign "$@" > "$test_root/error" 2>&1; then print -u2 -- "Unexpected success: $*"; exit 1; fi
  [[ ! -e "$test_root/sign.log" ]] || { print -u2 -- 'codesign ran after validation failure'; exit 1; }
}
run_sign
assert_pair --sign AAAA
assert_pair --identifier dev.pray.PhotosIndex
assert_pair --entitlements "$test_root/entitlements"
run_sign SIGNING_FIXTURE=multiple 'PHOTOSINDEX_SIGNING_IDENTITY=Developer ID Application: Other (TEAM456)'
assert_pair --sign CCCC
reject SIGNING_FIXTURE=multiple
reject SIGNING_FIXTURE=missing
reject 'PHOTOSINDEX_SIGNING_IDENTITY=Apple Development: Example (TEAM123)'
reject 'PHOTOSINDEX_SIGNING_IDENTITY=Developer ID Application: Missing (TEAM000)'
reject PHOTOSINDEX_SIGNING_MODE=adhoc
reject PHOTOSINDEX_SIGNING_MODE=development
reject PHOTOSINDEX_SIGNING_MODE=ci-adhoc
run_sign PHOTOSINDEX_SIGNING_MODE=ci-adhoc CI=true SIGNING_FIXTURE=missing
assert_pair --sign -
print -r -- 'sign-app tests passed: stable identity, duplicates, ambiguity, missing identities, legacy modes and CI gate'
