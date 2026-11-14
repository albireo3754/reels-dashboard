# OpenCut 자막 소개 템플릿

여행·맛집 촬영본과 블로그 원고를 바탕으로 컷·자막 입력을 만들고, 같은 스타일로 OpenCut 프로젝트를 구성한다. 상단 소개와 장소명, 한두 줄 본문 자막, 선택한 부가정보를 분리하며 무음·1080×1920·30fps를 기본으로 한다. 정지사진은 한 컷 최대 3초다.

| `recipe.templateId` | 배치 |
| --- | --- |
| `travel-caption-v1` | 처음부터 끝까지 소개·장소명을 상단에 고정한다. |
| `food-focus-v1` | 시작·끝 각 3초에 소개·장소를 표시한다(전체 6초 이하는 계속 표시). 중간은 상단을 비우고 아래쪽에 본문·부가정보를 모은다. |

`food-focus-v1`을 사용할 때는 처음과 끝에 장소를 보여줄 컷을 배치한다. 타임라인과 자막 문안은 프리셋 선택으로 바뀌지 않는다.

## 제작 흐름

1. Dashboard의 기존 소재 프로젝트에서 촬영본과 블로그 원고를 연결한다.
2. 에이전트가 원고의 확인된 경험과 촬영본을 읽고 아래 요청 JSON을 만든다. 원본 구간 선택·문장 압축은 이 단계의 작업이다. 작성자가 수정한 문구는 보존한다.
3. `npm run opencut:prepare -- /absolute/request.json`을 실행한다. 실행 중 Dashboard의 기존 API와 등록 자료 접근 검증을 사용한다. 앱 재시작은 필요 없다.
4. 새 출력 폴더에는 검증된 미디어 사본, `recipe.json`, `captions.srt`, `template.json`, 원고 해시를 기록한 `manifest.json`, `apply-opencut.js`, 사용법이 생성된다. 패키지는 해당 Dashboard 프로젝트의 자료로 등록된다.
5. OpenCut에서 소재별 프로젝트를 열고 미디어를 가져온다. 처음에는 사용할 유형의 영상·사진과 기본 텍스트 요소를 하나씩 넣어 기본 구조를 만든다. 기존 프로젝트 수정은 먼저 백업한다.
6. 편집기 탭에서 `apply-opencut.js`를 Playwright로 실행한다. 스크립트가 프로젝트 목록으로 이동해 v28 구조·실제 미디어·원본 구간을 검사한 후 현재 대상 프로젝트를 갱신한다. 반환된 `before`와 `project`를 로컬 백업으로 보존한다.
7. 시험 출력→전체 출력·검수→같은 Dashboard 프로젝트에 MP4 연결 순서로 마친다. 무자막 출력을 위해 트랙을 뺐다면 작업 후 자막 프로젝트로 복원한다.

## 요청 형식

```json
{
  "projectId": "content:restaurant",
  "blogPath": "/absolute/linked/article.markup.md",
  "destination": "/absolute/new-package-directory",
  "sources": ["/absolute/linked/door.jpg", "/absolute/linked/toast.mov"],
  "recipe": {
    "templateId": "travel-caption-v1",
    "title": "동네에서 가볍게 한 잔",
    "place": "가게 이름",
    "cuts": [
      {"file": "door.jpg", "length": 2.5, "scale": 1.334},
      {"file": "toast.mov", "sourceIn": 1.4, "length": 4, "rate": 0.6}
    ],
    "captions": [
      {"start": 0, "end": 2.5, "text": "확인한 방문 경험을\n짧게 소개해요."},
      {"start": 2.5, "end": 6.5, "text": "함께한 사람들과\n건배!"}
    ],
    "notes": []
  }
}
```

`length`는 결과 영상에서의 초 단위 길이다. `rate:0.6, length:4`는 원본2.4초를 사용한다. 자막 시간은 결과 영상 기준이며 컷 전환과 독립적이다. `scale`, `x`, `y`는 실제 피사체·얼굴을 보며 정한다. 사진에 임의의 움직임을 만드는 기능은 포함하지 않는다.

## 범위와 복구

- UI에 새 자동편집 버튼을 추가한 것이 아니다. 기존 Dashboard의 자료 관리에 연결되는 로컬 제작 명령이다. 블로그를 자동 요약하거나 실제 화면을 보지 않고 메뉴를 추정하지 않는다.
- 미등록 원고·촬영본, 중복 파일명, 기존 출력 폴더 덮어쓰기를 거부한다. OpenCut 적용 전에 실제 미디어의 길이·중복·버전과 기본 요소를 검사한다.
- 작성 도중 원고가 바뀌면 자동 등록을 중단한다. 생성 실패나 등록 타임아웃 후에는 이미 만들어진 폴더와 Dashboard를 확인하며, 쓰기를 자동 재시도하지 않는다.
- 등록할 때 최신 Dashboard revision을 읽고 기존 문안·게시 상태·자료를 보존한다. OpenCut ID를 내부 `production.edits`의 video ID로 위장하지 않는다.
- OpenCut 프로젝트는 브라우저별 저장소에 있다. JSON은 복원 근거이며 공식 import 파일이 아니다. 다른 브라우저에서 미디어가 자동 복구된다고 보장하지 않는다.
- 현재 OpenCut SDR 출력의 색과 실제 읽기 속도는 콘텐츠마다 확인한다. 자동 게시·iCloud 전달은 하지 않는다.

## 검증

2026-11-12: 타입 검사·FSD 검사·desktop build 통과. 관련 단위9개 통과(내용·미디어 교체 시 이전 값 제거, 슬로모션 원본 구간 계산, 독립 자막, 브라우저용 함수 실행, 버전·원본 범위·중복·정지사진 길이 거부, 등록 자료 복사와 기존 프로젝트 보존).

실행 중 Dashboard에서 원고·촬영본으로 패키지 준비 및 자료 등록을 확인하고, 생성된 스크립트로 OpenCut 프로젝트를 갱신해 MP4를 출력했다. 개인 영상·원고·원본 경로·검수 기록은 콘텐츠 작업공간에만 둔다.
