export const meta = {
  name: 'afterwork-autopilot',
  description: '퇴근 후 autopilot: 예약된 항목마다 입력 원문과 정본을 읽고 허용된 로컬 다음 작업 1단위를 실제로 수행한다. 외부 게시·업로드·상태 변경은 하지 않는다.',
  phases: [{ title: 'Progress', detail: '항목당 에이전트 1개(최대 3), 변경·검증 근거와 보고서를 검사해 passed를 반환' }],
}
// Registered by linking this file into ~/.claude/workflows/afterwork-autopilot.js (docs/autopilot.md).
// args: {runId, runDir, items: [{key, title, url?, kind, stage?, nextAction?, reasons, input}], dryRun?}
//   input.linear?  {identifier, stateName?, sourceUrl?, description?, descriptionPath?, descriptionTruncated?}
//     descriptionPath: the full description in a run file (description then holds a short preview); the worker Reads it first.
//   input.project? {id, stage, nextAction, localNotes?, resources?, reread}
const A = typeof args === 'string' ? JSON.parse(args) : (args || {})
const items = Array.isArray(A.items) ? A.items : []
if (A.dryRun === true || items.length === 0) return { passed: true, items: [] }

const MAX_ITEMS = 3
const abs = p => typeof p === 'string' && p.startsWith('/') && !p.split('/').includes('..')
if (!/^[A-Za-z0-9_-]+$/.test(A.runId ?? '') || !abs(A.runDir)) throw new Error('afterwork-autopilot requires runId and an absolute runDir')
if (items.length > MAX_ITEMS) throw new Error(`afterwork-autopilot takes at most ${MAX_ITEMS} items, got ${items.length}`)
const kinds = ['review', 'active', 'candidate']
const safe = key => String(key).replace(/[^A-Za-z0-9_-]/g, '_')
const seen = new Set()
for (const item of items) {
  if (typeof item?.key !== 'string' || !item.key || typeof item.title !== 'string' || !kinds.includes(item.kind)) throw new Error('Each item needs key, title and kind')
  // A title alone is not enough to work from: the source text or the project fields must come with it.
  if (!item.input || typeof item.input !== 'object' || (!item.input.linear && !item.input.project)) throw new Error(`Item ${item.key} has no input text (input.linear or input.project)`)
  if (seen.has(safe(item.key))) throw new Error(`Duplicate item key: ${item.key}`)
  seen.add(safe(item.key))
}

const STATUSES = ['progressed', 'prepared', 'blocked', 'needs_user']
const schema = {
  type: 'object',
  properties: {
    key: { type: 'string' },
    status: { type: 'string', enum: STATUSES },
    summary: { type: 'string' },
    reportPath: { type: 'string' },
    decision: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' } },
    changes: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, summary: { type: 'string' } }, required: ['path', 'summary'] } },
    verification: { type: 'array', items: { type: 'object', properties: { cmd: { type: 'string' }, check: { type: 'string' }, result: { type: 'string' } }, required: ['result'] } },
  },
  required: ['key', 'status', 'summary', 'reportPath', 'decision', 'sources', 'changes', 'verification'],
}
const reportFor = item => `${A.runDir}/${safe(item.key)}.md`

// Why a result does not count. progressed means real, verified changes; prepared means none were made.
const problem = (r, item) => {
  if (!r || typeof r !== 'object') return 'result_missing'
  if (r.key !== item.key || r.reportPath !== reportFor(item)) return 'result_mismatch'
  if (!STATUSES.includes(r.status)) return 'invalid_status'
  const changes = Array.isArray(r.changes) ? r.changes : []
  const verification = Array.isArray(r.verification) ? r.verification : []
  if (r.status === 'progressed') {
    if (!changes.length || changes.some(c => !c || !c.path || !c.summary)) return 'progressed_without_changes'
    if (!verification.length || verification.some(v => !v || !(v.cmd || v.check) || !v.result)) return 'progressed_without_verification'
  }
  if (r.status === 'prepared' && changes.length) return 'prepared_with_changes'
  return null
}

const PROMPT_RULES = `
## 먼저 읽는 것 (이 순서)
1. 아래 "입력 원문"(Linear description, Dashboard nextAction·localNotes·resources). 입력에 descriptionPath가 있으면 description은 미리보기일 뿐이므로 Read 도구로 그 파일(실행 폴더 안)을 먼저 읽는다. 이 Read는 허용된다. 잘렸다면(descriptionTruncated) sourceUrl이 원문이다.
2. Dashboard 항목이면 \`reels get-project --project-id <id>\`로 최신 원문을 다시 읽는다(앱이 꺼져 있으면 입력 원문만 쓴다).
3. 연결된 콘텐츠 정본 문서와 그 폴더의 AGENTS.md / README, 기존 제작 workflow·skill.
읽은 경로는 모두 sources에 적는다. 읽지 않은 것을 읽었다고 쓰지 않는다.

## 하는 일
위 지침이 허용하는 **로컬 다음 작업 1단위**를 실제로 수행한다. 체크리스트만 쓰는 것은 진행이 아니다.
예: 콘텐츠 정본 문서 수정, 로컬 검증 실행, \`reels\` CLI의 로컬 쓰기 도구와 기존 YAML 제작 workflow 진행.
작업 디렉터리 밖은 읽기만 하고, 보고서 파일(아래 보고서 경로)만 예외로 쓴다.

## 금지
- 외부 게시·업로드·계정·결제·삭제, 원본 사진·영상 이동·삭제
- Linear·외부 서비스에 쓰기, Dashboard 단계·게시 상태 변경
- Edits 앱 조작(점유 규칙이 필요해 자동에서는 제외)
- 범위 밖 앱·회사 업무 저장소 조작
- git commit/push
- 사용자의 경험·취향·사실을 추정해서 채우기, 인증정보 사용·출력

## needs_user 규칙
입력 원문과 정본에서 근거를 찾지 못했거나 사용자 경험·취향·사실·인증이 필요하면 만들어 내지 말고 **수정하지 않은 채** status를 needs_user로 멈춘다. 빈칸은 보고서에 빈칸으로 남기고 decision에 필요한 한 가지를 쓴다.

## status
- progressed: 파일 등을 실제로 바꿨다. changes([{path, summary}])와 verification([{cmd 또는 check, result}])이 모두 비어 있으면 안 된다.
- prepared: 변경 없이 준비 보고만 했다. changes는 빈 배열.
- blocked: 진행할 수 없다. 이유를 summary에.
- needs_user: 위 규칙으로 멈췄다.

## 보고서
보고서에 읽은 출처 경로, 변경 파일, 검증 근거, 남은 결정 1개를 적는다.`

phase('Progress')
const results = await parallel(items.map(item => () => agent(`
# 역할: 퇴근 후 autopilot 작업 담당 (항목 1개)
항목: ${JSON.stringify({ key: item.key, title: item.title, url: item.url, kind: item.kind, stage: item.stage, nextAction: item.nextAction, reasons: item.reasons })}
입력 원문: ${JSON.stringify(item.input)}
${PROMPT_RULES}
보고서 경로: ${reportFor(item)}
반환: key는 "${item.key}" 그대로, reportPath는 "${reportFor(item)}", decision에는 사용자가 내려야 할 한 가지 결정을 한 문장으로.`,
  { label: `progress:${safe(item.key)}`, phase: 'Progress', model: 'sonnet', effort: 'medium', schema })))

// A missing result is never dropped: one null makes the whole run incomplete.
if (results.some(r => !r)) {
  log(`incomplete: ${results.filter(r => !r).length}/${items.length} agents returned nothing`)
  return { passed: false, incomplete: true, reason: 'agent_result_missing', items: [] }
}
const problems = results.map((r, i) => problem(r, items[i]))
const bad = problems.findIndex(p => p)
if (bad !== -1) return { passed: false, incomplete: false, reason: `${problems[bad]}: ${items[bad].key}`, items: [] }
return { passed: true, items: results }
