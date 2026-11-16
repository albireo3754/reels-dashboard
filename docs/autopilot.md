# 퇴근 후 autopilot

낮에는 Linear/Dashboard 큐에서 준비할 수 있는 일을 자동으로 진행하고, 퇴근 후에는 **오늘 볼 1개**만 보게 하는 로컬 흐름이다. 새 대시보드나 별도 DB는 없다. Linear와 Dashboard가 정본이고, 자동화 상태는 프로필 폴더의 작은 JSON 하나다. Linear나 외부 서비스에는 쓰지 않으며 게시·업로드·git push를 하지 않는다.

## 계약

- **3개 점유 규칙.** 기존 리뷰 대기(Linear Inbox·검토 이름의 started, Dashboard `stage: review`, 사용자가 닫지 않은 `awaiting_review` 예약)가 3개 이상이면 자동 실행은 새로 시작하지 않는다. 3개 미만이면 `max(0, 3 - 기존 점유 - 실행 중 예약)`개까지, 후보 수를 넘지 않게 예약한다. 같은 항목이 Linear와 Dashboard에 같이 보이면 `projectId` 키로 한 번만 센다(리뷰가 우선). `maxSlots`는 3을 넘길 수 없다(넘으면 설정 오류).
- **수동은 제한 없음.** `reels autopilot run --manual <key>...`는 점유와 무관하게 시작한다. 이미 실행 중인 같은 key는 거절한다. 개수 제한도 없다: 등록 Workflow는 한 번에 3개까지만 받으므로 key가 4개 이상이면 3개 이하 묶음으로 나눠 묶음마다 별도 `runId`·토큰·예약·실행기(`reels autopilot execute`)를 띄운다(결과의 `runs`). 묶음마다 예약·토큰·결과 처리는 같고 자동 admission에는 영향이 없다. Dashboard에만 있는 카드도 수동으로는 시작할 수 있다. 수동 실행은 점유 확인을 건너뛰고, 실행 직전 Linear 조회가 실패해도 막지 않는다(그 결과는 `runs/<id>/recheck.json`에 남긴다). 실행 중인 수동 예약은 자동 slot 계산에는 포함된다. 스케줄러가 설정하는 `REELS_AUTOPILOT_AUTOMATED=1`이면 수동 실행을 거절한다. 기존 항목을 삭제·이동·축소하지 않고, 실행 중인 작업을 취소하지 않는다.
- **원자적 예약.** `<profile>/autopilot/lock`을 `wx`로 만들어야 상태를 바꾼다(pid·시각·토큰·프로세스 시작 시각을 적는다). 잠금을 못 잡았을 때 **소유 pid가 살아 있으면 시간이 아무리 지났어도 회수하지 않고** `busy`로 아무것도 하지 않은 채 끝난다. tick 결과는 `reason: lock_held_alive: pid N가 M초 …`와 `lockHeld`를 알리고, `reels autopilot status`는 `lock`(pid·살아 있음·경과 초)을 보여 준다(잠금이 없는 tick은 state를 쓸 수 없어 `lastTick`에는 남기지 않는다). 회수는 pid가 죽었거나 기록한 시작 시각과 지금 그 pid의 시작 시각이 다를 때(pid 재사용)만 한다. 회수 경합은 `lock.reclaim` 가드를 `wx`로 잡은 한 명만 하고, 그 안에서 현재 파일이 판정한 내용과 같을 때만 `lock.stale-<token>`으로 옮겨 지운다. 이미 다른 contender가 새 잠금을 만들었으면 건드리지 않고 물러난다. 해제는 자기 토큰의 잠금일 때만 지운다. 잠금 안에서 상태를 다시 읽고 → 회수 → 계산 → `starting` 예약 저장 → 실행기 시작 → pid·시작 시각 기록(`running`) 순으로 진행한다. 잠금에는 시간 기반 탈취가 없으므로 GraphQL 같은 느린 호출은 잠금 밖에서 하고 planning 쓰기는 `expectedUpdatedAt` 리비전 검사로 보호한다.
- **회수.** 예약은 `starting`(pid 없음, `startDeadline` 2분) → `running`(pid·`processStartedAt`) → `awaiting_review`/`failed`/`done`이다. `starting`은 슬롯과 key를 점유하며, 기한이 지나도 pid가 없을 때만 `failed(start_deadline)`로 회수한다(spawn이 실패하면 즉시 `failed(spawn_failed)`). `running`은 **pid가 죽었음이 확인될 때만**(또는 pid가 없거나 시작 시각이 달라 다른 프로세스일 때) `failed(orphaned)`로 회수한다. `leaseUntil`(기본 90분)이 지났어도 pid가 살아 있으면 회수하지 않고 슬롯을 계속 점유하며 `lastTick.reason`에 `lease_expired_alive: <key>`를 노출한다(같은 key가 두 번 실행되지 않게 하기 위해서다). 시작 시각을 읽을 수 없으면 보수적으로 살아 있다고 본다. 같은 run의 예약은 같은 토큰을 가지며, 실행기는 `REELS_AUTOPILOT_RUN_TOKEN`으로 받은 토큰이 자기 `starting/running` 예약과 일치할 때만 일한다. 회수된 예약이거나 토큰이 없거나 다르면 모델 호출 없이 `started:false`로 끝나므로 회수와 늦게 뜬 실행기가 겹쳐도 같은 key가 두 번 실행되지 않는다. `failed`와 사용자가 닫은 `done`은 항목의 증거(상태·우선순위·마감·차단·하위 이슈·단계·다음 행동)가 바뀌기 전까지 다시 고르지 않는다.
- **최신성.** Linear 가져오기가 없거나(`linear_missing`), `staleAfterMinutes`보다 오래됐거나(`linear_stale`), 조회 구간이 오늘(KST)을 포함하지 않으면(`linear_window`) 자동 시작 0건이고 이유를 `lastTick`에 남긴다. 읽기 실패는 빈 큐 성공이 아니라 `state_unreadable`이다.
- **무호출과 fingerprint.** 큐가 찼거나(`queue_full`), 입력 fingerprint가 지난 tick과 같거나(`unchanged`), 일시정지·활성 시간 밖이면 모델을 호출하지 않는다. tick 자체는 모델을 호출하지 않고, 예약이 생겼을 때만 실행기 프로세스를 띄운다. fingerprint는 **의미**만 담는다: 이슈의 id·제목·상태 타입/이름·우선순위·마감·차단·하위 이슈·`projectId`, Dashboard project의 id·단계·다음 행동, 예약의 key·상태·증거, 순위에 쓰이는 `maxSlots`, 그리고 현재 순위 순서(key 목록). `linear.syncedAt`·`planning.updatedAt`·tick 시각·`lastTick`·간격/lease/실행기 설정은 넣지 않는다. 그래서 내용이 같은 새 snapshot은 최신성(`syncedAt` 기준, 별도 판정)만 갱신하고 결과는 `unchanged`다. 기다린 일수·마감까지 남은 일수처럼 시간이 지나야 바뀌는 근거는 값이 아니라 **순위가 실제로 바뀌었는가**(순서 key 목록)로만 fingerprint에 들어가므로 매일·매 tick 재생성이 일어나지 않고, 마감 구간을 넘겨 순서가 뒤집힐 때만 다시 본다(일 단위 계산이라 하루에 한 번보다 자주 바뀌지 않는다). `starting`과 `running`은 같은 상태로 취급한다. 결과 JSON의 `modelCalls`는 시작한 항목 수이며 그 밖에는 0이다.
- **예약 직전·실행 직전 엄격 재확인.** 캐시 사본 갱신(`staleAfterMinutes`의 절반 경과 때, 상태 표시용)과 별개로, 자동 경로는 실제로 시작하기 직전에 **Linear API를 새로 조회**(모델 0)하고 최신 `dashboard.json`을 다시 읽어 점유를 다시 센다. (1) tick: 캐시 기준 점유가 3 미만이고 입력이 바뀌어 후보가 있어 **예약하려는** tick만 예약 직전에 조회한다. 캐시가 이미 가득(≥3)이거나 `unchanged`면 API 호출 없이 끝난다. 조회가 실패·불완전·인증 없음이면 자동 0건(`freshness`, 이유 `예약 직전 Linear 재확인에 실패…: <코드>`가 `lastTick`에 남음)이고, 점유가 3 이상이면 `queue_full`이다. (2) 실행기: 모델을 시작하기 직전에 다시 조회해 점유가 3 이상이면 `queue_full_at_start`, 조회에 실패하면 `linear_unavailable_at_start`로 예약을 지우고 **모델 호출 0**으로 끝난다. 새 조회 결과는 기존 `PlanningStore.update` 규칙으로 저장하며(리비전 충돌 시 재읽기 1회), 점유는 저장 여부와 무관하게 방금 받은 응답으로 센다. **Keychain 키가 없으면 엄격 확인을 할 수 없으므로 자동 0건(`linear_auth_missing`)이다. 커넥터 수동 sync 사본만으로는 자동 dispatch를 하지 않는다.** 실행기는 이 밖에도 토큰을 확인하고 비활성·일시정지·항목이 사라진 예약을 지운다(실패 증거로 남기지 않는다). `execution.workdir`가 없거나 폴더가 아니면 `workdir_missing`으로 예약을 지우고 **모델 호출 0**으로 끝나며 자동 tick을 `workdir_missing` 이유로 일시정지한다(설정한 뒤 `resume`). `--dry-run`과 `status`는 읽기 전용이라 캐시만 쓴다.
- **한도·불완전.** workflow가 `incomplete`거나, **실패한 실행**(0이 아닌 종료·`passed:false`·오류·시간 초과)의 출력에 명확한 한도 신호(`usage limit reached`, `rate limit`, `limit exceeded`, `hit your limit`, `HTTP 429`, `Too Many Requests`, 사용량 한도 등)가 있으면 `state.paused`를 설정한다. `reels autopilot resume` 전까지 tick은 `paused`로 끝난다. 종료 코드 0과 `passed:true`로 깨끗하게 끝난 실행은 stderr나 요약문에 `quota`·`429` 같은 단어가 있어도 pause하지 않는다(`quota`·`429` 단독은 신호가 아니다). null·빈 출력·예외·0이 아닌 종료·`passed:false`는 성공으로 처리하지 않고 `failed`로 기록한다.
- **dry-run 문구.** `tick --dry-run`은 상태를 바꾸지 않으므로 `예약할 수 있어요 n개`라고만 말하고 예약했다고 하지 않는다.

## 분류와 순위

| 출처 | 분류 |
| --- | --- |
| Linear `triage` | 리뷰 대기 |
| Linear `unstarted`·`backlog`·`triage`·`started` 중 `stateName`이 Inbox(`/^\s*in\s*box\s*$/i`, `인박스`) 또는 `/review\|검토\|리뷰/i` | 리뷰 대기(점유, 자동 후보 제외) |
| Linear `started` + `stateName`이 `/review\|검토\|리뷰/i` | 리뷰 대기 |
| 그 밖의 Linear `started` | 진행 중 |
| Linear `unstarted`·`backlog` | 후보(자동 준비 대상) |
| Linear `completed`·`canceled`·`duplicate` | 무시(이름이 `In Review`여도) |
| Dashboard `stage: review` | 리뷰 대기 |
| Dashboard `published` 외 나머지 | 진행 중(표시용. 자동 대상은 아래 풀 규칙) |

순위는 tick마다 다시 계산한다. 근거는 마감(`dueDate`, 경과·임박), 차단(`blockedBy`가 있으면 크게 감점, 이유 `차단됨: X`), 남은 하위 이슈(`subIssues.open`이 적을수록 가점), Linear 우선순위(가중치 하나일 뿐 고정 1위가 아니다), 기다린 기간(`updatedAt`/`createdAt` 이후, 리뷰 큐에서 가점), Dashboard 단계(editing > selected > captured > idea)다. 동점은 key 순이다. 이전·새 순서와 이유는 `state.json`의 `previousOrder`/`order`(상위 50개)에 남는다.

## 자동 실행 대상 풀

자동 실행 풀의 정본은 **Linear**다: 해당 팀의 **실행 가능한 기존 진행 중**(`started`이면서 검토·Inbox 이름이 아닌 것)과 **새 후보**(`backlog`/`unstarted`, 검토·Inbox 이름이 아닌 것), 그리고 그 이슈와 `projectId`로 연결된 Dashboard 카드(같은 key로 1개)를 한 순위로 묶은 것이다. **Linear에 연결되지 않은 Dashboard 전용 카드(idea 등 모든 단계)는 자동으로 선정하지 않는다**(`skippedCandidates`에 `dashboard_only`). 수동 실행은 그런 카드도 시작할 수 있고, Dashboard `stage: review` 카드는 점유 집계에 계속 들어간다. 리뷰 대기·Inbox 항목은 사용자 몫이라 풀에서 제외한다. 같은 근거라면 기존 진행 중의 다음 로컬 작업이 새 후보보다 앞서도록 진행 중 항목에 `progressWeight`(3점)를 더해 정렬한다. 3개 점유 gate와 admission 공식은 그대로다. 제외하고 이유를 `skippedCandidates`에 남기는 경우: 차단됨(`blocked`), 같은 key에 `starting`/`running`/`awaiting_review` 예약이 있음(`running`/`awaiting_review`), 같은 증거로 이미 실패(`failed_unchanged`)·완료(`done_unchanged`)·사용자 입력 필요로 끝남(`needs_user_unchanged`), Linear 연결 없음(`dashboard_only`). Linear 이슈와 Dashboard project가 같은 key(`projectId`)면 한 항목이다.

## 명령

| 명령 | 동작 |
| --- | --- |
| `reels autopilot status` | 큐·점유·실행 중 예약·자동 slot·최신성·일시정지·마지막 tick. 읽기 전용. |
| `reels autopilot tick [--dry-run] [--now <iso>]` | 자동 경로. 순서: 설정·일시정지·활성 시간 → 상태 읽기 → 최신성 → 잠금 → 회수 → `queue_full` → `unchanged` → 순위·순서 기록 → admission → 예약 → 실행기 시작. `--dry-run`은 상태·파일을 바꾸지 않고 같은 계산과 오늘 볼 1개를 보여 준다(`wouldAdmit`). `offWorkAt` 이후 첫 실제 tick은 `today.md`를 갱신한다. |
| `reels autopilot run --manual <key>...` | 수동 시작. key는 `reels autopilot status`의 `key` 또는 Linear identifier(예: `CONTENT-12`). 개수 제한 없음(3개씩 묶음으로 나눠 묶음마다 실행기를 띄운다). |
| `reels autopilot today` | 오늘 볼 1개(정확한 링크 또는 `project:<id>`, 왜 지금인지, 필요한 한 결정, 완료 기준)를 출력하고 `<profile>/autopilot/today.md`에 쓴다. 리뷰 큐가 비면 차단되지 않은 진행 중 1위의 다음 행동, 그것도 없으면 `null`(없음)이다. 취향·실제 경험·인증이 필요한 항목은 `userDecisionRequired`로 표시하며 자동 완료하지 않는다. 보고서 없는 리뷰 항목의 "필요한 한 가지"는 남은 채널(예 `남은 채널: 블로그 임시저장`)과 저장된 다음 행동을 그대로 보여 준다. |
| `reels autopilot resolve <key>` | `awaiting_review` 예약을 `done`으로 닫는다. 키가 Linear/Dashboard에서 사라지면 다음 tick이 `left_queue`로 정리한다. |
| `reels autopilot pause [--reason <text>]` / `resume` | 자동 tick의 시작을 막는다/허용한다. 수동 실행은 일시정지와 무관하다. |
| `reels autopilot refresh-linear [--dry-run]` | 모델 없이 Linear API를 읽어 `planning.json`의 `linear`를 통째로 바꾼다(`--dry-run`은 저장 없이 이슈 수·상태별 수·페이지 수·`syncedAt`·`X-Complexity`만 출력, 제목은 출력하지 않는다). 실패는 `LINEAR_*` 코드와 exit 4. |
| `reels autopilot connect-linear` | **대화형 터미널에서만.** Keychain에 Linear API 키를 한 번 저장하고 곧바로 dry-run으로 확인한 뒤 이슈 수·상태별 수만 출력한다. TTY가 아니면 exit 2로 거절하고 아무것도 저장하지 않는다. |
| `reels autopilot disconnect-linear` | Keychain의 `reels-dashboard-linear`/`linear` 항목만 지운다(없으면 `not_found`). |
| `reels autopilot execute --run <id>` | 내부용. tick·수동 실행이 띄우며 `REELS_AUTOPILOT_RUN_TOKEN`이 필요하다. |

앱은 필요 없다. `REELS_USER_DATA`가 프로필을 고른다. 입력 오류는 exit 2, 다른 tick이 잠금을 쥐고 있으면 `AUTOPILOT_BUSY`(exit 6), 상태 파일을 못 읽으면 `STORE_UNREADABLE`(exit 11)이다. tick은 막힌 이유를 JSON의 `result`/`reason`으로 알리고 exit 0으로 끝난다.

## 파일과 설정

`<profile>/autopilot/`(0700): `state.json`(0600), `config.json`(선택, 자동 생성하지 않음), `lock`, `today.md`, `runs/<runId>/`(args.json, 보고서, execute.log). 설정을 지우면 기본값으로 돌아간다.

**프로필 경로(근거 확인, 코드 읽기로 확인했고 Electron을 새로 띄워 확인하지는 않았다).** 기본 프로필은 개발 실행(`npm start`)과 패키지 앱 모두 `~/Library/Application Support/Reels Dashboard`다. 개발 실행이 표시 이름 "Reels Dashboard Dev"를 쓰지만 데이터 폴더는 바꾸지 않는다.

- 앱: `src/desktop/main.ts` 74~75행이 `REELS_USER_DATA`가 있으면 `path.resolve`로 `userData`를 덮어쓰고, 76행이 `app.setName(APP_NAME)`(= "Reels Dashboard", `src/desktop/build-identity.ts`)을 먼저 부른 다음, 80~85행이 개발 빌드면 그때의 `userData`를 `app.setPath("userData", userData)`로 고정한 뒤에야 표시 이름을 "Reels Dashboard Dev"로 바꾼다(주석: "rename never moves app data"). 데이터 폴더는 `main.ts` 150행 `app.getPath("userData")`다. README 103행도 "Only the displayed name changes; the app-data directory (or `REELS_USER_DATA`) … stay where they were"라고 적는다.
- CLI와 autopilot: `agentRoot`(`src/shared/lib/agent-socket.ts` 28~37행)가 `REELS_USER_DATA`가 있으면 `path.resolve`, 없으면 같은 `~/Library/Application Support/Reels Dashboard`를 쓰고, `profileRoot`(`src/app/cli/run.ts` 221~226행)는 상대 경로 `REELS_USER_DATA`만 작업 폴더 기준으로 해석한 뒤 `agentRoot`로 넘긴다.
- 그래서 앱(개발·패키지)·CLI·스케줄러가 같은 폴더를 보려면 plist의 `REELS_USER_DATA`를 비우거나 앱과 같은 절대 경로로 둔다. `~/Library/Application Support/Reels Dashboard Dev`가 로컬에 있더라도 현재 코드가 가리키는 폴더가 아니므로 autopilot은 그 폴더를 읽지 않는다(오래된 메모에 "개발 실행은 Dev 폴더를 쓴다"고 적혀 있다면 그것은 이 핀 고정 이전 관찰이다). 지금 떠 있는 앱이 어느 폴더를 쓰는지 확인하려면 그 폴더의 `agent/connection.json`에 적힌 pid를 `ps`와 대조한다.

```json
{
  "enabled": true,
  "intervalMinutes": 30,
  "activeHours": { "from": "09:00", "to": "18:30" },
  "offWorkAt": "18:30",
  "staleAfterMinutes": 180,
  "maxSlots": 3,
  "leaseMinutes": 90,
  "linear": { "teamKey": "P", "workspaceUrlKey": "rosy-trip2" },
  "executor": { "command": "claude", "args": ["-p", "--strict-mcp-config", "--model", "sonnet", "--output-format", "json"], "timeoutMinutes": 60 },
  "execution": {
    "workdir": "/absolute/path/of/the/content/project",
    "permissionMode": "acceptEdits",
    "allowedTools": ["Workflow", "Read", "Edit", "Write", "Glob", "Grep", "Bash(reels:*)", "Bash(git status:*)", "Bash(git diff:*)"]
  }
}
```

모든 키가 선택이며 파일에는 바꿀 키만 적는다(`linear`는 `teamKey`·`workspaceUrlKey`를 각각 생략할 수 있다. `executor`·`execution`은 객체째 바꾼다. `execution`은 `permissionMode`·`allowedTools`를 생략하면 위 기본값이다). `execution.workdir`는 개인 경로라 코드 기본값이 없고 **이 user-data config에서만** 읽는다. 없으면 실행기는 모델을 호출하지 않고 `workdir_missing`으로 멈춘다. 시각은 KST, `activeHours`는 from 포함·to 미포함이다. `intervalMinutes`는 스케줄러 주기의 기준값으로, tick이 스스로 강제하지는 않는다. 주기를 바꾸려면 plist의 `StartInterval`(초)을 함께 바꾸고 다시 불러온다. 끄려면 `enabled:false`, 잠깐 멈추려면 `pause`.

## 실행기와 native Workflow

예약이 생기면 tick이 `reels autopilot execute --run <id>`를 분리 프로세스로 띄운다(토큰은 환경변수 `REELS_AUTOPILOT_RUN_TOKEN`). 실행기는 토큰·`workdir`·재확인 후 예약 항목의 **입력 원문**을 `runs/<id>/args.json`(0600, 공개 저장소 밖)에 쓰고, 작업 디렉터리 `execution.workdir`에서 `claude -p --strict-mcp-config --model sonnet --output-format json --permission-mode acceptEdits --allowedTools <목록> --add-dir <runDir>`(모두 config로 변경)에 `afterwork-autopilot` workflow 실행을 요청한다. MCP는 붙지 않는다. 매 tick이 아니라 **예약이 생겼을 때만** Claude가 시작된다.

입력 원문: Linear 항목은 `description`(이슈 본문, planning의 선택 필드, 8,000자 상한, 넘으면 `descriptionTruncated:true`와 원문 `sourceUrl`)을, Dashboard 항목은 `nextAction`·`localNotes`·`resources`(role·label·path)와 `reels get-project --project-id <id>`(최신 원문을 다시 읽게 하는 명령)를 넘긴다. 제목만 있는 입력은 workflow가 거절한다. `claude -p`에 보내는 바깥 프롬프트는 **Workflow args를 JSON 한 줄(`<args-json>` 아래)로 직접 담고** "Workflow 도구를 name=`afterwork-autopilot`, args=이 JSON 그대로 한 번 호출, 다른 도구 금지"를 지시한다(파일을 읽으라고 하지 않는다). args가 12,000자를 넘으면 1,500자를 넘는 description은 `runs/<id>/input-<key>.md`(0600)로 옮기고 args에는 미리보기와 `descriptionPath`만 둔다. 워커 프롬프트가 그 파일을 Read로 먼저 읽도록 허용한다(`--add-dir <runDir>`와 `Read` 허용 도구).

Workflow 소스는 `automation/claude-workflows/afterwork-autopilot.js`다. 항목마다 Sonnet/medium 에이전트 1개(최대 3)가 입력 원문·연결된 정본·그 폴더의 `AGENTS.md`/README·기존 제작 workflow를 먼저 읽고, 지침이 허용하는 **로컬 다음 작업 1단위를 실제로 수행**한다(콘텐츠 정본 문서 수정, 로컬 검증, `reels` CLI의 로컬 쓰기 도구·YAML 제작 workflow 진행 등). 금지(프롬프트에 명시): 외부 게시·업로드·계정·결제·삭제, 원본 사진/미디어 이동·삭제, Linear·외부 서비스 쓰기, Dashboard 단계/게시 상태 변경, Edits 앱 조작(점유 규칙 때문에 자동에서 제외), 범위 밖 앱·회사 업무 저장소 조작, git commit/push, 사용자 경험·취향·사실 추정. 근거가 없으면 수정하지 않고 `needs_user`로 멈춘다.

결과 `status`: `progressed`(실제 변경, `changes:[{path,summary}]`와 `verification:[{cmd|check,result}]`가 모두 있어야 한다. 비어 있으면 `prepared`로 강등하지 않고 `passed:false`로 실패), `prepared`(변경 없는 준비 보고, `changes`가 있으면 실패), `blocked`(실패와 이유), `needs_user`. 보고서 `runDir/<key>.md`에는 읽은 출처 경로·변경 파일·검증 근거·남은 결정 1개를 남긴다. `passed:true`이고 `progressed`/`prepared`/`needs_user`이며 보고서가 `runs/<id>/` 안에 **실제로 존재하는 비어 있지 않은 파일**(실행기 자신의 `args.json`·`recheck.json`·`execute.log`·`input-*` 제외)일 때만 `awaiting_review`(사용자 검토 큐 점유)가 되고, 예약에 `outcome`과 `changes`가 남아 `today`가 "실제 변경을 수행"과 "변경 없는 준비 보고"를 구분해 보여 준다. `blocked`나 그 밖의 결과는 `failed`와 이유다(보고서 파일이 없으면 `report_missing` — 조율 모델이 결과 JSON을 꾸며내도 통과하지 못한다). `dryRun`이거나 항목이 없으면 에이전트를 호출하지 않고, 결과 중 하나라도 null이면 `{passed:false, incomplete:true}`다.

등록(한 번, 사용자가 실행): `ln -s <repo>/automation/claude-workflows/afterwork-autopilot.js ~/.claude/workflows/afterwork-autopilot.js`. 새 Claude 세션부터 이름으로 실행된다.

## Linear 자동 갱신 (모델 호출 0)

구현은 `src/shared/lib/linear-source.ts`(조회·저장)와 `src/app/cli/autopilot.ts`(명령·tick 연결)다. 쓰기 mutation은 보내지 않는다.

### 두 인증을 구분한다

| | 무엇 | 쓰이는 곳 | 자동 tick |
| --- | --- | --- | --- |
| (1) Claude `claude.ai Linear` 커넥터 재인증 | Claude 앱·세션의 MCP 커넥터 로그인 | **대화형 Claude 세션의 수동 sync**(`reels_sync_planning`, [publication-calendar.md](publication-calendar.md)) | 쓰지 못한다 |
| (2) Keychain Linear API 키 | macOS Keychain generic password, 서비스 `reels-dashboard-linear`, 계정 `linear` | `reels autopilot refresh-linear`와 tick의 **모델 0 자동 갱신** | 필요하다 |

(1)만 해 두면 tick은 Linear 사본을 스스로 갱신하지 못한다. 수동 sync로 사본이 `staleAfterMinutes`의 절반 안에서 새로우면 tick이 그 사본을 그대로 쓰지만, 그 뒤에는 (2) 키 없이 갱신하지 못해 `linear_auth_missing`으로 자동 0건이 된다. 자동 운영에는 (2)가 필요하다.

### 한 번 연결하기

`reels autopilot connect-linear`를 **터미널에서 직접** 실행한다. 내부에서 `security add-generic-password -U -s reels-dashboard-linear -a linear -w`를 `-w` **값 없이 마지막 인자**로, 터미널에 붙여(stdio inherit) 실행하므로 macOS가 키 입력을 직접 받는다(입력은 화면에 보이지 않는다). 키는 이 프로세스의 인자·환경·메모리·로그·출력 어디에도 오지 않는다. 키는 Linear Settings > Account > Security & access의 personal API key(읽기 권한이면 충분)이며 채팅이나 명령줄에 붙여 넣지 않는다. 저장 뒤 dry-run으로 확인한 결과(이슈 수·상태별 수)만 출력한다. 해제는 `reels autopilot disconnect-linear`(해당 Keychain 항목만 삭제)다.

### 조회 계약

[linear-api-contract](#공식-계약-근거)를 따른다. 읽기 때 키는 `security find-generic-password -s reels-dashboard-linear -a linear -w`로 메모리에만 읽고 `Authorization: <키>`(Bearer 없음)로 `POST https://api.linear.app/graphql`에 보낸다. 오류 문구에서는 키와 `lin_api_…` 모양을 지운다.

- **Workspace 확인(먼저).** 이슈를 읽기 전에 `query ViewerOrganization { viewer { organization { id urlKey } } }`로 키가 속한 workspace를 읽고 `urlKey`가 `linear.workspaceUrlKey`와 다르면 `linear_workspace_mismatch`로 실패한다(이슈를 읽지 않고, 저장·자동 실행 0). 조직·팀 확인이 모두 통과했을 때만 이슈 0개가 정상적인 빈 큐다. 필드 근거: 공식 SDL `Query.viewer: User!`, `User.organization: Organization!`, `Organization.id: ID!`, `Organization.urlKey: String!`(2026-11-16 확인, 근거 줄은 linear-api-contract.md의 "Workspace").
- **팀 범위.** config `linear.teamKey`(기본 `"P"`)와 `linear.workspaceUrlKey`(기본 `"rosy-trip2"`). 필터 `issues(filter:{team:{key:{eq:<teamKey>}}})`로 그 팀만 조회하고, 응답 이슈의 `team.key`가 다르거나 이슈 URL이 `linear.app/<workspaceUrlKey>/`가 아니면 전체 실패(`linear_scope_mismatch`)다. 다른 팀·회사 이슈는 저장하지 않는다.
- **두 번의 조회.** 열린 이슈(`state.type nin [completed, canceled, duplicate]`, `triage` 포함)와 최근 14일에 닫힌 이슈(`state.type in [completed, canceled, duplicate]`이고 `updatedAt > -P14D`)를 각각 `first: 50`, `pageInfo{hasNextPage endCursor}`로 끝까지 읽는다(공식 최대 250, 권장 50, 중첩은 10). 닫힌 이슈의 완료 시각 필드는 `duplicate`에서 확인되지 않아 `updatedAt`으로 거른다.
- **필드.** `id identifier title url description dueDate priority createdAt updatedAt startedAt state{name type} team{key}`, `children`(미완료/전체 수는 `nodes{state{type}}`를 세어 만들고 `hasNextPage`가 true면 `subIssues`를 생략한다. 개수 필드는 UNCONFIRMED), `inverseRelations`(type이 `blocks`이고 차단하는 이슈가 열려 있으면 그 identifier를 `blockedBy`에 넣는다. 첫 페이지에 더 있다고 하면 `issue(id:)`로 전체를 다시 읽는다), `attachments{nodes{url}}`와 `description`의 `dashboard:<projectId>`는 `projectId`가 된다. 열린 이슈만 `description`을 저장한다(최대 20,000자). 쿼리 문자열은 상수이고 `tests/unit/autopilot-linear.test.ts`가 선택한 필드 이름을 공식 계약의 집합과 대조한다.
- **완전하거나 아무것도 아니거나.** 페이지 20개 초과·커서 반복·`hasNextPage`인데 커서 없음·GraphQL `errors`·네트워크 실패·HTTP 오류·이슈 500개 초과는 `linear_incomplete`이고 부분 결과를 저장하지 않는다. 같은 id가 두 번 나오면 하나로 본다.
- **저장.** `PlanningStore.update`로 `linear` provider를 통째로 바꾼다. `expectedUpdatedAt`이 어긋나면 한 번 다시 읽고, 이미 더 새로운 사본(`syncedAt`)이 있으면 덮어쓰지 않는다. `syncedAt`은 조회가 끝난 시각, `window`는 오늘(KST) -14일 ~ +28일, `url`은 팀 URL이다. `dueDate`가 없는 이슈도 저장한다(캘린더만 주간 목록에서 숨긴다).
- **실패 이유 코드.** `linear_auth_missing`(Keychain에 키 없음), `linear_auth_invalid`(HTTP 401/403 또는 `AUTHENTICATION_ERROR`), `linear_rate_limited`(HTTP 429 또는 `RATELIMITED`, 재시도하지 않음), `linear_scope_mismatch`, `linear_workspace_mismatch`(키의 workspace가 설정과 다름), `linear_incomplete`, `linear_invalid_response`(예상 밖 모양), `linear_save_failed`. CLI에서는 `LINEAR_AUTH_MISSING`처럼 대문자 코드와 exit 4, 해결 방법을 담은 `hint`로 나온다.
- **복잡도.** 응답 `X-Complexity` 헤더가 있으면 `refresh-linear` 요약의 `complexity: {max, total}`에 기록한다. 쿼리당 10,000점 상한이 있어 첫 실행의 값을 확인한다.

### tick 연결

tick은 활성 시간 gate를 통과한 실제 실행에서만, 최신성 판정과 큐 읽기 **앞에** Linear 사본의 나이를 본다. `staleAfterMinutes`(기본 180분)의 **절반 이상** 지났으면 갱신을 한 번 시도하고(잠금 밖에서 하며 planning 쓰기는 `expectedUpdatedAt` 검사로 보호한다. 두 tick이 겹쳐도 한쪽은 재읽기하거나 이미 새로운 사본을 존중한다), 그보다 젊으면 API를 부르지 않는다. 실패하면 자동 실행 0건이고 `lastTick.reason`에 `freshness`와 이유 코드(예 `linear_auth_missing`)가 남는다. 성공하면 같은 tick에서 일반 gate로 이어간다. `--dry-run` tick은 갱신하지 않는다. 내용이 같은 사본은 `syncedAt`만 바뀌어 fingerprint가 같으므로 다음 tick은 `unchanged`다. 커넥터 수동 sync(`reels sync-planning`, `reels_sync_planning`)도 같은 `planning.json`에 쓰므로 tick이 같은 사본을 쓴다.

이 절반 경과 갱신은 캐시 사본을 신선하게 두고 상태를 보여 주기 위한 것이다. 실제 예약·모델 시작 직전의 **엄격 재확인**(항상 API를 새로 조회)은 별개이며 위 계약의 "예약 직전·실행 직전 엄격 재확인"을 따른다.

#### 공식 계약 근거

엔드포인트·헤더·페이지네이션·상태 타입(`triage`, `duplicate` 포함)·`inverseRelations`의 `blocks` 의미·429 `RATELIMITED`·복잡도는 Linear 공식 문서와 공식 schema SDL을 확인한 `research/2026-11-16-after-work-autopilot/work/linear-api-contract.md`(Obsidian 리서치 폴더)를 정본으로 한다. 그 문서에서 UNCONFIRMED로 표시된 항목(`team(id:)`에 팀 키, `children` 개수 필드, 중첩 페이지 크기 권고 등)은 필수로 쓰지 않는다.

## Dashboard 카드

기존 **대시보드 탭** 상단(진행 단계 요약 아래)에 작은 카드 `퇴근 후 오늘 볼 1개` 하나가 있다. 새 페이지·탭은 없고 기존 디자인 시스템(`Section`, `SectionHeader`, `Notice`, `StatusText`)만 쓴다(`src/features/after-work-autopilot`).

- 내용: 항목 제목 링크(Linear URL은 새 창 외부 링크, Dashboard project는 기존 콘텐츠 기록 대화상자 열기), **왜 지금**, **필요한 한 가지**, **완료 기준**, 자동 작업 결과가 있으면 수행한 변경과 준비 보고의 구분. 없으면 `오늘 볼 항목 없음`. 항목은 정확히 1개이거나 없다.
- 한 줄 상태: `리뷰 대기 n · 진행 중 n · 점유 n/3 · 자동 슬롯 n`. 개수는 `dueDate` 없는 이슈를 포함한다(캘린더의 주간 목록과 다르다).
- 멈춤 표시: 마지막 tick이 `linear_auth_missing`/`linear_auth_invalid`로 실패했으면 `Linear 인증 필요 — 자동 실행 멈춤`, 사본이 없거나 오래됐거나 조회 구간 밖이면 `… — 자동 실행 멈춤`, 일시정지면 `자동 실행 일시정지 중`. 자동 실행이 꺼져 있으면 상태 줄에 `자동 실행 꺼짐`.
- 데이터: 읽기 전용 IPC `autopilot:get`(`src/desktop/main.ts`, preload `autopilot.get`, `DashboardBridge.autopilot?`)가 CLI와 같은 `computeAutopilotView`로 planning·Dashboard projects·`autopilot/state.json`·config를 읽어 계산한다. 쓰기 IPC는 없다(수동 실행은 CLI). 브리지에 `autopilot`이 없으면(공유 읽기 전용 화면) 카드를 그리지 않는다. 웹 데모 브리지는 자신의 `reels-planning-demo-v1`·`reels-autopilot-demo-v1`(선택, `lastTick`/`paused`) localStorage로 같은 함수를 계산한다.
- 갱신: 마운트, Dashboard 변경, 창 포커스 때 다시 읽는다.

## 스케줄

`automation/launchd/com.rosy.reels-afterwork-autopilot.plist.template`은 30분마다 `node <repo>/dist-cli/reels.mjs autopilot tick`을 실행하는 템플릿이다(`REELS_AUTOPILOT_AUTOMATED=1`, 로그 `<profile>/autopilot/tick*.log`). `__REPO__`·`__USER_DATA__`·`__HOME__`을 바꾼 뒤 `~/Library/LaunchAgents/`에 두고 `<profile>/autopilot/`(0700)을 만든 다음 직접 `launchctl bootstrap gui/$(id -u) <plist>`로 설치한다. 중지는 `launchctl bootout gui/$(id -u)/com.rosy.reels-afterwork-autopilot`. 매 tick은 모델을 호출하지 않는다. `dist-cli`는 `npm run build:desktop`으로 갱신한다.

## 검증

- `tests/unit/autopilot.test.ts`: 모델 호출 없이 합성 fixture와 mock으로 admission 0/1/2/3/4, 수동 예외와 자동 위장 거절, 겹친 tick·`starting`/`running`/lease/pid 회수 경합·늦게 뜬 실행기, fingerprint 분리(`syncedAt`만 바뀐 snapshot은 `unchanged`)와 순서 기반 재계산, 기존 진행 중 포함 풀과 중복 배제, 실행기 args의 입력 원문, `progressed`/`prepared`/`needs_user` 구분과 프롬프트 금지 목록, `workdir` 없음, 파일 잠금(살아 있는 소유자 불가침·죽은 잠금 회수·교차 회수·자기 토큰 해제), 한도 판정, 상태 매핑(Inbox·review 이름을 모든 열린 타입에서 인식)·Linear 한정 풀(Dashboard 전용 카드 자동 0, 수동 허용)·중복·최신성 실패, 순위 변화, 수동 5개의 3+2 묶음과 바깥 프롬프트의 args JSON·긴 입력의 파일 분리와 오늘 볼 1개, `computeAutopilotView`, 실행기 실패 경로(null·한도·예외), workflow mock 실행을 검증한다.
- 실데이터 dry-run: `reels autopilot tick --dry-run`. Linear 가져오기가 없으면 `linear_missing`으로 자동 0건이 나오는 것이 정상이다. 실제 Linear 조회는 Keychain 키가 있는 사용자 환경에서 `reels autopilot refresh-linear --dry-run`으로 확인한다(이 저장소의 테스트는 실제 API를 부르지 않는다).
- `tests/unit/autopilot-linear.test.ts`: 공식 계약 모양의 fixture와 주입한 Keychain·`fetch`로(실제 Keychain·네트워크 호출 없음) 쿼리 필드 이름 스냅샷, 3페이지 완전 저장, 커서 반복·페이지 초과·GraphQL 오류·네트워크 실패·500 초과의 `linear_incomplete`와 저장 안 함, 다른 팀·workspace 이슈의 `linear_scope_mismatch`, 키가 속한 workspace가 다르면(이슈 0개여도) `linear_workspace_mismatch`와 올바른 workspace의 빈 큐 성공, 예약 직전·실행 직전 엄격 재확인(캐시 2 vs API 3, 조회 실패, 수동은 통과, 캐시 가득이면 API 0회), 키 없음·401·429, 키가 출력·오류·저장 파일·인자 어디에도 없음, 상태 매핑(`triage`·`duplicate` 포함)과 중첩 페이지 처리, 리비전 충돌 재읽기, tick의 갱신 성공/실패/젊은 사본, 같은 내용 재갱신 시 `unchanged`, `connect-linear`의 TTY 전용·`-w` 마지막 인자·값 없음, `disconnect-linear`, `refresh-linear` 출력을 검증한다.
- UI: `tests/web/autopilot-today.spec.ts`(headless, 폭 1500·390)가 오늘 볼 1개 있음·Dashboard project 열기·없음·사본 오래됨·인증 막힘과 일시정지를 확인하고, 캘린더 라벨은 `tests/web/publication-calendar.spec.ts`로 확인한다.
