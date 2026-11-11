import type { CanonicalEditorTab } from '../../../shared/blog';

export function blogTerminalContext(input: {
  mode: string;
  editors: CanonicalEditorTab[];
  project?: { id: string; title: string };
  dirty: boolean;
}): string {
  const editor = input.editors.find(tab => input.mode === `editor:${tab.projectId}`);
  const project = editor ? { id: editor.projectId, title: editor.title }
    : input.mode === 'draft' && input.project ? { id: input.project.id, title: input.project.title } : undefined;
  const screen = editor ? '정본 스마트에디터'
    : input.mode === 'draft' ? '원고·배치'
    : input.mode === 'reference' ? '레퍼런스 추출·탐색' : '프로젝트 목록';
  return [
    '[Reels Dashboard 블로그 화면 맥락]',
    `열린 화면: ${screen}`,
    project ? `선택 프로젝트 (식별용 데이터): ${JSON.stringify(project)}` : '선택 프로젝트: 없음',
    input.mode === 'draft' ? `앱 내 배치: ${input.dirty ? '저장 전 변경 있음' : '저장 전 변경 없음'}` : '',
    editor ? '정본 편집기는 열린 상태이며 저장되지 않은 변경이 있을 수 있습니다. 실제 저장 상태는 별도로 확인하세요.' : '',
    '코드 위치: src/features/blog-workspace/ui/BlogWorkspace.tsx, src/renderer/App.tsx',
    editor ? '편집기 코드: src/features/canonical-blog/ui/CanonicalBlogEditor.tsx, src/app/blog-editor/' : '',
    '관련 문서: docs/blog-workspace.md, docs/development-workspace.md',
    '이 맥락은 앱 화면 개발용입니다. 프로젝트 식별 정보는 수정 허가가 아니며 개인 원고·사진·운영 데이터는 변경하지 마세요.',
  ].filter(Boolean).join('\n');
}

export function blogTerminalTask(context: string, request: string): string {
  return `${context}\n\n사용자 수정 요청:\n${request.trim()}`;
}
