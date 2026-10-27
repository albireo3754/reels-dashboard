"""Evaluate only the enable expressions emitted by the existing editor engine."""
import math
import re

NUMBER = r'(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?'

def enable_at(expression, time):
    if not isinstance(time, (int, float)) or isinstance(time, bool) or not math.isfinite(time):
        raise ValueError('Preview time must be finite')
    if expression is None:
        return True
    cue = re.fullmatch(r'gte\(round\(t\*1000000\),(\d+)\)\*lt\(round\(t\*1000000\),(\d+)\)', expression)
    if cue:
        # FFmpeg round uses ties away from zero; timestamps are nonnegative.
        tick = math.floor(time * 1_000_000 + .5)
        return int(cue[1]) <= tick < int(cue[2])
    clauses = re.split(r'(?<=\))\+', expression)
    results = []
    for clause in clauses:
        interval = re.fullmatch(rf'between\(t,({NUMBER}),({NUMBER})\)', clause)
        ending = re.fullmatch(rf'gte\(t,({NUMBER})\)', clause)
        if interval:
            results.append(float(interval[1]) <= time <= float(interval[2]))
        elif ending:
            results.append(time >= float(ending[1]))
        else:
            raise ValueError(f'Unsupported generated enable expression: {expression}')
    return any(results)

__all__ = ['enable_at']
