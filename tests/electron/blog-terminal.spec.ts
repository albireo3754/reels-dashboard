import { test, expect } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { markupFixture } from '../fixtures/markup-editor';
import { cleanProfile, closeApp, launchApp, makeProfile } from './helpers';
import { openBlogEditor, editorIframe } from './blog-editor-helpers';

test('blog terminal passes current context, retains failed requests and selects the new session', async ({}, info) => {
  const profile = await makeProfile();
  let app;
  try {
    const root = join(profile, 'article');
    await mkdir(root);
    const config = await markupFixture(root);
    const original = await readFile(config.canon, 'utf8');
    await writeFile(join(profile, 'blog-projects.json'), JSON.stringify({ version: 1, projects: [{ id: 'article-a', title: '합성 글', config }] }));
    app = await launchApp(profile, true, { REELS_DEV_MODE: '1' });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '블로그', exact: true }).click();
    // Exercise the real preload/host/session path, replacing only the agent command
    // with a shell so QA never submits a model task or changes source files.
    await app.evaluate(({ ipcMain }) => {
      const qa = globalThis as any;
      const handler = (ipcMain as any)._invokeHandlers.get('reels:workbench:start');
      if (!handler) throw new Error('workbench start handler missing');
      qa.blogRequests = [];
      qa.failBlogStart = true;
      ipcMain.removeHandler('reels:workbench:start');
      ipcMain.handle('reels:workbench:start', async (event, input) => {
        if (input.kind === 'shell') return handler(event, input);
        qa.blogRequests.push(input);
        if (qa.failBlogStart) throw new Error('QA start failed');
        await new Promise(resolve => setTimeout(resolve, 150));
        return handler(event, { kind: 'shell' });
      });
    });
    await openBlogEditor(app, page, 'article-a');
    const iframe = editorIframe(page, 'article-a');
    const editorURL = await iframe.getAttribute('src');
    // The blog header no longer duplicates the toolbar's terminal toggle (⌘N / 터미널).
    const blog = page.getByRole('region', { name: '블로그 작업', exact: true });
    await expect(blog.getByRole('button', { name: '터미널 열기', exact: true })).toHaveCount(0);
    await expect(blog.getByRole('button', { name: '맥락과 함께 수정', exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: '터미널', exact: true }).click();
    const drawer = page.getByRole('region', { name: '터미널', exact: true });
    await expect(drawer).toBeVisible();
    // Session tabs live in the drawer; the blog's own mode/document tabs are a separate tablist.
    const sessionTabs = drawer.getByRole('tab');
    await page.getByRole('button', { name: '새 터미널', exact: true }).click();
    await expect(sessionTabs).toHaveCount(1);
    const firstId = await page.evaluate(async () => (await window.reels!.workbench!.state()).sessions[0].id);
    await page.getByRole('button', { name: '맥락과 함께 수정', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '블로그 화면 수정' });
    const start = dialog.getByRole('button', { name: '맥락을 넣어 Codex 열기', exact: true });
    await expect(start).toBeDisabled();
    const request = dialog.getByLabel('수정 요청', { exact: true });
    await request.press('Enter');
    await expect(dialog).toBeVisible();
    await request.fill('이 화면의 버튼 간격을 수정해주세요.');
    await request.press('Shift+Enter');
    await expect(request).toHaveValue('이 화면의 버튼 간격을 수정해주세요.\n');
    for (const extra of [{ isComposing: true }, { keyCode: 229 }, { repeat: true },
      { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      await request.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', ...extra });
    }
    expect(await app.evaluate(() => (globalThis as any).blogRequests)).toEqual([]);
    await request.fill('이 화면의 버튼 간격을 수정해주세요.');
    await dialog.getByText('전달할 맥락과 요청', { exact: true }).click();
    await expect(dialog.locator('pre')).toContainText('article-a');
    await expect(dialog.locator('pre')).toContainText('정본 스마트에디터');
    await expect(dialog.locator('pre')).not.toContainText(config.canon);
    // Clipboard success is verified without replacing the user's clipboard.
    await page.evaluate(() => { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text: string) => { (window as any).blogCopied = text; } }); });
    await dialog.getByRole('button', { name: '현재 세션용 프롬프트 복사' }).click();
    expect(await page.evaluate(() => (window as any).blogCopied)).toContain('이 화면의 버튼 간격');
    await request.press('Enter');
    await expect(dialog.getByRole('alert')).toContainText('QA start failed');
    await expect(dialog.getByLabel('수정 요청', { exact: true })).toHaveValue('이 화면의 버튼 간격을 수정해주세요.');
    await app.evaluate(() => { (globalThis as any).failBlogStart = false; });
    await request.evaluate(element => {
      for (let i = 0; i < 2; i++) element.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
      }));
    });
    await expect(dialog).not.toBeVisible();
    await expect(sessionTabs).toHaveCount(2);
    const requests = await app.evaluate(() => (globalThis as any).blogRequests);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ kind: 'codex', phase: 'implement' });
    expect(requests[1].task).toContain('article-a');
    expect(requests[1].task).toContain('이 화면의 버튼 간격');
    const secondId = await page.evaluate(async () => (await window.reels!.workbench!.state()).sessions[1].id);
    await expect(page.locator(`#dev-tab-${secondId}`)).toHaveAttribute('aria-selected', 'true');
    await expect(iframe).toBeVisible();
    await expect(iframe).toHaveAttribute('src', editorURL!);
    await page.screenshot({ path: info.outputPath('blog-terminal-open.png') });
    await expect.poll(async () => {
      const frame = (await iframe.boundingBox())!, panel = (await drawer.boundingBox())!;
      return Math.max(0, Math.round(frame.y + frame.height - panel.y - 1));
    }).toBe(0);
    // Subsequent state events must not force selection back to the requested tab.
    await page.locator(`#dev-tab-${firstId}`).click();
    await page.evaluate(async id => window.reels!.workbench!.stop(id), secondId);
    await expect(page.locator(`#dev-tab-${firstId}`)).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: '레퍼런스 추출·탐색', exact: true }).click();
    await page.getByRole('button', { name: '맥락과 함께 수정', exact: true }).click();
    await expect(dialog.locator('pre')).toContainText('선택 프로젝트: 없음');
    await expect(dialog.locator('pre')).not.toContainText('article-a');
    await expect(dialog.getByLabel('수정 요청', { exact: true })).toHaveValue('');
    await page.screenshot({ path: info.outputPath('blog-terminal-context.png') });
    expect(await readFile(config.canon, 'utf8')).toBe(original);
  } finally { await closeApp(app); await cleanProfile(profile); }
});

test('normal desktop blog does not expose development terminal actions', async () => {
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile, true, { REELS_DEV_MODE: undefined });
    const page = await app.firstWindow();
    await page.getByRole('button', { name: '블로그', exact: true }).click();
    await expect(page.getByRole('heading', { name: '블로그 작업', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '맥락과 함께 수정', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '터미널 열기', exact: true })).toHaveCount(0);
  } finally { await closeApp(app); await cleanProfile(profile); }
});
