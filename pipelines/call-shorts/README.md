# 여친 탐구생활 — 통화 → 손그림 숏폼 파이프라인 (TypeScript)

밤에 아무것도 안 하고, 아침에 맥이 혼자 한 편을 만들어 두는 배치 파이프라인입니다.
아이폰 통화 녹음 파일을 iCloud Drive `inbox/`에 떨어뜨리면 다음 단계를 거쳐
1080×1920 세로 숏폼(`short.mp4`)과 업로드용 메타데이터까지 만듭니다.

```
inbox 감시 → (해시 멱등성) → ffmpeg 정규화 → 전사·화자분리
  → 기획(Claude) → 대본 JSON(GPT) → 손그림 컷 이미지(Gemini/GPT Image)
  → ffmpeg 렌더(자막·모션·덕킹) → publish/{meta.json, checklist.md}
```

업로드는 **자동화하지 않습니다**. 파이프라인의 끝은 `알림 → 1분 검수 → 수동 업로드`입니다.

> 이 디렉터리는 `packages/`·`src/`와 독립된 Node CLI입니다. 레포의 TypeScript/ESM 규칙을 따르고,
> 테스트는 레포와 같은 `node --test` + `tsx`를 씁니다.

---

## 1. 빠른 시작

```bash
# 1) 의존성 (레포 루트)
npm ci

# 2) ffmpeg
brew install ffmpeg

# 3) 설치 + launchd 등록 (iCloud 폴더·.env 생성, 07:30 자동 실행)
bash pipelines/call-shorts/scripts/setup-mac.sh

# 4) API 키 채우기
open pipelines/call-shorts/.env     # ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY

# 5) 키 없이 전 과정 시험 (mock 전사·mock 이미지 + 실제 ffmpeg 렌더)
npm run call-shorts -- dry-run --render

# 6) 실제 실행
npm run call-shorts -- run-once
```

`doctor`가 ffmpeg·키·폴더·DB를 한 번에 점검합니다.

```bash
npm run call-shorts -- doctor
```

## 2. 명령

| 명령 | 설명 |
|---|---|
| `run-once` | inbox를 한 번 스캔해 새 통화 1건 처리 (`--file <경로>`, `--limit N`, `--force`) |
| `watch` | inbox 폴링 감시 (launchd 없이) |
| `dry-run` | 네트워크·비용 없이 mock으로 전 과정 (`--render`면 렌더까지 실제 실행) |
| `resume` | 멈춘 프로젝트를 이어서 (`--project <EP폴더> --stage <단계>`) |
| `map-speakers` | 화자 라벨을 여자/남자로 한 번만 지정 (`--a`/`--b` 는 `GF`\|`BF` 만, 서로 달라야 함) |
| `doctor` / `status` | 환경 점검 / 처리 이력·비용 |

```bash
npm run call-shorts -- status --json
npm run call-shorts -- map-speakers --project "<iCloud>/projects/2026-11-22_EP03" --a GF --b BF
npm run call-shorts -- resume --project "<iCloud>/projects/2026-11-22_EP03" --stage illustrate
```

## 3. 폴더 구조

```
~/Library/Mobile Documents/com~apple~CloudDocs/여친탐구생활/
├── inbox/            아이폰에서 오디오만 저장하는 곳 (여기만 폰이 건드림)
├── processed/        처리 끝난 원본 사본 (불변)
├── failed/           실패 원본 + error.log
├── projects/2026-11-22_EP03/{audio,transcript,plan,images,render,publish}
├── outbox/           업로드 직전 산출물 묶음
├── state/pipeline-state.json   해시·단계·비용·화자 매핑
├── logs/             pipeline.log(14일 보관), launchd.out/err.log
└── assets/{characters,sfx,bgm}
```

산출물:

| 파일 | 내용 |
|---|---|
| `render/short.mp4` | 1080×1920 · 30fps · h264 CRF18 · AAC 192k · -14 LUFS |
| `render/cover.png` | 0.6초 프레임 + 큰 훅 자막 |
| `render/captions.ass` / `.srt` | 화자별 색 자막 / 업로드용 자막 |
| `publish/meta.json` | 플랫폼별 제목·캡션·해시태그 5개, AI 라벨 판정·근거 |
| `publish/checklist.md` | 업로드 전 12항목 체크(실측값 포함) |

## 4. 단계별 규칙

### 4-1. inbox 감시 (`src/watcher.ts`)

1. `.m4a.icloud` 플레이스홀더는 건너뛰고 `brctl download`만 요청합니다 (아직 로컬에 없는 파일).
2. 파일 크기가 `STABLE_SECONDS`(기본 20초) 동안 변하지 않아야 시작합니다 (동기화 중 잘린 오디오 방지).
3. SHA-256 해시를 `state/pipeline-state.json`에 기록합니다. 이미 있으면 skip —
   같은 통화를 두 번 처리해 돈을 두 번 쓰는 사고가 이 파이프라인의 가장 흔한 사고입니다.
4. 처리 중에 프로세스가 죽어 `processing` 으로 남은 기록은 3시간이 지나면 자동으로 재시도하고,
   기다리지 않으려면 `run-once --force` 로 바로 다시 돌립니다(같은 프로젝트를 이어서 실행).
   `status` 는 그런 파일을 "처리 중 고착"으로 보여 줍니다.
5. `state.json` 이 깨져 JSON 해석에 실패하면 빈 상태로 덮어쓰지 않고 멈춥니다. 직전 정상 상태는
   `pipeline-state.json.bak` 에 남고, 손상 원본은 `.corrupt-<시각>` 으로 보관합니다.

### 4-2. 전사 (`src/transcribe.ts`)

```bash
ffmpeg -i call.m4a -ac 1 -ar 16000 -af "highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11" norm.wav
whisperx norm.wav --model large-v3 --language ko \
  --diarize --min_speakers 2 --max_speakers 2 --output_format json --output_dir transcript/
```

- 기본은 **로컬 whisperx + pyannote** (통화 원본이 외부로 나가지 않음, 무료).
- `TRANSCRIBE_BACKEND=gemini`는 빠르지만 원본이 외부로 나가고 타임스탬프 정밀도가 떨어집니다.
- 화자 라벨(`SPEAKER_00/01`)은 자동으로 성별을 알 수 없습니다. 매핑이 없으면 **멈추고**
  `map-speakers`를 안내합니다. 한 번 정하면 이후 자동입니다.
- `transcript/transcript.edited.md`를 만들면 기획·대본·검증기가 모두 그 편집본을 같은 원본으로 씁니다
  (원본 `diarized.json` 은 그대로 두고 발화만 편집본으로 바꿔 읽습니다 — 사람 검수 지점).

### 4-3. 기획·대본 (`src/scriptwriter.ts`)

- Claude: 감정선·코믹 포인트, **서로 다른 심리축의 훅 5개**(충격/공감/의문/숫자/배신), 회수 타임스탬프.
- GPT: `plan/episode.json`으로 강제 변환 (JSON schema strict).
- 검증기(`src/episode.ts`)가 다음을 확인하고, 실패하면 **1회만** 재생성합니다.
  - cuts 5~8개, 자막 중복 금지(컷마다 새 정보 1개)
  - 자막 한 줄 14자 이내·최대 2줄, 컷 길이 ≥ 글자수 ÷ 9자/초
  - 첫 컷 tStart=0, 컷이 끊김 없이 이어짐, 전체 25~55초
  - 첫 컷 `sourceRange`가 전사문의 실제 발화와 겹치고 자막이 그 발화 인용
  - `aiDisclosure` 3사 판정 + 근거, 해시태그 5개 이하
- 실명·회사명·연락처·주소는 `redactions`로 마스킹하고 로그에 남깁니다(원문은 transcript에만).

### 4-4. 이미지 (`src/illustrator.ts`)

- 캐릭터 시트를 먼저 만들고 **사람이 한 세트를 고정**합니다
  (`assets/characters/char_sheet_{girl,boy,style}.png`). 이후 모든 컷이 그 시트를 참조합니다.
- 프롬프트에 참조 이미지를 역할로 지목합니다: *the girl / the boy / line style*.
- AI 티 제거: 삐뚤한 선·칠 넘침·종이 그레인 + 후처리(회전 ±1.5°, 채도 -8%, 검정 #1A1A1A).
- **실사화 금지**: 실제 인물로 알아볼 수 있게 그리는 변형을 만들지 않습니다(가드레일 5).
- 실패 컷은 2회까지만 재생성합니다. 그 이상은 `visual.scene` 문장이 모호한 것입니다.

### 4-5. 렌더 (`src/renderer.ts`)

Remotion 대신 **FFmpeg + ASS**를 골랐습니다.
정지 이미지 + 자막 + 미세 모션이라 React 컴포넌트의 이점이 거의 없고,
한국어 자막 줄바꿈·화자별 색은 ASS가 정확하며, 렌더가 가장 빠릅니다(수십 초).
Node/Remotion 라이선스 조건도 피할 수 있습니다.

- 하드컷만(페이드 금지), 컷당 줌 100→104%, 회전 ±1.5°, 2프레임 지터(보일링)
- 자막: 여자 `#FF6B9D` / 남자 `#4FC3F7`, 흰 외곽선 3px, 하단 15.6%(안전 영역 12~18%)
- 훅 자막 0~3초 상단 고정, 펀치라인은 큰 손글씨
- BGM은 voice를 사이드체인으로 눌러 덕킹, 효과음 3개 이하
- 최종 `loudnorm -14 LUFS`, h264 + AAC, `+faststart`

### 4-6. 발행 (`src/publish.ts`)

`meta.json`에 플랫폼별 제목/캡션/해시태그 5개, 커버, SRT, **AI 라벨 판정 + 근거**를 남기고
`checklist.md`를 실측값(해상도·fps·라우드니스·자막 위치·마스킹)으로 채웁니다.
측정하지 못한 항목은 ✅ 가 아니라 `확인 필요`/`⚠️ 미측정` 으로 남기고, 마스킹 항목은
정규식 7종만 검사했는지 사용자 금지어(`REDACTION_TERMS`)까지 검사했는지 그대로 적습니다.
`outbox/`에 mp4·cover·srt·meta·checklist를 복사합니다.

## 5. AI 라벨 — 우리 포맷은 의무 대상이 아님

세 플랫폼의 기준은 **사실성(realism)** 하나입니다. 우리 콘텐츠는 손그림 일러스트 + 실제 통화 음성이라
YouTube·Instagram·TikTok 모두 라벨 의무 밖입니다(비사실적 애니메이션 예외).

- **의무가 되는 경우**: 얼굴을 실사처럼 그리기, AI 목소리로 다시 읽히기, AI BGM이 주된 요소.
- **하지 않는 것**: 메타데이터를 지워 라벨을 피하는 설계. 대신 설명·고정 댓글에
  `그림은 AI 생성(손그림 스타일), 목소리는 실제 통화 녹음입니다.` 한 줄을 남깁니다.
- 판정과 근거는 `publish/meta.json`의 `aiDisclosure`에 기록됩니다.

## 6. 비용·시간 (한 편, 8컷)

| 항목 | 시간 | 비용 |
|---|---|---|
| 전사·화자분리(10분 통화) | 2~4분 | 0원(로컬) |
| 기획·대본(Claude+GPT) | 40초 | ~$0.05 |
| 캐릭터 시트(최초 1회) | 3분 | $0.5~0.7 |
| 컷 이미지 8장 | 2~4분 | $0.27~$1.07 |
| 렌더 | 1~2분 | 0원 |
| **합계(2회차부터)** | **~9분** | **~$0.4** |

`DAILY_BUDGET_USD`/`MAX_IMAGE_USD`/`MAX_EPISODE_USD`를 넘으면 **멈추고** 알립니다.

## 7. 자동 실행 (launchd)

```bash
node pipelines/call-shorts/scripts/install-launchd.mjs --root "<iCloud>/여친탐구생활" --dry-run  # 미리보기
node pipelines/call-shorts/scripts/install-launchd.mjs --root "<iCloud>/여친탐구생활"            # 설치
node pipelines/call-shorts/scripts/install-launchd.mjs --uninstall                              # 해제
```

- 매일 **07:30** + `inbox/`에 파일이 생길 때 실행됩니다.
- 로그: `<루트>/logs/launchd.out.log` · `launchd.err.log`
- 맥이 잠자기면 실행되지 않습니다. `sudo pmset repeat wakeorpoweron MTWRFSU 07:25:00`로 깨우거나
  배터리 설정에서 잠자기를 막으세요.
- iCloud 폴더 접근이 막히면 **시스템 설정 → 개인정보 보호 및 보안 → 전체 디스크 접근 권한**에
  터미널(`node`)을 추가하세요.

## 8. 사람 손이 남는 지점 (자동화하지 않음)

1. `transcript.edited.md` — 오타·이름·민감정보 5분 수정 (영상 품질의 절반)
2. 캐릭터 시트 선택 — 후보 2세트 중 하나를 `assets/characters/`로 복사
3. **펀치라인 한 줄 다듬기** — 자동 대본 그대로면 밋밋하고, '비진짜 콘텐츠' 정책에도 불리합니다
4. 업로드 — 플랫폼 API 자동 업로드는 하지 않습니다

## 9. 동의 기록 (README에 남겨 두세요)

> 여자친구분 통화 녹음·활용 동의: 일시 `____-__-__`, 범위 `통화 녹음의 숏폼 제작·게시`,
> 철회 방법 `텍스트 한 통으로 중단, 이후 업로드 금지 및 기존 편 비공개`.
> 철회 시 `inbox`/`projects`의 해당 원본과 산출물을 함께 정리합니다.

에피소드가 늘수록 이 한 줄이 가장 중요해집니다. 동의 범위 밖(얼굴 노출, 실명 언급)은 만들지 않습니다.

## 10. 가드레일

1. inbox/처리 원본을 지우거나 고치지 않습니다 (복사 또는 설정된 `move`만).
2. 어디에도 자동 업로드하지 않습니다.
3. AI 라벨을 피하려고 메타데이터를 제거하지 않습니다 — 판정만 기록합니다.
4. 실명·회사명·연락처·주소는 대본/자막에서 마스킹합니다.
5. 인물을 실사처럼 그리는 프롬프트 변형을 만들지 않습니다.
6. 예산 초과 / 스키마 검증 실패 / 화자 매핑 미정 → **멈추고 보고**합니다.
7. 사람 검수 단계(편집 전사문·캐릭터 시트·업로드)를 건너뛰지 않습니다.

## 11. 문제 해결

| 증상 | 원인 | 처방 |
|---|---|---|
| `ffmpeg를 찾을 수 없습니다` | 미설치 | `brew install ffmpeg` |
| 컷마다 얼굴이 다름 | 참조 시트 미지정 | `assets/characters/`에 시트 3장 고정 |
| 자막이 늦거나 겹침 | 문장 단위로 자름 | whisperx 단어 타임스탬프 + 12~14자 분절 |
| 같은 통화를 두 번 처리 | 멱등성 없음 | 해시 skip (`state/pipeline-state.json`) |
| 잘린 오디오 전사 | 동기화 중 읽음 | `STABLE_SECONDS` 늘리기 (기본 20초) |
| `화자 매핑이 아직 없습니다` | 첫 실행 | `map-speakers --a GF --b BF` |
| `화자 ID는 GF(여자) 또는 BF(남자)만` | `--a`/`--b` 오타·한글 | `--a GF --b BF` (서로 달라야 함) |
| 영상에 아무 일도 없이 "새 통화 없음" | 처리 중 고착 | `status` 로 확인 후 `run-once --force` |
| `state 파일이 손상됐습니다` | iCloud 동기화 충돌·전원 손실 | `.bak` 복사로 되돌리고 손상 원본(`.corrupt-*`)은 보관 |
| 15초에서 이탈 | 중반 정보 없음 | 15초 지점에 반전·숫자 펀치 |

## 12. 테스트

```bash
npm run test:call-shorts

# macOS에서 기본 FFmpeg에 ass 필터가 빠져 있다면
brew install ffmpeg-full
FFMPEG_BIN="$(brew --prefix ffmpeg-full)/bin/ffmpeg" npm run test:call-shorts
```

실제 렌더 검사는 검은 배경에 자막이 찍힌 프레임과 MP4의 해상도·오디오·길이, 표지를 확인합니다. 로컬 기본 FFmpeg에 `ass` 필터가 없으면 이 검사만 사유와 함께 건너뜁니다. CI 또는 `FFMPEG_BIN`을 지정한 실행에서는 필터가 없으면 실패합니다.

테스트가 확인하는 것: 해시 멱등성, `.icloud` 필터, 크기 안정화, episode.json 검증 규칙,
화자별 ASS 색·안전 영역, 렌더 명령 조립, dry-run 전 과정, 마스킹, 예산 가드.

## 이미 동기화된 녹음: API 전사·검수만

`api-intake`는 이미 내려받은 로컬 파일을 **하나만** 받는 별도 경로다. 기존 기본 파이프라인, 감시·시작 프로그램, Apple Notes/iCloud 동기화는 변경하지 않는다. 음성을 FFmpeg로 정규화하고 메타데이터 및 파일명을 지운 다음, OpenAI `gpt-transcribe`에만 보내 한국어 전사를 한다. 이후 텍스트만 OpenAI로 검수하고, 조건이 맞지 않거나 실패하면 Claude 검수를 시도한다. Claude로는 원음이 전달되지 않는다. API 검수는 음성 대조가 아닌, 원문에서 확인되는 모호한 문구·불일치·비공개 정보 후보에 플래그를 붙이는 것이다. 인용은 원문과 일치해야 한다. 화자나 타임스탬프는 모델의 응답에 없으면 만들지 않는다.

파일 내용의 SHA-256으로 구분한 개인 로컬 폴더에 공급자의 전사 JSON을 수정 없이 `transcript.raw.json`, 별도 검수 결과를 `transcript.review.json`으로 저장하고 멈춘다. 출력 상태는 `needs-human-review`(종료 코드 3)이며 플래그가 비어 있어도 승인이 아니다. 대본·이미지·렌더·게시·자동 승인은 하지 않는다. 저장된 단계는 다시 호출하지 않는다. 검수용 크레딧만 부족했다면 같은 파일을 지정해 원문에서 이어갈 수 있다. 결과를 받기 전에 중단된 요청은 청구 여부를 알 수 없으므로 예약과 시도 표시를 남기고 해당 공급자로 자동 재시도하지 않는다.

### 운영자가 확인한 경우에만 켜기

기본은 꺼짐. 해당 음성 및 원문을 지정된 API 제공자에 보낼 권한과 계정별 공식 혜택을 확인한 경우에만 환경변수와 `--live`를 모두 지정한다.

```sh
CALL_SHORTS_API_ENABLED=1 npm run call-shorts -- api-intake --file /absolute/recording.m4a --live
```

- 기존 **공식 API 조직의** 프로젝트 키 `OPENAI_API_KEY`와 Claude Console 키 `ANTHROPIC_API_KEY`를 앱 환경에서 참조한다. 관리 중인 소유자 전용(0600) dotenv의 절대 경로는 `REELS_MEETING_CREDENTIALS_FILE`로 지정할 수 있다. 키가 앱 환경에 없고 파일을 지정하지 않으면 사용자 홈의 `.config/reels-dashboard/meeting-credentials.env`를 참조한다. 프록시 URL의 키·Claude Code 로그인 토큰은 받지 않고, 값은 로그·산출물·Git에 남기지 않는다.
- 로컬 상태의 기본 위치는 macOS의 개인 Application Support 아래 `Reels Dashboard/call-shorts-api`다. 필요하면 저장소·클라우드 동기화 밖의 소유자 전용(0700) 폴더를 `CALL_SHORTS_API_STATE_DIR` 절대 경로로 지정한다. 상태 폴더의 `credit-observations.json`(0600)에, 공식 콘솔에서 직접 확인한 제공자별 `observedAt`, `expiresAt`(ISO UTC 시각), `totalUsd`, `remainingUsd`, `exclusiveSpend`를 넣는다. 제공자 키 이름은 `openai`, `claude`다. 없는 잔액을 구독료로 가정하지 않는다.
- 이 경로 밖에서 해당 조직의 같은 혜택 크레딧을 동시에 차감하지 않는 경우만 `exclusiveSpend: true`를 쓰며, **동일 조직을 Desktop 전사, Paseo 또는 다른 앱에서 함께 쓴다면 false를 유지**한다. 지급 잔액 API는 연결하지 않는다. 24시간을 넘긴 관측이나 만료·부족한 잔액, 유효하지 않은 키를 사용하지 않는다. API 호출 전에 보수적 예상 비용을 예약해 예상 잔액이 10% 이하면 막는다. 이 값은 로컬 추정이며 공급자 청구·무료 사용 보장이 아니다. 미정산 요청이 있을 때 관측을 갱신하지 않는다.

## 대시보드에서 확인하기

Mac 앱의 왼쪽 **쇼츠** 탭에서 Apple 메모 연결 상태, 입력 폴더와 최근 처리 기록 10건을 확인합니다. Mac 앱을 열면 1분마다 메모의 **통화 녹음** 폴더를 확인합니다. Mac 메모에 동기화된 녹음 첨부를 기존 파이프라인 inbox로 복사하며, 아이폰에서는 전화 앱의 녹음 버튼만 누르면 됩니다. 앱을 꺼 둔 동안의 녹음도 다음 실행 때 확인합니다. macOS가 처음 메모 자동화 권한을 요청하면 Mac에서 허용합니다.

양쪽 기기에서 같은 iCloud 메모 계정을 사용해야 합니다. 폴더가 아직 없거나 접근이 거절되면 쇼츠 탭에 그 상태가 표시됩니다. 앱은 가져온 첨부의 ID를 로컬 프로필에 기록해 중복 복사를 막고, 다운로드되지 않은 오디오는 다음 확인 때 다시 시도합니다. 영상 제작은 기존 CLI 또는 등록된 launchd 작업에서 시작합니다.

## Mac 대시보드에서 메모 가져오기·로컬 전사

Mac Desktop의 **쇼츠 → 메모에서 가져오기**에서 제목 접두사를 확인하고 **최근 녹음 확인**을 누른다. 기본 'Call with '를 그대로 쓰거나 사람 이름을 덧붙여 범위를 더 좁힌다. 이미 이 Mac의 메모에 동기화된 녹음의 최신 최대 두 건을 시간과 로컬 다운로드 상태만 보여준다. 잠긴 메모나 휴지통, 이름이 비슷한 다른 첨부 파일은 제외한다. 조회는 Apple의 동기화를 켜거나 강제하지 않고, 기기와 iCloud 설정을 변경하지 않는다. 최신 항목이 아직 Mac에 없으면 다른 파일로 대신하지 않는다.

시간이 의도한 파일과 맞으면 **이 녹음 가져와 전사**를 눌러 임시 비공개 사본을 만든다. 이 동작은 이미 Mac에 설치된 MLX 전사 실행 환경과 캐시된 로컬 모델을 사용한다. 모델을 새로 받거나 API를 호출하지 않는다. 결과는 **Finder에서 전사 폴더 열기**로 확인할 수 있다. Electron의 로컬 프로필 아래 `call-shorts-notes`에 `통화녹음-…`의 TXT와 발화 구간 SRT를 저장한다. 화자를 추정해 이름으로 붙이지 않는다. 메모 원본, 기존 클라우드 iCloud inbox, 배경 스캔, 업로드/게시, API 전사 경로는 변경하지 않는다. 메모 본문과 계정 이름도 읽거나 저장하지 않는다.
