# 로컬 전사·회의록

Desktop 앱에서 대시보드 상단의 **전사·회의록**을 열면 음성 전사, 전사 원문으로부터의 회의록 작성을 사용할 수 있다. OpenAI와 Claude의 API 크레딧 잔액은 데스크톱 앱의 왼쪽 사이드바 하단에서 모든 탭에 표시한다. 데모와 공유 웹/Sites에는 표시하지 않는다. 여기서 입력한 음성·텍스트·결과는 프로젝트, 공유 스냅샷, 실행 로그에 저장하지 않는다. 탭을 떠나기 전에 필요한 결과는 복사한다.

- **전사:** 원본을 고른 뒤 로컬 FFmpeg/FFprobe로 2시간 이내 음성 트랙만 꺼내고 메타데이터·영상·원본 파일명을 제거한다. OpenAI 공식 Audio Transcriptions API의 `gpt-transcribe`에 발음을 해석할 짧은 참고 맥락을 넣고 JSON 전사문만 읽는다. 공개 요금은 분당 $0.0045이지만, 로컬에서는 분당 $0.006으로 올림 예약한다. 이 값은 청구 영수증이 아니다. Claude에 음성을 보내지 않는다. 사용할 수 없으면 다른 방법으로 전사한 텍스트를 붙여넣는다.
- **회의록:** 입력한 맥락과 전사본만 대상으로 OpenAI Responses API → Claude Messages API를 시도한다. 도구 호출·검색 없이 한국어로 정리한다. 두 경로를 사용할 수 없고 사용자에게서 이번 입력의 전송 및 fallback 동의를 받은 경우, 이 앱의 기존 격리 패턴으로 **Codex 로그인 세션**에 텍스트만 전달한다. API 키를 자식 프로세스에 전달하지 않는다. Codex 경로는 기존 구독 세션의 사용 한도/과금 규칙을 따르며, 이 화면에 표시한 API 혜택 크레딧을 쓰는 게 아니다. Claude Code의 구독 로그인으로 자동 우회하지 않는다.
- 원본에 사적인 대화가 포함되면 해당 제공자로 보낼 권한이 있는지 먼저 확인한다. 공급자가 제공하는 저장/데이터 처리 정책은 앱이 변경하지 않는다.

## 기존 키 연결

기본으로 외부 API 호출은 꺼져 있다. 키는 Electron 메인에서만 참조하고 렌더러, 코드·문서, 공유본 및 저널에는 쓰지 않는다.

1. **구독 혜택이 실제로 들어온 공식 API 조직의 기존 키**인지 먼저 확인한다. OpenAI는 프로젝트 키(`OPENAI_API_KEY`, `sk-proj-`), Claude는 워크스페이스에 연결된 Console API 키(`ANTHROPIC_API_KEY`, `sk-ant-`)가 필요하다. 구독 로그인이 API 키를 대신하지 않는다. 호환 프록시용 키와 Claude OAuth 토큰을 사용하지 않는다.
2. 앱 프로세스의 기존 환경변수로 주거나, **이미 안전하게 관리되는** 소유자 전용 dotenv를 `REELS_MEETING_CREDENTIALS_FILE` 절대 경로로 가리킨다. 또는 앱에 상속된 키가 없는 제공자는 `~/.config/reels-dashboard/meeting-credentials.env`를 참조한다. 파일 모드는 `0600`이고 일반 파일이어야 하며 심볼릭 링크나 저장소 안에 비밀 파일을 두지 않는다. 파일을 명시하면 환경변수로 자동 우회하지 않는다. 호환 API 주소가 설정돼 있으면 공식 API로 그 키를 재전송하지 않는다.
3. 정확한 조직/크레딧과 아래 조건을 모두 확인한 경우에 한해 앱 프로세스에 `REELS_MEETING_API_ENABLED=1`을 주고 시작한다. 이 값은 도구가 자동으로 바꾸지 않는다. 예: 기존 private dotenv에 대한 경로와 켜기 값을 앱을 시작하는 프로세스에만 지정한다. **설정만으로 잔액을 조회하지 않는다.**

## 잔액 관측값과 10% 예비분

각 사의 공개 Usage/Costs API는 사용 또는 비용 집계이고, 개인 구독으로 받은 **특정 무료 크레딧의 현재 잔액**은 일반 키로 조회할 수 없다. 따라서 임의의 구독 요금(`$100`)을 잔액으로 표시하지 않는다. 잔액 미입력·기한 만료·입력 8일 경과(주 1회 콘솔 갱신 기준)·잘못된 저널에는 **잔액 확인 안 됨 / 호출 꺼짐**을 표시한다.

운영자가 해당 API 조직의 혜택 잔액과 만료를 **직접 확인**한 경우, 앱 로컬 프로필(Electron `userData` 또는 `REELS_USER_DATA`) 안의 소유자 전용 `meeting-credit-observations.json`(`0600`)에 관측을 넣을 수 있다. 아래 이름과 필드만 예시이며 실제 지급/잔액이 아니다.

```json
{
  "openai": {
    "observedAt": "2026-11-22T12:00:00Z",
    "expiresAt": "2026-12-12T00:00:00Z",
    "totalUsd": 100,
    "remainingUsd": 64.30,
    "exclusiveSpend": false
  },
  "claude": {
    "observedAt": "2026-11-22T12:00:00Z",
    "expiresAt": "2026-12-12T00:00:00Z",
    "totalUsd": 100,
    "remainingUsd": 45.15,
    "exclusiveSpend": false
  }
}
```

- `exclusiveSpend`는 **이 관측 뒤 해당 크레딧에서 앱 이외의 사용이 확실히 없을 때만** true로 설정한다. Paseo/다른 도구와 같은 조직 크레딧을 동시에 쓰면 false를 유지한다. 잘못된 관측, 다른 서비스에서의 차감, 공급자 처리 지연/요금 변경에는 무과금 보장을 할 수 없다. 진행 중이거나 정산되지 않은 작업이 있을 때 관측을 갱신하지 않는다.
- 요청 직전 각 모델에 대한 보수적 예상 비용을 앱 전용 저널(`0600`)에 예약한다. 요청 후 예상 잔액이 총량의 10% 이하라면 보내지 않는다. 요청이 성공하고 응답에 `usage`(전사 길이 또는 입력·출력 토큰)가 확인되면 같은 예약 ID로 실제 추정 비용을 즉시 정산(`settle`)해 과다 예약 차액을 반영한다. API 오류 등으로 실제 청구 여부를 모르면 예약을 환불해주지 않는다. 작업별로 중복 호출을 자동 재시도하지 않는다.
- 최초 입력값은 **입력한 잔액**, 앱 예약 차감 후에는 **로컬 추정**이라고 표시한다. 이 표시는 조직 전체 비용/실시간 잔액, 정산 영수증이 아니다. 카드 결제, 충전 및 청구 설정을 변경하지 않는다.

## 참고

- [OpenAI 개인 구독 API 혜택](https://help.openai.com/en/articles/20001626-api-credits-benefit-for-eligible-chatgpt-subscriptions), [Audio Transcriptions](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create), [GPT-Transcribe 모델·요금](https://developers.openai.com/api/docs/models/gpt-transcribe).
- [Claude 개인 구독 API 혜택](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers), [Messages API](https://platform.claude.com/docs/en/api/messages/create), [요금](https://platform.claude.com/docs/en/about-claude/pricing).
- [Codex 인증](https://learn.chatgpt.com/docs/auth), [Claude Code 인증 및 용도 제한](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

이 연결은 SDK와 같은 공식 HTTPS API를 Node 내장 HTTP 클라이언트로 호출한다. SDK 패키지는 이 환경에서 내려받을 수 없었고, 기존 Codex 구독 경로에는 프로젝트의 이미 설치된 CLI를 재사용한다.
