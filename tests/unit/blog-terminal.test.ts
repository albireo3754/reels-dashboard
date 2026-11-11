import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blogTerminalContext, blogTerminalTask } from '../../src/features/blog-workspace/model/terminal-context';
import { terminalCommand } from '../../src/desktop/workbench';

const editors = [{ projectId: 'editor-a', title: '편집 중인 글', url: 'http://127.0.0.1:1234/?token=private' }];
const project = { id: 'draft-b', title: '배치 초안', resources: [{ path: '/private/manuscript.md' }], nextAction: 'private note' };
test('blog context follows the visible tab and includes only project identity', () => {
  const input = { mode: 'editor:editor-a', editors, project, dirty: true };
  const editor = blogTerminalContext(input);
  assert.match(editor, /editor-a/);
  assert.match(editor, /저장되지 않은 변경이 있을 수/);
  assert.doesNotMatch(editor, /draft-b|private|token|1234/);
  const draft = blogTerminalContext({ ...input, mode: 'draft' });
  assert.match(draft, /draft-b/);
  assert.match(draft, /저장 전 변경 있음/);
  assert.doesNotMatch(draft, /editor-a|private|resources|nextAction/);
  for (const mode of ['projects', 'reference']) {
    const context = blogTerminalContext({ ...input, mode });
    assert.match(context, /선택 프로젝트: 없음/);
    assert.doesNotMatch(context, /editor-a|draft-b|저장 전 변경 있음/);
  }
});

test('blog request becomes the agent initial prompt with the existing scope and shell quoting', () => {
  const context = blogTerminalContext({ mode: 'projects', editors: [], dirty: false });
  const task = blogTerminalTask(context, "  버튼 '폭' 수정 $(echo hidden)\n다음 줄  ");
  const command = terminalCommand({ kind: 'codex', phase: 'implement', task });
  assert.match(command!, /블로그 화면 맥락/);
  assert.match(command!, /src\/features\/blog-workspace\/ui\/BlogWorkspace.tsx/);
  assert.match(command!, /외부 게시·배포·push, 개인 자료 변경은 이 요청에 포함되지 않습니다/);
  assert.ok(command!.includes("'\\''폭'\\''"));
  assert.match(command!, /workspace-write/);
});
