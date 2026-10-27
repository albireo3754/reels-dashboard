"""릴스 Python 패키지의 FSD 의존성과 공개 API를 AST로 검사한다."""
import ast
import importlib.util
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent / 'reels_editor'
RANK = {'shared': 0, 'entities': 1, 'features': 2, 'app': 3}
LEGACY = {'pin_overlay', 'make_thumbnail', 'reels_style', 'reels_elements', 'reels_layout', 'reels_cli'}


def unit(module):
    parts = module.split('.')
    if len(parts) < 2 or parts[1] not in RANK:
        return None
    if parts[1] in ('app', 'shared'):
        return tuple(parts[:2])
    return tuple(parts[:3])


def import_error(source, target):
    """반환값 None은 허용. 외부 슬라이스에는 공개 패키지까지만 접근한다."""
    if target.split('.')[0] in LEGACY:
        return '패키지에서 기존 진입점/어댑터를 역참조할 수 없습니다'
    if target == 'reels_editor':
        return '루트 namespace 대신 from 공개_API import 이름을 사용하세요'
    if not target.startswith('reels_editor.'):
        return None
    src, dst = unit(source), unit(target)
    if not src or not dst:
        return '명시된 FSD 계층/슬라이스를 사용하세요'
    if src == dst:
        return None
    if RANK[dst[1]] >= RANK[src[1]]:
        return '상위 계층 또는 같은 계층의 다른 슬라이스 의존입니다'
    depth = len(target.split('.'))
    if dst[1] in ('entities', 'features') and depth != 3:
        return '슬라이스의 __init__.py 공개 API를 사용하세요'
    if dst[1] == 'shared' and depth != 3:
        return 'Shared 세그먼트의 공개 모듈을 사용하세요'
    return None


def audit(package=PACKAGE):
    modules = {}
    for path in package.rglob('*.py'):
        rel = path.relative_to(package).with_suffix('')
        parts = list(rel.parts)
        if parts[-1] == '__init__':
            parts.pop()
        name = '.'.join([package.name, *parts])
        modules[name] = (path, ast.parse(path.read_text(encoding='utf-8')))
    exports = {}
    for name, (_, tree) in modules.items():
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == '__all__' for t in node.targets):
                exports[name] = set(ast.literal_eval(node.value))
    problems = []
    edges = {name: set() for name in modules}
    for source, (path, tree) in modules.items():
        package_name = source if path.name == '__init__.py' else source.rpartition('.')[0]
        for node in ast.walk(tree):
            imports = []
            if isinstance(node, ast.Import):
                imports = [(a.name, None, True) for a in node.names]
            elif isinstance(node, ast.ImportFrom):
                base = node.module or ''
                if node.level:
                    base = importlib.util.resolve_name('.'*node.level+base, package_name)
                for alias in node.names:
                    target = f'{base}.{alias.name}' if f'{base}.{alias.name}' in modules else base
                    imports.append((target, alias.name if target == base else None, target != base))
            elif isinstance(node, ast.Call) and (
                isinstance(node.func, ast.Name) and node.func.id == '__import__' or
                isinstance(node.func, ast.Attribute) and node.func.attr == 'import_module'):
                problems.append(f'{path}:{node.lineno}: 동적 import 대신 명시적 공개 API import를 사용하세요')
            for target, symbol, namespace in imports:
                reason = import_error(source, target)
                if not reason and namespace and target.startswith('reels_editor.') and unit(source) != unit(target):
                    reason = '다른 slice namespace 대신 from 공개_API import 이름을 사용하세요'
                if symbol == '*':
                    reason = 'wildcard import는 공개 범위를 숨깁니다'
                if reason:
                    problems.append(f'{path}:{node.lineno}: {target}: {reason}')
                if target in modules:
                    edges[source].add(target)
                if (target in modules and unit(source) != unit(target) and not reason
                        and symbol is not None and symbol not in exports.get(target, set())):
                    problems.append(f'{path}:{node.lineno}: {target}.{symbol}: __all__에 없는 비공개 이름입니다')
    # Package public APIs must explicitly declare their exports.
    for name, (path, _) in modules.items():
        parts = name.split('.')
        public = len(parts) == 3 and parts[1] in ('entities', 'features', 'shared')
        if (public or name == 'reels_editor.app') and name not in exports:
            problems.append(f'{path}: 공개 API __all__이 필요합니다')
    visiting, visited = set(), set()

    def visit(name):
        if name in visiting:
            problems.append(f'{modules[name][0]}: 순환 import가 있습니다')
            return
        if name in visited:
            return
        visiting.add(name)
        for target in edges[name]:
            visit(target)
        visiting.remove(name)
        visited.add(name)

    for name in modules:
        visit(name)
    return problems


if __name__ == '__main__':
    failures = audit()
    if failures:
        print('\n'.join(failures))
        raise SystemExit(1)
    print('FSD 의존성·공개 API·순환 참조 검사 통과')
