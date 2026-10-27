"""기존 실행 경로를 기능별 공개 API에 연결하고 CLI 오류를 처리한다."""
import json
import sys
from .presets import PRESETS

from reels_editor.features.video_overlay import run as run_video
from reels_editor.features.thumbnail import run as run_thumbnail


def video_main(argv=None, *, preset=None):
    try:
        return run_video(argv, preset=preset)
    except (ValueError, RuntimeError) as exc:
        raise SystemExit(str(exc)) from None


def thumbnail_main(argv=None, *, preset=None):
    try:
        return run_thumbnail(argv, preset=preset)
    except (ValueError, RuntimeError) as exc:
        raise SystemExit(str(exc)) from None


def preset_main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if not args or args[0] in ('--list-presets', '--help', '-h'):
        if args and any(arg != '--json' for arg in args[1:]):
            raise SystemExit('목록 옵션에는 --json만 추가할 수 있습니다')
        if '--json' in args:
            print(json.dumps([preset.record() for preset in PRESETS.values()], ensure_ascii=False, indent=2))
        else:
            print('릴스 제작 프리셋 — 번호를 고른 뒤 입력과 문구를 지정하세요.')
            for preset in PRESETS.values():
                print(f'{preset.number}. {preset.name} — {preset.note}')
                print(f'   python scripts/reels.py {preset.example}')
            print('공통: --dry-run 좌표 확인 / --preview 경로.png 미리보기 / 번호 --help 상세 옵션')
            print('번호는 템플릿·재질을 고정합니다. 문구·위치·크기·영상 시점은 개별 옵션으로 조정하세요.')
        return 0
    number, *options = args
    if number not in PRESETS:
        raise SystemExit(f'알 수 없는 프리셋 번호 {number!r}. 1~5 또는 --list-presets를 사용하세요')
    preset = PRESETS[number]
    locked = {'--template', '--banner-material'}
    if any(option.split('=', 1)[0] in locked for option in options):
        raise SystemExit('프리셋 번호가 템플릿·재질을 지정합니다. --template/--banner-material 대신 번호를 선택하세요')
    if '--help' in options or '-h' in options:
        print(f'선택: {number}. {preset.name} — {preset.note}')
        print(f'예시: python scripts/reels.py {preset.example}')
        print('아래는 연결된 기존 CLI의 공통 옵션입니다. 위 프리셋 값이 먼저 적용됩니다.')
    command = video_main if preset.target == 'video' else thumbnail_main
    return command([*preset.defaults, *options], preset=preset.record())
