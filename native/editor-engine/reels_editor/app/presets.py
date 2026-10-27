"""번호로 선택하는 제작 바로가기. 숫자는 재정렬하지 않고 고정 식별자로 유지한다."""
from dataclasses import dataclass


@dataclass(frozen=True)
class Preset:
    number: str
    name: str
    target: str
    defaults: tuple[str, ...]
    example: str
    note: str
    version: int = 1

    def record(self):
        return {'number': self.number, 'name': self.name, 'version': self.version,
                'target': self.target, 'defaults': list(self.defaults), 'note': self.note}


PRESETS = {
    '1': Preset('1', '장소 핀 영상', 'video', ('--template', 'shimbashi-pin-only'),
                "1 input.mov '서울' -o pin.mp4", '영상 기본 구성: 장소 핀만, 서명 없음'),
    '2': Preset('2', '장소 핀 + 설명 테이프', 'video',
                ('--template', 'shimbashi-pin-banner', '--banner-material', 'tape'),
                "2 input.mov '서울' --description '함께 걷는 가을 산책' -o tape.mp4",
                '올공에서 확정한 명조체·아이보리·종이 테이프 v2, 촬영일 자동 추가 없음'),
    '3': Preset('3', '장소 핀 + 설명 사각 바', 'video',
                ('--template', 'shimbashi-pin-banner', '--banner-material', 'rectangle'),
                "3 input.mov '서울' --description '함께 걷는 가을 산책' -o bar.mp4",
                '고딕체·흰 글씨·검은 사각 바 대안, 올공 최신 확정 테이프와 구분'),
    '4': Preset('4', '썸네일 · 문구 폭 자동 크기', 'thumbnail',
                ('--template', 'rosy-auto', '--t', '0'),
                "4 input.mov cover.png --place '서울' --hook '함께 걷는|가을 산책'",
                '최대185px에서 긴 줄 폭에 맞춰 두 줄 같은 크기. 왼쪽7%·중앙 핀, 첫 프레임', version=2),
    '5': Preset('5', '썸네일 · 185px 고정 (기존 번호)', 'thumbnail',
                ('--template', 'rosy-large', '--t', '0'),
                "5 input.mov cover.png --place '서울' --hook '함께 걷는|가을 산책'",
                '2160폭 기준 185px, 표지 배치는 4번과 동일. 기본 배경은 첫 프레임'),
}
