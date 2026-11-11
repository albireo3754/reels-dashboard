"""Evaluate only the enable expressions emitted by the existing editor engine."""
import math
import re

NUMBER = r'(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?'

def enable_intervals(expression):
    if expression is None:
        return None
    cue = re.fullmatch(r'gte\(round\(t\*1000000\),(\d+)\)\*lt\(round\(t\*1000000\),(\d+)\)', expression)
    if cue:
        return [dict(start=int(cue[1])/1_000_000, end=int(cue[2])/1_000_000, inclusive=False, rounded=True)]
    clauses = re.split(r'(?<=\))\+', expression)
    results = []
    for clause in clauses:
        interval = re.fullmatch(rf'between\(t,({NUMBER}),({NUMBER})\)', clause)
        ending = re.fullmatch(rf'gte\(t,({NUMBER})\)', clause)
        if interval:
            results.append(dict(start=float(interval[1]), end=float(interval[2]), inclusive=True, rounded=False))
        elif ending:
            results.append(dict(start=float(ending[1]), end=None, inclusive=True, rounded=False))
        else:
            raise ValueError(f'Unsupported generated enable expression: {expression}')
    return results

def enable_at(expression, time):
    if not isinstance(time, (int, float)) or isinstance(time, bool) or not math.isfinite(time):
        raise ValueError('Preview time must be finite')
    intervals = enable_intervals(expression)
    if intervals is None:
        return True
    for interval in intervals:
        tick = math.floor(time*1_000_000+.5)/1_000_000 if interval['rounded'] else time
        end = interval['end']
        if tick >= interval['start'] and (end is None or (tick <= end if interval['inclusive'] else tick < end)):
            return True
    return False

__all__ = ['enable_at', 'enable_intervals']
