# 소재 선정 (topic pitches)

2026-11-18 사용자 요청: "작업 중 큐·완료 상태는 잘 보이는데 작업 소재 선정 같은 게 없다. PC는 릴스 대시보드, 모바일은 GPT 사이트에서 파악하기 쉽게."

## 무엇을 저장하나

`Project.pitches?: TopicPitch[]` (최대 8개, 계약은 `src/shared/topic-pitch.ts`). 한 후보는 **잘된 훅 계열 × 우리 영상 소스**의 초안이다.

| 필드 | 뜻 |
| --- | --- |
| `title`, `channel` | 무엇을 어느 채널에 |
| `hookFamily`, `basedOn[]` | 빌려 오는 훅 계열과, 그 훅이 잘됐다는 관찰(예 `저장 1.84% · 공유 1.68%`) |
| `coverHooks[]` | 표지 훅 후보. ` / `로 두 줄을 나눈다. 첫 번째가 추천 |
| `captionHead`, `hypothesis` | 캡션 첫 줄, 이번에 확인할 가설 |
| `source` | 쓸 소스와 상태(완성본·미편집 등) |
| `effort` | S·M·L |
| `readiness` | `ready` 바로 올릴 수 있음 · `needs_edit` 편집하면 됨 · `needs_user` 내 답 필요 · `hold` 보류 |
| `asks[]` | 사용자만 답할 수 있는 질문(맛·경험·동의). 사실은 조사로 메운다 |
| `rank`, `decision` | 추천 순서, 사용자 결정(`proposed`·`picked`·`dropped`) |

후보는 소스를 가진 카드에 붙는다. 새 아이디어는 먼저 `idea` 단계 카드를 만든다. 공유 스냅샷(`toSnapshot`)에는 들어가지 않는다. 모바일로 미러링되므로 로컬 경로·인증정보·인사이트 원자료를 넣지 않고, 근거는 사람이 쓴 한 줄(`evidence`)로만 둔다. 대본·캡션 정본은 콘텐츠 작업공간 문서다.

## 보는 곳

- 데스크톱 대시보드 탭: 이번 주 목표 아래 **소재 선정**. 맨 위 한 줄에 채워야 할 칸과 후보 수(`다음 주 릴스 2편 남음 · 후보 7 (바로 1 · 편집 1 · 내 답 4 · 보류 1)`)를 보여 준다. 정렬은 선정 → 준비도 → 추천 순서. 행마다 추천 표지 훅과 내 답 필요 질문을 보여 주고, **근거**로 다른 표지·캡션 첫 줄·빌린 훅·소스·가설·연결 카드를 펼친다. **선정·제외·선정 취소**는 최신 저장본을 다시 읽어 그 revision으로 저장하므로 열린 편집기를 덮지 않는다. 결정은 단계·채널을 바꾸지 않는다.
- 모바일 브리핑: 브리지가 `monitor.topics`에 같은 보드(`topicBoard`)를 실어 보낸다. 사이트는 읽기 전용으로 보여 준다(사이트 저장소 `sites/mobile-briefing`).

## MCP·CLI

| 도구 | CLI | 하는 일 |
| --- | --- | --- |
| `reels_get_topic_board` | `reels get-topic-board` | 보드 읽기(주간 목표의 남은 칸 포함) |
| `reels_set_pitches` | `reels set-pitches` | 한 카드의 후보 목록 교체. 빈 목록이면 삭제 |
| `reels_decide_pitch` | `reels decide-pitch` | 선정·제외·되돌리기. 사용자가 한 결정만 기록 |

쓰기 도구는 `dashboard.updatedAt`을 `expectedUpdatedAt`으로 받는다.

## 검증

- 단위: `tests/unit/topic-pitch.test.ts` — 정렬·집계·남은 칸 필터, 스키마 거부(중복 ID·모르는 필드·빈 훅), 대시보드 검증 보존, setPitches/decidePitch가 다른 필드를 안 바꾸고 전체 upsert 뒤에도 남는지, 낡은 revision 거부.
- 웹 e2e: `tests/web/topic-selection.spec.ts` — 순서·요약·근거 펼치기, 선정·제외 저장과 새로고침 뒤 유지, 1500·760·390px 가로 넘침 없음.
