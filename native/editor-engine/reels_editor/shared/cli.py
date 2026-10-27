"""유한 비율 입력과 argparse 값 직렬화. 템플릿·묶음 규칙은 두지 않는다."""
from pathlib import Path

def finite_ratio(value: str) -> float:
    import argparse
    import math
    number = float(value)
    if not math.isfinite(number) or not 0 <= number <= 1:
        raise argparse.ArgumentTypeError('화면 비율은 0~1 사이의 유한한 수여야 합니다')
    return number

def offset_ratio(value: str) -> float:
    import argparse
    import math
    number = float(value)
    if not math.isfinite(number) or not -1 <= number <= 1:
        raise argparse.ArgumentTypeError('이동 비율은 -1~1 사이의 유한한 수여야 합니다')
    return number

def render_options(args):
    return {key: str(value) if isinstance(value, Path) else value
            for key, value in vars(args).items()
            if key not in ('input', 'video', 'output', 'dry_run', 'preview')}

__all__ = [
    'finite_ratio',
    'offset_ratio',
    'render_options',
]
