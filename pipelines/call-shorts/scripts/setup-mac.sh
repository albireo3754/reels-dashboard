#!/bin/bash
#   bash pipelines/call-shorts/scripts/setup-mac.sh            # 설치 + launchd 등록
#   bash pipelines/call-shorts/scripts/setup-mac.sh --no-launchd
#   bash pipelines/call-shorts/scripts/setup-mac.sh --with-local-asr   # whisperx(로컬 전사)까지
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PIPELINE_DIR="$REPO_ROOT/pipelines/call-shorts"
ROOT="${PIPELINE_ROOT:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/여친탐구생활}"
WITH_LAUNCHD=1
WITH_LOCAL_ASR=0

for arg in "$@"; do
  case "$arg" in
    --no-launchd) WITH_LAUNCHD=0 ;;
    --with-local-asr) WITH_LOCAL_ASR=1 ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) echo "알 수 없는 옵션: $arg"; exit 2 ;;
  esac
done

echo "== 1/6 node / ffmpeg =="
if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ node 없음 — https://nodejs.org (>=22.12) 또는 'brew install node@22'"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "  ✗ node $(node -v) — 22.12 이상이 필요합니다"
  exit 1
fi
echo "  ✓ node $(node -v)"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "  ✗ ffmpeg 없음 — 'brew install ffmpeg' 후 다시 실행하세요 (렌더 불가)"
  exit 1
fi
echo "  ✓ $(ffmpeg -version | head -1)"

if [ ! -d "$REPO_ROOT/node_modules/tsx" ]; then
  echo "  · node_modules/tsx 가 없습니다 — 레포 루트에서 'npm ci' 를 먼저 실행하세요"
fi

echo "== 2/6 iCloud Drive 폴더 =="
for sub in "" inbox processed failed projects outbox state logs assets assets/characters assets/sfx assets/bgm; do
  mkdir -p "$ROOT/$sub"
done
echo "  ✓ $ROOT"

echo "== 3/6 .env =="
if [ -f "$PIPELINE_DIR/.env" ]; then
  echo "  · 기존 .env 유지: $PIPELINE_DIR/.env"
else
  cp "$PIPELINE_DIR/env.example" "$PIPELINE_DIR/.env"
  # PIPELINE_ROOT 를 실제 경로로 고정 (공백·한글 경로 안전)
  python3 - "$PIPELINE_DIR/.env" "$ROOT" <<'PY' 2>/dev/null || true
import sys, pathlib
path, root = sys.argv[1], sys.argv[2]
p = pathlib.Path(path)
lines = p.read_text(encoding="utf-8").splitlines()
for i, line in enumerate(lines):
    if line.strip().startswith("PIPELINE_ROOT="):
        lines[i] = "PIPELINE_ROOT=" + root
        break
p.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
  echo "  ✓ .env 생성 — API 키(ANTHROPIC/OPENAI/GEMINI)를 채우세요"
fi

if [ "$WITH_LOCAL_ASR" = "1" ]; then
  echo "== 4/6 로컬 전사(whisperx) =="
  if command -v python3 >/dev/null 2>&1; then
    python3 -m venv "$PIPELINE_DIR/.venv" >/dev/null 2>&1 || true
    if [ -x "$PIPELINE_DIR/.venv/bin/pip" ]; then
      "$PIPELINE_DIR/.venv/bin/pip" install -q -U whisperx
      ln -sf "$PIPELINE_DIR/.venv/bin/whisperx" /usr/local/bin/whisperx 2>/dev/null || \
        echo "  · PATH 에 $PIPELINE_DIR/.venv/bin 을 추가하면 whisperx를 씁니다"
      echo "  ✓ whisperx 설치 (통화 원본이 외부로 나가지 않습니다)"
    fi
  else
    echo "  · python3 없음 — whisperx를 건너뜁니다"
  fi
else
  echo "== 4/6 로컬 전사 — 건너뜀 (--with-local-asr 로 설치) =="
fi

echo "== 5/6 launchd =="
if [ "$WITH_LAUNCHD" = "1" ]; then
  node "$PIPELINE_DIR/scripts/install-launchd.mjs" --root "$ROOT"
else
  echo "  · --no-launchd: 건너뜀"
fi

echo "== 6/6 doctor =="
node --import tsx "$PIPELINE_DIR/src/cli.ts" doctor --root "$ROOT" || true

cat <<'NEXT'

다음 단계
  1) .env 에 API 키를 채웁니다 (없어도 dry-run은 동작)
  2) 아이폰: 통화 녹음 → 파일 앱에서 오디오만 위 inbox 폴더로 저장
  3) 시험:   npm run call-shorts -- dry-run --render
  4) 첫 실행: npm run call-shorts -- run-once
  5) 맥이 잠자기 상태면 launchd가 못 돕니다: 시스템 설정 > 배터리 > '잠자기 방지' 또는
     'sudo pmset repeat wakeorpoweron MTWRFSU 07:25:00' 로 아침에 깨우세요.
  6) launchd가 inbox를 읽으려면 '전체 디스크 접근 권한'이 필요할 수 있습니다:
     시스템 설정 > 개인정보 보호 및 보안 > 전체 디스크 접근 권한 > /usr/bin/osascript 및 node 추가
NEXT
