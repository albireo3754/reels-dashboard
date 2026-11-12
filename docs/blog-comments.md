# 블로그 댓글 기록

다른 네이버 블로그 글에 남긴(또는 남길) 댓글과 답방 결과를 앱 프로필에 저장한다. 에이전트가 새 댓글 초안을 쓰기 전에 이전 댓글을 참고하고 같은 글을 중복 기록하지 않게 하는 용도다. 앱은 기록만 하며 네이버에 댓글 등록, 공감, 서로이웃 신청을 하지 않는다.

## 저장

- 파일: `<userData>/blog-comments.json` (`{version: 1, comments: [...]}`, 0600, 원자적 쓰기, 쓰기 직렬화). 공개 Git에 포함하지 않는다.
- 레코드: `id`, `blogId`, `logNo`, `postUrl`(`https://m.blog.naver.com/<blogId>/<logNo>`로 정규화), `postTitle?`, `reciprocity?`(상대의 반사·서이웃 선언 요약), `status`, `text?`(실제로 단 댓글), `alternatives?`(제안한 초안 최대 5개), `note?`, `postedAt?`(YYYY-MM-DD), `createdAt`, `updatedAt`.
- 상태: `draft` → `posted` → `reciprocated` / `no_reply` → `neighbor`.
- 상대 글 본문, 다른 사람 댓글, 프로필은 저장하지 않는다.

## 도구 (MCP · `reels` CLI)

| 도구 | CLI | 동작 |
| --- | --- | --- |
| `reels_list_blog_comments {blogId?, postUrl?, status?, query?, limit=50}` | `reels list-blog-comments` | 최신순 목록과 `total`. `query`는 댓글, 초안, 제목, 메모 부분 일치. 읽기 전용. |
| `reels_create_blog_comment {postUrl, ...}` | `reels create-blog-comment` | 글 하나당 기록 하나. 같은 글이면 `DUPLICATE`. 기본 상태 `draft`. |
| `reels_update_blog_comment {id, expectedUpdatedAt, ...}` | `reels update-blog-comment` | 일부 필드 수정. 오래된 `updatedAt`이면 `STALE_COMMENT`. |
| `reels_remove_blog_comment {id, expectedUpdatedAt}` | `reels remove-blog-comment` | 기록 삭제. 네이버의 댓글에는 영향이 없다. MCP 도구 이름에 `delete`를 쓰지 않는 규칙에 따라 `remove`로 이름 붙였다. |

`postUrl`은 `blog.naver.com/<id>/<번호>`, `m.blog.naver.com/<id>/<번호>`, `PostView.naver?blogId=&logNo=` 형식을 받는다.

## 사용처

- Claude Code·Codex: Obsidian `side/blog/rosy/skills/blog-first-comment`
- Aside 브라우저: `~/.aside/u/0/skills/user/blog-first-comment`

## 검증 — 2026-11-12

- `tests/unit/blog-comments.test.ts` 4개(URL 정규화, CRUD·중복·revision, 동시 생성 직렬화, 도구 노출·포트 없음 `UNSUPPORTED`·strict 입력) 통과. `agent.test.ts`·`reels-cli.test.ts`·`blog-results.test.ts` 포함 76개 통과, `tsc --noEmit`, `check:architecture` 통과.
- 임시 경로로 CLI를 번들해 `reels tools`에 네 명령과 플래그가 생기는 것을 확인했다. 실행 중인 앱에 대한 실제 호출과 `dist-cli`·`dist-electron` 재빌드는 하지 않았다(당시 앱 꺼짐, 다른 작업의 미커밋 변경 진행 중).
- UI 탭은 없다.
