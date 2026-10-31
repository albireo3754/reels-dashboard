# OpenCut 조사와 필요한 기능 적용

2026-10-28. 사용자가 지정한 대상은 **OpenCut(opencut.app)**이에요. 이름이 비슷한 `ishandutta2007/open-capcut`도 확인했지만 별도 프로젝트이며 코드 반입 대상이 아니에요.

## 확인한 정본

| 대상 | 확인 결과 | 이번 판단 |
| --- | --- | --- |
| [OpenCut](https://github.com/OpenCut-app/OpenCut) | main `e668010778568641babef2cc40be4703ae6916d6`. 공식 README는 Rust core·plugin/API·MCP·headless를 포함하는 재작성을 진행 중이라고 안내해요. | 준비 중인 API를 이미 안정적으로 쓸 수 있는 라이브러리처럼 연결하지 않아요. |
| [OpenCut Classic](https://github.com/OpenCut-app/opencut-classic) | main `cf5e79e919144200294fb9fed22a222592a0aeea`, archived. 공식 README가 현재 사용 대상으로 안내하는 기존 구현이며 MIT license를 확인했어요. | 완성된 작은 기능과 상호작용을 선택해서 재사용할 수 있어요. |
| [동명에 가까운 open-capcut](https://github.com/ishandutta2007/open-capcut) | main `9c5116d279974d85a90acfac1ed142faf2ce4a7a`. 현재 `VideoEditor.tsx`는 파일 선택·object URL·video 재생 구현이에요. README의 AI 기능은 계획이며 MIT라고 적지만 LICENSE 파일은 coming soon이에요. | 현재 우리 앱에 추가할 실익이 적어 가져오지 않았어요. |

Classic은 Next·React·Zustand·Mediabunny와 자체 timeline/command/renderer 구조를 사용해요. UI 프레임워크가 React라는 이유만으로 전체 편집기를 작은 컴포넌트처럼 삽입할 수 있는 구조는 아니에요. 우리 앱의 Photos 연결·Python/FFmpeg 출력·확정 템플릿을 대체하려면 프로젝트와 렌더 모델까지 이관해야 하므로 이번 적용 범위로 삼지 않았어요.

근거: [Classic package.json](https://github.com/OpenCut-app/opencut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/package.json), [공식 변경 기록](https://opencut.app/changelog).

## 현재 제작 흐름에 맞춘 우선순위

| 후보 | 판단 |
| --- | --- |
| SRT 자막 파일 가져오기 | 현재 문구·시간을 한 줄씩 입력하는 작업을 줄이고 기존 captions 모델에 바로 연결할 수 있어 우선 적용했어요. |
| 자막 파일로 다시 저장 | 앱 밖의 편집기와 자막을 주고받을 수 있도록 SRT 저장을 함께 구현했어요. |
| 자막 구간 timeline·snapping | 다음 개선 후보예요. 현재 숫자 입력과 실제 재생 시각에 연결할 수 있지만 접근성과 드래그 중 경계·겹침 검증까지 필요해요. 이번에 구현했다고 주장하지 않아요. |
| undo/redo | 유용하지만 별도 진행 중인 MCP의 revision·dirty-state 보호와 같은 변경 이력을 사용하도록 설계해야 해요. UI만 과거 snapshot으로 되돌리는 방식은 보류해요. |
| 여러 클립·오디오 track·transition | 현재 단일-source 렌더 입력을 바꾸는 별도 확장이에요. 수입 코드만으로 기존 출력과 연결된 것처럼 보이게 하지 않아요. |
| 새 Rust core·MCP·headless | 공식 재작성 진행 상황과 실제 배포 API를 다시 확인한 뒤 검토해요. 현재 앱의 작동 중인 로컬 엔진과 병렬로 설치하지 않았어요. |

## 반영한 기능

`src/features/subtitle-files`에 독립 기능으로 추가했어요. Classic의 [SRT parser](https://github.com/OpenCut-app/opencut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/subtitles/srt.ts)의 block/timestamp 처리 방식을 가져오고, 앱에 맞게 아래를 보강했어요.

- UTF-8 SRT와 기본 평문 WebVTT를 읽어요. VTT 처리는 이 앱에서 추가한 기능이며 OpenCut의 VTT 지원을 주장하는 것이 아니에요.
- 적용 전 파일명·자막 수·시간·문구를 검토해요. 기존 자막이 있으면 교체 확인을 받아요.
- 잘못된 cue를 조용히 버리지 않아요. 겹침·시간 역전·영상 길이 초과·세 줄 이상·서식 태그 등은 전체 가져오기를 중단하고 기존 자막을 보존해요.
- 문구·시간만 교체하고 장소 안내 묶음·표지·현재 자막 크기와 위치는 유지해요.
- 파일을 읽는 동안 프로젝트나 revision/settings가 바뀌면 이전 파일의 적용을 막아요. 기존 저장·MCP 충돌 처리 경로를 그대로 사용해요.
- 현재 자막을 SRT로 내려받아요. 밀리초 형식으로 내보내며 반올림으로 길이가0이 되는 cue는 거부해요.
- 최대1MB·300개 cue·한두 줄 평문을 지원해요. ASS, VTT STYLE/REGION·position 속성, rich text·음성 인식은 이번 범위가 아니에요.

MIT 고지는 [THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.md)와 [전체 라이선스](../public/licenses/opencut-MIT.txt)에 보존했어요. 라이선스는 웹 dist와 앱 패키지에 함께 들어가요. 새 npm 의존성이나 외부 전송 API는 추가하지 않았어요.

## 검증

- 자막 parser/serializer 단위 테스트6개: BOM·CRLF·한글·VTT·NOTE·구간 경계·불량 파일 전체 거부·왕복 저장·밀리초 경계.
- Chromium UI 테스트3개: 검토 후 적용·스타일 유지·SRT 다운로드·저장/재시작, 기존 자막 교체 확인·오류 보존, 설정 변경 시 VTT 검토 무효화.
- 타입 검사와 FSD 의존성 검사.

실제 패키징 Electron 앱에서도 UTF-8 자막 파일 선택·적용·SRT 다운로드와 MIT 고지 포함을 확인하는 테스트1개가 통과했어요. 파일과 다운로드 경로는 임시 QA 폴더를 사용했고 개인 촬영본은 사용하지 않았어요. 이 기능은 자막 파일 I/O이며 OpenCut 전체 timeline이나 새 렌더 엔진을 통합한 것이 아니에요.
