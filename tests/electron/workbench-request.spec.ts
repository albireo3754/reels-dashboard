import { test, expect } from '@playwright/test';
import { cleanProfile, closeApp, launchApp, makeProfile } from './helpers';

test('request Enter starts the selected tool once, preserves failures and allows multiline/IME input', async () => {
  const profile = await makeProfile();
  let app;
  try {
    app = await launchApp(profile, true, { REELS_DEV_MODE: '1' });
    const page = await app.firstWindow();
    // Keep the real bridge and session lifecycle, but never send a model task.
    await app.evaluate(({ ipcMain }) => {
      const qa = globalThis as any;
      const handler = (ipcMain as any)._invokeHandlers.get('reels:workbench:start');
      if (!handler) throw new Error('workbench start handler missing');
      qa.requestInputs = [];
      qa.failRequest = true;
      ipcMain.removeHandler('reels:workbench:start');
      ipcMain.handle('reels:workbench:start', async (event, input) => {
        qa.requestInputs.push(input);
        if (qa.failRequest) throw new Error('QA request failed');
        await new Promise(resolve => { qa.releaseRequest = resolve; });
        return handler(event, { kind: 'shell' });
      });
    });
    await page.getByRole('button', { name: '터미널', exact: true }).click();
    await page.getByTestId('dev-settings-toggle').click();
    const task = page.locator('#dev-task');
    await task.fill('   ');
    await task.press('Enter');
    await expect(task).toHaveValue('   ');
    await task.fill('버튼 간격 수정');
    await task.press('Shift+Enter');
    await task.press('Shift+Enter');
    await expect(task).toHaveValue('버튼 간격 수정\n\n');
    for (const extra of [{ isComposing: true }, { keyCode: 229 }, { repeat: true },
      { ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      await task.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', ...extra });
    }
    expect(await app.evaluate(() => (globalThis as any).requestInputs)).toEqual([]);
    await page.getByRole('combobox', { name: '코딩 도구' }).selectOption('claude');
    await page.getByRole('group', { name: '개선 단계' }).getByRole('button').last().click();
    await task.press('Enter');
    await expect(page.getByRole('alert')).toContainText('QA request failed');
    await expect(task).toHaveValue('버튼 간격 수정\n\n');
    await app.evaluate(() => { (globalThis as any).failRequest = false; });
    await task.evaluate(element => {
      for (let i = 0; i < 2; i++) element.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
      }));
    });
    await expect.poll(() => app!.evaluate(() => (globalThis as any).requestInputs.length)).toBe(2);
    await expect(page.getByTestId('dev-start-selected')).toBeDisabled();
    await task.press('Enter');
    const requests = await app.evaluate(() => {
      const qa = globalThis as any;
      qa.releaseRequest();
      return qa.requestInputs;
    });
    expect(requests).toEqual([
      { kind: 'claude', phase: 'fix', permission: 'ask', task: '버튼 간격 수정\n\n' },
      { kind: 'claude', phase: 'fix', permission: 'ask', task: '버튼 간격 수정\n\n' },
    ]);
    await expect(page.getByRole('tab')).toHaveCount(1);
    await expect(page.getByRole('tab')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  } finally { await closeApp(app); await cleanProfile(profile); }
});
