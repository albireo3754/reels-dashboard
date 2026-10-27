"""편집 요소의 좌표 옵션과 요청 기록. 파싱 기본형은 shared.cli를 사용한다."""
from pathlib import Path
from reels_editor.shared.cli import finite_ratio, offset_ratio

POSITION_KEYS = ('align', 'x', 'y', 'place_x', 'place_y', 'offset_x', 'offset_y',
                 'place_offset_x', 'place_offset_y', 'hook_offset_x', 'hook_offset_y')

def add_position_arguments(parser):
    group = parser.add_argument_group('배치 (투명 패딩 제외, 화면 비율)')
    group.add_argument('--align', choices=('center', 'left'),
                       help='주 요소 정렬. 썸네일·lower-left는 left, 영상 기본 핀·바는 center')
    group.add_argument('--x', type=finite_ratio,
                       help='주 요소 가로 기준점: center는 중심(기본 0.5), left는 왼쪽(썸네일 기본 0.07, 영상 0.055)')
    group.add_argument('--y', type=finite_ratio,
                       help='주 요소 표시 영역의 세로 중심. 생략하면 기존 템플릿 높이 유지')
    group.add_argument('--place-x', type=finite_ratio,
                       help='장소 핀/장소 안내 묶음 중심 x. 모든 표준 템플릿 공통 (같은 대상의 --x와 동시 지정 불가)')
    group.add_argument('--place-y', type=finite_ratio,
                       help='별도 장소 핀 중심 y. 생략한 축은 템플릿 값 유지')
    group.add_argument('--offset-x', type=offset_ratio, default=0,
                       help='기본값/명시 좌표 적용 후 전체를 이동. +오른쪽, -왼쪽; 0.02 = 화면폭 2%%')
    group.add_argument('--offset-y', type=offset_ratio, default=0,
                       help='기본값/명시 좌표 적용 후 전체를 이동. +아래, -위; 0.02 = 화면높이 2%%')
    for target, label in [('place', '장소 안내 묶음'), ('hook', '훅·서명 묶음')]:
        group.add_argument(f'--{target}-offset-x', type=offset_ratio, default=0,
                           help=f'{label}만 화면폭 비율로 이동 (+오른쪽)')
        group.add_argument(f'--{target}-offset-y', type=offset_ratio, default=0,
                           help=f'{label}만 화면높이 비율로 이동 (+아래)')
    group.add_argument('--dry-run', action='store_true',
                       help='배치만 계산해 JSON 출력. 출력 영상/이미지/manifest는 쓰지 않음')
    group.add_argument('--preview', type=Path,
                       help='배치 미리보기 PNG 경로 (영상: 투명 오버레이, 썸네일: 선택 프레임). dry-run과 함께 사용 가능')

def position_request(args):
    return {key: getattr(args, key) for key in POSITION_KEYS}
