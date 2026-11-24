# 내장 스케줄러

데스크톱 앱 메인 프로세스 안에 작은 예약 실행기를 둔다. 정해 둔 시각에 Aside 브라우저 에이전트(`aside` CLI)에 일을 한 번 지시하고, 결과를 앱 기록과 대조해 판정한다. 앱은 늘 켜져 있지 않다(창을 닫으면 종료되고 맥은 잠든다). 그래서 이 스케줄러는 "그 시각에 깨어 있었는가"가 아니라 **"놓친 회차를 어떻게 다루는가"**를 계약으로 삼는다.

외부 서버(n8n, Temporal, Redis, launchd 대리 실행)는 쓰지 않는다. Aside 자체 예약(유료·개수 제한)도 쓰지 않는다. 예약의 소유는 이 앱이다. 새 의존성은 cron 시각 계산용 `croner` 하나다. 저장은 이미 쓰는 `node:sqlite`와 JSON 파일이다.

## 계약

- **회차당 한 번.** 회차 키는 `cron:<예정 시각 UTC ISO>` 또는 `manual:<runId>`다. `runs`의 기본키 `(schedule_id, occurrence_key)`와 `INSERT … ON CONFLICT DO NOTHING`으로 DB가 막는다. 같은 tick이 두 번 돌거나, dev 앱과 패키지 앱이 같은 프로필을 동시에 열어도 한 회차는 한 번만 생긴다.
- **스케줄당 동시 실행 1개, aside 실행은 앱 전체에서 1개.** partial unique index 두 개(`status='running'`인 `schedule_id`, `lock_key`)가 보장한다. 같은 스케줄이 이미 실행 중이면 새 회차는 `skipped/already-running`이다. 다른 스케줄이 aside 잠금을 쥐고 있으면 `pending`으로 남아 다음 tick에 다시 본다.
- **하루 상한.** 스케줄 시간대(기본 Asia/Seoul) 기준으로 그날 시작한 회차(`running·ok·partial·failed·interrupted`)가 `maxRunsPerDay`(기본 1) 이상이면 다음 회차는 `skipped/daily-limit`이다. **수동 실행도 센다.** 집계와 `pending → running` 전환은 같은 `BEGIN IMMEDIATE` 트랜잭션이라 두 인스턴스가 동시에 통과하지 못한다. 우회 옵션은 없다.
- **놓친 회차.** 가장 최근 1회만, 예정 시각에서 `catchUpWithinMinutes`(기본 300) 안이면 보정 실행한다. 나머지는 `missed`로 남긴다. 여러 날 꺼져 있었어도 몰아서 돌리지 않는다.
- **자동 재시도 없음.** `partial·failed·interrupted·skipped`는 같은 회차를 다시 돌리지 않는다(중복 댓글 위험). 예외는 실행 전 확인(preflight) 실패 하나다. 사이트에 아무것도 하지 않은 상태라 10분마다 다시 확인하고, 마감까지 안 되면 `blocked`로 끝낸다.
- **종료 코드 0은 성공이 아니다.** Aside CLI는 `unknown option`·`Session not found`도 종료 코드 0으로 끝낸 적이 있다. 판정은 아래 [판정](#판정) 순서를 모두 통과해야 `ok`다.
- **계정 단위 차단이면 스스로 멈춘다.** 결과의 `blocked.code`가 `login·captcha·restricted·account-mismatch`면 스케줄을 `enabled:false`로 바꾸고 `pausedReason`을 남긴 뒤 알림을 한 번 보낸다. 사용자가 원인을 해결하고 다시 켤 때까지 돌지 않는다.
- **알림에는 개인 정보를 넣지 않는다.** 스케줄 이름, 판정, 사유 코드, 건수만 쓴다. 블로그 ID, 글 주소, 댓글 본문은 넣지 않는다. `ok`는 알림 없이 기록만 남긴다.

## 파일과 설정

모두 공개 저장소 밖, 앱 프로필(`<userData>`, CLI의 `REELS_USER_DATA`와 같은 규칙) 아래에 있다. 디렉터리는 0700, 파일은 0600이다.

```
<userData>/scheduler/
  schedules.json      # 정의. 사람이 읽고 고칠 수 있다(zod strict). tick마다 mtime을 보고 다시 읽는다
  scheduler.sqlite    # 회차·실행 기록·catch-up 커서 (WAL, busy_timeout 5000, user_version 마이그레이션)
  runs/<runId>/
    handoff.md        # aside에 넘기는 실행별 인계 문서
    stdout.log        # aside 출력(stdout+stderr, 앞 5MB)
    result.json       # 판정, 사유, 대조 건수, 세션 ID, 파싱한 결과
```

`schedules.json` 예시(값은 예시다):

```json
{
  "version": 1,
  "schedules": [
    {
      "id": "blog-neighbor-loop",
      "name": "서로이웃 루프",
      "enabled": true,
      "trigger": { "type": "cron", "expr": "10 18 * * *", "timezone": "Asia/Seoul" },
      "misfire": { "catchUpWithinMinutes": 300 },
      "limits": { "timeoutMinutes": 45, "maxRunsPerDay": 1 },
      "action": {
        "kind": "aside",
        "skill": "blog-neighbor-loop",
        "params": { "expectedBlogId": "example-blog", "maxInspect": 15, "maxAccept": 5, "maxVisit": 5 }
      },
      "createdAt": "2026-11-25T00:00:00.000Z",
      "updatedAt": "2026-11-25T00:00:00.000Z"
    }
  ]
}
```

| 필드 | 규칙 |
| --- | --- |
| `id` | `^[a-z0-9-]{3,40}$`. 바꿀 수 없다. 새 id면 새 스케줄이다 |
| `trigger` | v1은 `cron` 하나. 5필드 cron 식과 IANA 시간대(기본 `Asia/Seoul`). 기본 식은 `10 18 * * *`(18:10, Aside 매시 정각 작업과 겹치지 않게 10분 늦춤) |
| `misfire.catchUpWithinMinutes` | 0~720, 기본 300. 0이면 정시 tick(2분 허용)에서만 실행 |
| `limits` | `timeoutMinutes` 1~120(기본 45), `maxRunsPerDay` 1~24(기본 1) |
| `action` | v1은 `aside` 하나. `skill`은 `^[a-z0-9-]{3,40}$`(경로 조각 불가), `hostProfile`·`model`은 선택, `params`는 키 20개 이하·문자열 200자 이하·숫자·불리언 |
| `pausedReason` | 앱이 스스로 멈췄을 때 남긴다. `enabled:true`로 다시 켜면 지워진다 |

- **실행 파일 경로는 설정으로 받지 않는다.** `aside`는 런타임에 `~/.local/bin/aside`로 정한다. 테스트·QA만 환경 변수 `REELS_ASIDE_BIN`으로 바꾼다. 설정 파일이나 MCP 입력에 `asideBin` 같은 키가 있으면 strict 검증에서 거절한다.
- 손으로 고친 `schedules.json`이 검증에 실패하면 직전 정의를 그대로 쓰고 `reels get-schedules`의 `fileError`로 알린다.
- 삭제는 없다. `enabled:false`로 끈다. 꺼져 있는 동안 커서는 계속 현재 시각으로 옮겨지므로 다시 켜도 꺼져 있던 날을 보정하지 않는다.

## tick과 놓친 회차 보정

`src/desktop/scheduler.ts`의 `Scheduler`가 tick을 돈다. 형태는 `WorkflowNotifications`와 같다(unref한 interval, 재진입 가드, `dispose()`).

| 언제 | 동작 |
| --- | --- |
| 앱 시작 | 10초 뒤 첫 tick |
| 평상시 | 60초마다 |
| `powerMonitor` `resume`·`unlock-screen` | 즉시 tick |
| `reels_set_schedule`·`reels_run_schedule_now` 뒤 | 즉시 tick |

tick 한 번은 회수 → timeout 검사 → 스케줄별 회차 계산 → 마감 지난 `pending` 종결 → dispatch 순서다. 잠자기 중에는 타이머가 멈추지만 tick은 늘 벽시계와 DB를 대조하므로 깨어난 직후 보정된다.

회차 계산은 순수 함수 `dueOccurrences(schedule, cursor, now)`(`src/features/scheduler/model/occurrences.ts`)다.

1. 커서가 없거나(첫 활성화) trigger(식·시간대) 해시가 바뀌었으면 커서를 now로 둔다. 만들기 전·바꾸기 전의 과거는 실행하지 않는다.
2. 시계가 5분 넘게 뒤로 가면 커서를 now로 당긴다. 같은 회차가 다시 나와도 기본키가 막는다.
3. `max(커서, now-7일)`부터 `croner`의 `nextRun`을 반복해 `커서 < t ≤ now`인 시각을 센다(최대 500개, 더 잦은 식이면 최근 구간을 다시 찾는다).
4. 가장 최근 시각이 마감(`t + catchUp`) 안이면 실행 회차로 넣는다. 2분 넘게 늦게 찾았으면 trigger가 `catchup`, 아니면 `cron`이다. 마감 밖이면 `missed/expired`다.
5. 그 밖의 시각은 `missed/superseded`로 최근 50개만 남긴다.
6. 회차 삽입과 커서 이동은 한 트랜잭션이다.

18:10 회차로 보면 이렇다.

| 앱 상태 | 결과 |
| --- | --- |
| 18:10에 켜져 있음 | 18:10 tick에서 `cron` 1회 |
| 17:00~19:30 꺼져 있다가 19:30에 켬 | 19:30에 `catchup` 1회 |
| 맥이 18:00~20:45 잠들었다가 깨어남 | 깨어난 즉시 `catchup` 1회 |
| 23:10 이후에 처음 켬 | `missed/expired`, 실행 없음 |
| 사흘 꺼져 있다가 사흘째 19:00에 켬 | 그날 1회 실행, 앞의 이틀은 `missed/superseded` |
| 오전에 수동 실행함 | 18:10 회차는 `skipped/daily-limit` |

## 실행, timeout, 회수

- **preflight.** `aside` 실행 파일이 있는지(`aside-missing`), Aside 사용자 스킬 `~/.aside/u/0/skills/user/<skill>/SKILL.md`가 있는지(`skill-missing`), `aside host profiles`에 `connected` 프로필이 있는지(`hostProfile`을 지정했으면 그 프로필, `host-disconnected`)를 본다. 실패하면 `pending`을 유지하고 사유를 적은 뒤 첫 실패 때 알림을 한 번 보낸다. 10분마다 다시 확인하고 마감까지 안 되면 `blocked`다.
- **실행.** `aside --permission full-access [--profile <id>] [-m <model>] exec "<프롬프트>"`. 전역 옵션은 서브커맨드 앞에 둔다(뒤에 두면 종료 코드 0으로 실패한다). 매번 새 세션이고 `session resume`은 쓰지 않는다. Finder에서 띄운 앱은 PATH가 최소라 `/opt/homebrew/bin:/usr/local/bin:~/.local/bin`을 앞에 붙인다. 프로세스는 detached 그룹으로 띄우고 실행 로그 화면(`source: scheduler`)에 보인다.
- **프롬프트와 인계 문서.** 저장소에는 일반 템플릿(`src/features/scheduler/model/handoff.ts`)만 있다. 프롬프트에는 스킬 이름과 인계 문서 경로만 들어간다. `params`(예상 블로그 ID, 상한 등)는 `<userData>` 안의 `handoff.md`로만 전달한다. 인계 문서에는 runId, 날짜, 트리거와 지연, 앱 기록 도구 경로(`REELS_USER_DATA`, `reels`), 허용 셸 명령, 결과 JSON 형식이 들어간다.
- **세션 ID.** 실행 직전과 실행 뒤 5초 간격 최대 60초 동안 `aside session list`를 비교해 새 ID가 정확히 1개일 때만 채택하고 바로 기록한다. 2개 이상이거나 못 찾으면 비워 두고 실행 기록에 남긴다. stdout은 파싱하지 않는다.
- **timeout.** tick이 `started_at + timeoutMinutes`를 넘긴 실행을 찾으면 프로세스 그룹에 SIGTERM, 10초 뒤 SIGKILL, 세션 ID가 있으면 `aside session stop <id>` 순서로 멈추고 `failed/timeout`으로 기록한다. 잠든 시간도 실행 시간에 들어간다.
- **앱 종료.** aside 실행 중에 종료하면 기존 "실행 중인 AI 작업이 있어요" 확인창이 뜬다. 종료를 고르면(또는 업데이트처럼 확인 없이 정리 단계로 가면) 종료 정리의 첫 단계 `scheduler.dispose()`가 timeout과 같은 순서로 멈추고 `interrupted/app-quit`으로 남긴다.
- **회수.** 매 tick에서 이 인스턴스가 띄우지 않은 `running` 행을 본다. `host_pid`가 살아 있고 시작 시각이 같으면 같은 프로필을 쓰는 다른 앱 인스턴스이므로 **건드리지 않는다.** host가 죽었으면: 자식 pid가 살아 있고 시작 시각이 같으면 그룹을 멈추고 세션도 멈춘 뒤 `interrupted/orphan-stopped`, pid가 재사용됐으면 그 프로세스는 건드리지 않고 `interrupted/pid-reused`, 자식도 없으면 세션을 멈추고 `interrupted/host-exited`다.
- **보존.** 스케줄마다 최근 200행, `missed·skipped`는 30일 뒤 지운다(하루 한 번).

## 판정

순수 함수 `judgeAsideRun`(`src/features/scheduler/model/verdict.ts`)이 아래 순서로 본다.

| 순서 | 조건 | 결과 |
| --- | --- | --- |
| 1 | signal로 끝났거나 종료 코드가 0이 아님 | `failed/exit` |
| 2 | 마지막 ```json 블록 **바깥** 출력에 `unknown option`·`Session not found`·`Chrome extension not connected`·`Operation not permitted` | `failed/cli-error` |
| 3 | 마지막 ```json 블록이 없음 / 파싱·핵심 키 검증 실패 | `failed/no-result` / `failed/schema` |
| 4 | `runId`가 이번 실행과 다름 | `failed/run-id-mismatch` |
| 5 | `blocked`가 있고 처리 건수(수락+방문+댓글+공감)가 0 | `failed/blocked:<code>` |
| 6 | `accountVerified`가 `true`가 아님 | `failed/account-unverified` |
| 7 | `blocked`가 있음 | `partial/blocked:<code>` |
| 8 | `records`가 `params.maxVisit`보다 많음 | `partial/over-limit` |
| 9 | `records[].postUrl`(앱과 같은 정규화)마다 앱 블로그 댓글 기록이 있고, `postedAt`이 실행 시작일 또는 종료일이며, note에 `[YYYY-MM-DD 루프]`가 있음. 하나라도 아니면 | `partial/record-mismatch` |
| 10 | `commented`가 대조를 통과한 기록 수와 다름 | `partial/count-mismatch` |
| 11 | 모두 통과 | `ok` |

결과 JSON은 핵심 키만 검증하고 모르는 키는 무시한다. 필수 키는 `runId`, `accountVerified`, `accepted·visited·commented·liked`(0 이상 정수), `records[]`, `blocked`(null 또는 `{code, detail≤200자}`, code는 `login|captcha|restricted|account-mismatch|app-offline|errors|other`)다. 받은 신청이 없어 처리 0건이어도 보고가 정상이면 `ok`다. 앱은 Aside의 보고와 앱 기록을 대조할 뿐, 네이버에 댓글이 실제로 올라갔는지 따로 확인하지는 않는다.

## 명령

모두 앱 프로세스가 처리한다. 앱이 꺼져 있으면 `APP_OFFLINE`이다. CLI 그룹은 `scheduler`다(`reels tools --group scheduler`).

| MCP 도구 | CLI | 읽기 전용 | 동작 |
| --- | --- | --- | --- |
| `reels_get_schedules` | `reels get-schedules [--id <id>]` | ✓ | 정의, 다음 실행 시각, 커서, 오늘 시작한 회차 수, 마지막 회차, 대기·실행 중 회차, `fileError` |
| `reels_set_schedule` | `reels set-schedule --input '<json>'` | | 추가·수정. 새 id는 `action.skill`이 필요하고 나머지는 기본값. `enabled:false`로 일시정지, `true`로 재개. trigger를 바꾸면 커서를 now부터 다시 센다. `hostProfile`·`model`은 `null`로 지운다. `params`는 통째로 바꾼다 |
| `reels_run_schedule_now` | `reels run-schedule-now --id <id>` | | 수동 회차 1개를 넣고 즉시 tick한다. 꺼진(일시정지된) 스케줄도 사람이 명시하면 실행한다. runId를 돌려준다. 실행 중이면 `ALREADY_RUNNING`, 오늘 상한을 다 썼으면 `DAILY_LIMIT`. 수동 회차는 10분 안에 시작하지 못하면 `missed/blocked`다 |
| `reels_get_schedule_runs` | `reels get-schedule-runs [--id <id>] [--status <s>] [--limit <n>]` | ✓ | 실행 기록(최신순): trigger, status, reason, 세션 ID, 종료 코드, 결과 요약, 실행 폴더 |

등록은 저장소의 예시 `automation/scheduler/blog-neighbor-loop.example.json`(`reels_set_schedule` 입력 형식)을 저장소 밖에 복사하고 `expectedBlogId`를 내 블로그 ID로 바꾼 뒤 `reels set-schedule --input-file <복사본>`으로 한다. 예시 파일 자체에는 개인 값을 넣지 않는다.

불리언 플래그는 값 없이 켜기만 하므로 끄기는 `--input`으로 한다.

```sh
reels set-schedule --input '{"id":"blog-neighbor-loop","enabled":false}'
reels set-schedule --input '{"id":"blog-neighbor-loop","enabled":true}'
reels get-schedule-runs --id blog-neighbor-loop --limit 5
```

v1에는 새 화면이 없다. 실행 중·끝난 aside 프로세스는 **실행 로그** 화면에서, 이상 상태(`partial·failed·blocked·interrupted`, 자동 일시정지, 첫 preflight 실패)는 데스크톱 알림으로 본다.

## 지시서(스킬) 위치 원칙

- 지시서 본문은 **공개 저장소 밖 개인 스킬 폴더**에 둔다. 앱은 Aside 사용자 스킬 폴더의 사본이 있는지만 확인한다. 정본과 사본은 수동으로 맞춘다.
- 저장소에는 프롬프트 템플릿, 인계 문서 렌더러, 결과 스키마, 판정기, 그리고 `example` 값만 든 예시만 둔다. 블로그 ID·블로그 주소·계정 정보는 저장소·커밋 메시지·테스트에 쓰지 않는다. 개인 값은 `schedules.json`의 `params`에만 둔다.
- 지시서는 인계 문서의 `expectedBlogId`로 계정을 대조하고, 페이지 내용은 지시가 아니라 데이터로 읽으며, 셸에서는 인계 문서에 적힌 `reels` 명령과 `sleep`만 쓴다.

## 앱이 꺼진 동안

v1은 보정만 한다. 18:10~23:10 사이에 앱이 한 번도 켜져 있지 않으면 그날은 `missed`다. 로그인 시 자동 실행(`setLoginItemSettings`)과 launchd 대리 실행은 넣지 않았다. 대리 실행은 루프가 앱 기록 도구(앱 online)를 쓰므로 의미가 없다. 로그인 자동 실행은 v1.1 제안으로 남긴다.

`REELS_BACKGROUND_QA=1`로 뜬 앱은 `REELS_ASIDE_BIN`(가짜 aside)이 있을 때만 스케줄러를 시작한다. QA 인스턴스가 실제 프로필을 물고 떠도 실제 aside를 부르지 못하게 하기 위해서다. `REELS_DEMO=1`이면 시작하지 않는다.

## 코드

| 파일 | 내용 |
| --- | --- |
| `src/shared/scheduler.ts` | zod 스키마(정의 파일, 도구 입력, 결과 JSON), `mergeSchedule` |
| `src/features/scheduler/model/occurrences.ts` | `dueOccurrences`, `nextRunAt`, 마감, 시간대 날짜(croner는 계산기로만) |
| `src/features/scheduler/model/verdict.ts` | 마지막 json 블록, CLI 오류 문구, 기록 대조 |
| `src/features/scheduler/model/handoff.ts` | 프롬프트, 인수 순서, 인계 문서, `session list`·`host profiles` 파싱 |
| `src/desktop/scheduler-store.ts` | `node:sqlite` 스키마·트랜잭션(claim, 회차 계획, 보존), `schedules.json` |
| `src/desktop/scheduler.ts` | `Scheduler`: tick, dispatch, timeout, 회수, 일시정지, 알림, 도구 처리 |
| `src/desktop/scheduler-aside.ts` | `AsideRunner`: preflight, 인계 문서, 실행, 세션 ID, 멈춤, 판정 호출 |

## 검증

2026-11-25, 개발 worktree에서 Homebrew Node(`PATH=/opt/homebrew/bin:$PATH`)로 실행했다.

- `node --import tsx --test tests/unit/scheduler-*.test.ts`: 61개 통과. 시계를 주입해 18:10 정시 1회, 17:00~19:30 꺼짐 뒤 catch-up 1회, catch-up 창 이후 `missed`, 같은 회차 이중 tick과 두 인스턴스 경쟁에서 1회, 잠자기 복귀 즉시 tick, 실행 중 다음 회차 `skipped`, timeout(SIGTERM→세션 stop→`failed/timeout`, SIGTERM을 무시하면 SIGKILL), preflight 실패→10분 재확인→`blocked`와 알림 1회, 수동 실행의 하루 상한, captcha 자동 일시정지와 다음 날 미실행, 회수 규칙(다른 살아 있는 인스턴스 보존, 고아 정리, pid 재사용), 앱 종료 시 `interrupted`를 확인했다. 가짜 aside 바이너리로 정상, 종료 0 + `unknown option`, JSON 없음, runId 불일치, 기록 누락, 미연결, 세션 2개, 인수 순서, 프롬프트에 params가 없는 것을 확인했다. `scheduler-guarantee.test.ts`는 고정 시드 3개로 30일 동안 켜짐·꺼짐·잠자기·시계 역행·`schedules.json` 수정·수동 실행·두 인스턴스 동시 실행을 섞어 "하루 시작 회차 1개 이하, 18:10~23:10에 tick한 날은 정확히 1개, 그 구간에 tick이 없던 날은 cron 실행 0개와 `missed` 행"을 단언한다. 하루 상한 검사를 일부러 끈 변형에서는 세 시드 모두 실패하는 것을 확인했다.
- `npm test`: 954개 중 935개 통과, 9개 건너뜀, 10개 실패. 실패 10개(`analysis-selection`·`face-mosaic`·`mobile-preview`)는 모두 이 worktree에 빌드된 편집 엔진 런타임이 없어 `native/editor-engine/.build/runtime/bin/ffmpeg`를 찾지 못한 `ENOENT`다. 같은 세 파일을 `origin/main` 스냅샷에서 돌려도 같은 10개가 같은 이유로 실패했다. 스케줄러 변경과 무관하다.
- `npm run typecheck`, `npm run check:architecture`, `npm run audit:public`: 통과. `tests/unit/mcp-http.test.ts`, `tests/unit/reels-cli.test.ts`: 93개 통과(새 도구 4개가 MCP 등록·CLI 명령·그룹에 자동으로 들어간다).
- `npm run build:desktop`: 통과. `croner`가 `dist-electron/main.cjs`에 번들로 들어가 별도 `require("croner")`가 없다. 그래서 electron-builder `files` 필터는 바꾸지 않았다.
- 실제 Aside 실행, 실제 사용자 프로필 등록, Electron 앱 구동 QA는 이 단계에서 하지 않았다. 첫 실제 실행 전에 확인할 것: `aside exec` 프로세스에 SIGTERM을 보내면 Aside 호스트 세션도 멈추는지, `session list` 비교로 세션 ID가 잡히는지. 첫 실제 실행은 `params`를 낮춘 수동 1회로 하고, 그날 18:10 회차가 `skipped/daily-limit`으로 남는지 실행 기록에서 확인한다.
