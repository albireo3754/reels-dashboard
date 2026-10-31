#!/bin/zsh
set -euo pipefail

if (( $# != 2 )); then
  print -u2 -r -- "Usage: $0 <app-path> <entitlements-path>"
  exit 64
fi

app_path=$1
entitlements_path=$2
signing_mode=${PHOTOSINDEX_SIGNING_MODE:-developer-id}
codesign_command=${PHOTOSINDEX_CODESIGN_COMMAND:-/usr/bin/codesign}
security_command=${PHOTOSINDEX_SECURITY_COMMAND:-/usr/bin/security}
signing_identifier=dev.pray.PhotosIndex

case "$signing_mode" in
  developer-id)
    signing_identity=${PHOTOSINDEX_SIGNING_IDENTITY:-}
    if [[ -n "$signing_identity" && "$signing_identity" != "Developer ID Application:"* ]]; then
      print -u2 -r -- "PHOTOSINDEX_SIGNING_IDENTITY must start with 'Developer ID Application:'."
      exit 64
    fi
    # Deduplicate the same certificate exposed by multiple keychains. Never
    # silently select a different team when more than one identity is available.
    identities=$("$security_command" find-identity -v -p codesigning)
    candidates=$(print -r -- "$identities" | awk -F '"' '$2 ~ /^Developer ID Application:/ { split($1, parts, " "); print parts[2] "\t" $2 }' | sort -u)
    if [[ -n "$signing_identity" ]]; then
      candidates=$(print -r -- "$candidates" | awk -F '\t' -v name="$signing_identity" '$2 == name')
    fi
    count=$(print -r -- "$candidates" | awk 'NF { n++ } END { print n+0 }')
    if [[ "$count" != 1 ]]; then
      print -u2 -r -- "Expected one valid Developer ID Application identity; found $count. Install a certificate with its private key, or select one with PHOTOSINDEX_SIGNING_IDENTITY. No ad-hoc fallback is used."
      exit 78
    fi
    # Sign by fingerprint so an ambiguous certificate name cannot change identity.
    signing_identity=${candidates%%$'\t'*}
    ;;
  ci-adhoc)
    if [[ "${CI:-}" != true ]]; then
      print -u2 -r -- "ci-adhoc signing is restricted to disposable CI artifacts (CI=true). Local builds require Developer ID Application signing."
      exit 64
    fi
    signing_identity=-
    ;;
  *)
    print -u2 -r -- "Unsupported PHOTOSINDEX_SIGNING_MODE '$signing_mode'; use developer-id (default), or ci-adhoc only in CI."
    exit 64
    ;;
esac

"$codesign_command" \
  --force \
  --options runtime \
  --identifier "$signing_identifier" \
  --sign "$signing_identity" \
  --entitlements "$entitlements_path" \
  "$app_path"
