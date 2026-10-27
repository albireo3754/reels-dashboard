import { expect, test, type Page } from '@playwright/test';

// Renderer-only contracts with explicitly synthetic media/jobs. FFmpeg and
// PhotoKit integration are covered by separate native/Electron QA.
async function openEditor(page: Page, extra = '') {
  await page.goto(`/?demo=1${extra ? `&${extra}` : ''}`);
  await page.getByRole('button', { name: '영상 편집', exact: true }).click();
  await expect(page.getByRole('heading', { name: '선택한 장면을 완성해요', exact: true })).toBeVisible();
}

async function importVideo(page: Page, extra = '') {
  await openEditor(page, extra);
  await page.getByRole('button', { name: '로컬 영상 열기', exact: true }).click();
  await expect(page.getByLabel('편집 원본 재생', { exact: true })).toBeVisible();
}

async function setValidSettings(page: Page) {
  await page.getByLabel('장소명', { exact: true }).fill('예시 산책길');
  await page.getByLabel('장소 설명', { exact: true }).fill('천천히 걷기 좋은 길');
  await page.getByRole('textbox', { name: '표지 훅', exact: true }).fill('천천히 걸으며\n발견한 풍경');
}

async function addCaption(page: Page, index: number, start: string, end: string, text: string) {
  await page.getByRole('button', { name: '자막 추가', exact: true }).click();
  await page.getByLabel(`자막 ${index} 시작`, { exact: true }).fill(start);
  await page.getByLabel(`자막 ${index} 끝`, { exact: true }).fill(end);
  await page.getByRole('textbox', { name: `자막 ${index} 내용`, exact: true }).fill(text);
}

test('local synthetic video decodes, plays and seeks without a media error', async ({ page }, testInfo) => {
  await importVideo(page);
  const video = page.getByLabel('편집 원본 재생', { exact: true });
  await expect.poll(() => video.evaluate((node) => (node as HTMLVideoElement).readyState)).toBeGreaterThanOrEqual(1);
  expect(await video.evaluate((node) => (node as HTMLVideoElement).duration)).toBeCloseTo(12, 1);
  await video.evaluate((node) => (node as HTMLVideoElement).play());
  await expect.poll(() => video.evaluate((node) => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(0);
  await video.evaluate((node) => (node as HTMLVideoElement).pause());
  await page.getByLabel('현재 시점', { exact: true }).fill('3.5');
  await expect.poll(() => video.evaluate((node) => (node as HTMLVideoElement).currentTime)).toBeCloseTo(3.5, 1);
  expect(await video.evaluate((node) => (node as HTMLVideoElement).error)).toBeNull();
  await setValidSettings(page);
  await page.getByRole('button', { name: '영상 미리보기 만들기', exact: true }).click();
  await expect(page.getByRole('img', { name: /영상 .* 합성 미리보기/ })).toBeVisible();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('editor-desktop.png'), fullPage: true });
});

test('place bundle defaults, manual positions, material and timing persist in the draft', async ({ page }) => {
  await importVideo(page);
  await setValidSettings(page);
  await expect(page.getByLabel('장소 안내 가로 위치', { exact: true })).toBeDisabled();
  await page.getByLabel('장소 안내 기본 배치 사용', { exact: true }).uncheck();
  await page.getByLabel('장소 안내 가로 위치', { exact: true }).fill('0.55');
  await page.getByLabel('장소 안내 세로 위치', { exact: true }).fill('0.28');
  await page.getByLabel('장소 핀 크기', { exact: true }).fill('0.05');
  await page.getByRole('combobox', { name: '설명 재질', exact: true }).selectOption('rectangle');
  await page.getByLabel('핀은 계속 표시', { exact: true }).uncheck();
  await page.getByLabel('장소 설명 표시 구간', { exact: true }).fill('0-4,8-end');
  await page.getByRole('button', { name: '편집 설정 저장', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '영상 편집', exact: true }).click();
  await page.getByRole('button', { name: '편집 기록 열기 예시 산책 영상.mp4', exact: true }).click();
  await expect(page.getByLabel('장소 안내 기본 배치 사용', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('장소 안내 가로 위치', { exact: true })).toHaveValue('0.55');
  await expect(page.getByLabel('장소 안내 세로 위치', { exact: true })).toHaveValue('0.28');
  await expect(page.getByLabel('장소 핀 크기', { exact: true })).toHaveValue('0.05');
  await expect(page.getByRole('combobox', { name: '설명 재질', exact: true })).toHaveValue('rectangle');
  await expect(page.getByLabel('핀은 계속 표시', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('장소 설명 표시 구간', { exact: true })).toHaveValue('0-4,8-end');
});

test('pin-only material permits an empty description but a tape requires it', async ({ page }) => {
  await importVideo(page);
  await page.getByLabel('장소명', { exact: true }).fill('예시 장소');
  await page.getByRole('button', { name: '영상 미리보기 만들기', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('장소 설명');
  await page.getByRole('combobox', { name: '설명 재질', exact: true }).selectOption('none');
  await page.getByRole('button', { name: '영상 미리보기 만들기', exact: true }).click();
  await expect(page.getByRole('img', { name: /영상 .* 합성 미리보기/ })).toBeVisible();
});

test('caption text and time errors are rejected and valid edits can be saved and deleted', async ({ page }) => {
  await importVideo(page);
  await setValidSettings(page);
  await addCaption(page, 1, '4', '2', '이 길을 천천히 걸었어요.');
  await page.getByRole('button', { name: '영상 미리보기 만들기', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('자막');
  await page.getByLabel('자막 1 시작', { exact: true }).fill('1');
  await page.getByLabel('자막 1 끝', { exact: true }).fill('3');
  await page.getByRole('textbox', { name: '자막 1 내용', exact: true }).fill('');
  await page.getByRole('button', { name: '영상 미리보기 만들기', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('자막');
  await page.getByRole('textbox', { name: '자막 1 내용', exact: true }).fill('이 길을 천천히 걸었어요.');
  await page.getByRole('button', { name: '영상 미리보기 만들기', exact: true }).click();
  await expect(page.getByRole('img', { name: /영상 .* 합성 미리보기/ })).toBeVisible();
  await page.getByRole('button', { name: '편집 설정 저장', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: '영상 편집', exact: true }).click();
  await page.getByRole('button', { name: '편집 기록 열기 예시 산책 영상.mp4', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '자막 1 내용', exact: true })).toHaveValue('이 길을 천천히 걸었어요.');
  await expect(page.getByLabel('자막 1 시작', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('자막 1 끝', { exact: true })).toHaveValue('3');
  await page.getByRole('button', { name: '자막 1 삭제', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '자막 1 내용', exact: true })).toHaveCount(0);
});

test('overlapping timed captions are rejected before preview and export', async ({ page }) => {
  await importVideo(page);
  await setValidSettings(page);
  await addCaption(page, 1, '0', '3', '첫 번째 자막이에요.');
  await addCaption(page, 2, '2', '4', '두 번째 자막이에요.');
  await page.getByRole('button', { name: '영상 미리보기 만들기', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/겹|overlap/i);
  await expect(page.getByRole('img', { name: /영상 .* 합성 미리보기/ })).toHaveCount(0);
  await page.getByRole('button', { name: '영상과 표지 내보내기', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(/겹|overlap/i);
  await expect(page.getByRole('progressbar', { name: '영상 내보내기 진행률' })).toHaveCount(0);
});

test('cover requires two lines and keeps hook and place pin positions independent', async ({ page }) => {
  await importVideo(page);
  await setValidSettings(page);
  await page.getByRole('textbox', { name: '표지 훅', exact: true }).fill('한 줄뿐인 제목');
  await page.getByRole('button', { name: '표지 미리보기 만들기', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('두 줄');
  await page.getByRole('textbox', { name: '표지 훅', exact: true }).fill('첫 번째 줄\n두 번째 줄');
  await page.getByLabel('표지 시점', { exact: true }).fill('2');
  await expect(page.getByLabel('표지 훅 가로 위치', { exact: true })).toBeDisabled();
  await page.getByLabel('표지 기본 배치 사용', { exact: true }).uncheck();
  await page.getByLabel('표지 훅 가로 위치', { exact: true }).fill('0.08');
  await page.getByLabel('표지 훅 세로 위치', { exact: true }).fill('0.62');
  await page.getByLabel('표지 장소 핀 가로 위치', { exact: true }).fill('0.5');
  await page.getByLabel('표지 장소 핀 세로 위치', { exact: true }).fill('0.2');
  await page.getByRole('combobox', { name: '표지 글자 크기 방식', exact: true }).selectOption('rosy-large');
  await page.getByRole('button', { name: '표지 미리보기 만들기', exact: true }).click();
  await expect(page.getByRole('img', { name: '표지 2.00초 합성 미리보기' })).toBeVisible();
  await expect(page.getByLabel('장소 안내 가로 위치', { exact: true })).toHaveValue('0.5');
  await expect(page.getByLabel('장소 안내 세로 위치', { exact: true })).toHaveValue('0.24');
});

test('editing settings invalidates an already generated preview', async ({ page }) => {
  await importVideo(page);
  await setValidSettings(page);
  await page.getByRole('button', { name: '영상 미리보기 만들기', exact: true }).click();
  await expect(page.getByRole('img', { name: /영상 .* 합성 미리보기/ })).toBeVisible();
  await page.getByLabel('장소명', { exact: true }).fill('바꾼 예시 장소');
  await expect(page.getByRole('img', { name: /합성 미리보기/ })).toHaveCount(0);
  await expect(page.getByText('현재 설정의 합성 미리보기를 만들어주세요.', { exact: true })).toBeVisible();
});

test('synthetic export progresses while viewing the dashboard and updates its stage', async ({ page }) => {
  await importVideo(page);
  await setValidSettings(page);
  await page.getByRole('button', { name: '영상과 표지 내보내기', exact: true }).click();
  await expect(page.getByRole('progressbar', { name: '영상 내보내기 진행률' })).toBeVisible();
  await expect(page.getByRole('button', { name: '로컬 영상 열기', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '대시보드', exact: true }).click();
  const card = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '예시 산책 영상.mp4', exact: true }) });
  await expect(card).toContainText('검토 대기', { timeout: 10_000 });
  await page.getByRole('button', { name: '영상 편집', exact: true }).click();
  await expect(page.getByRole('heading', { name: '내보내기 완료', exact: true })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: '영상 내보내기 진행률' })).toHaveAttribute('value', '100');
  await page.getByRole('button', { name: '결과 폴더 열기', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('실제 결과 파일을 만들지 않아요');
});

test('cancelled synthetic export never exposes completed output controls', async ({ page }) => {
  await importVideo(page);
  await setValidSettings(page);
  await page.getByRole('button', { name: '영상과 표지 내보내기', exact: true }).click();
  await page.getByRole('button', { name: '내보내기 취소', exact: true }).click();
  await expect(page.getByRole('heading', { name: '내보내기 취소됨', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '결과 폴더 열기', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '로컬 영상 열기', exact: true })).toBeEnabled();
});

test('Photos video selection hands its identity to the editor and creates a dashboard project', async ({ page }) => {
  await page.goto('/?demo=1');
  await page.getByRole('button', { name: '촬영 보관함', exact: true }).click();
  await page.getByLabel('촬영 날짜', { exact: true }).fill('2026-08-16');
  await page.getByRole('button', { name: '날짜 색인', exact: true }).click();
  await page.getByRole('button', { name: /그룹 .* · \d+개/ }).first().click();
  await expect(page.getByRole('button', { name: '이 영상 편집 DEMO_002.HEIC', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '이 영상 편집 DEMO_001.MOV', exact: true }).click();
  await expect(page.getByLabel('편집 원본 재생', { exact: true })).toBeVisible();
  await expect(page.getByText('Photos 예시 demo-asset-1.mov', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '대시보드', exact: true }).click();
  await expect(page.getByRole('article').filter({ hasText: 'Photos 예시 demo-asset-1.mov' })).toContainText('편집 중');
});

test('shared web mode explains desktop-only editing and provides no import/export actions', async ({ page }) => {
  await page.route('**/snapshot.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ schemaVersion: 1, generatedAt: '2026-10-27T12:00:00Z', projects: [] }) }));
  await page.goto('/');
  await page.getByRole('button', { name: '영상 편집', exact: true }).click();
  await expect(page.getByText('영상 편집은 데스크톱에서 이어가요.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '로컬 영상 열기', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '영상과 표지 내보내기', exact: true })).toHaveCount(0);
});

test('unavailable editor runtime disables import and displays the reason', async ({ page }) => {
  await openEditor(page, 'demoEditorUnavailable=1');
  await expect(page.getByRole('alert')).toContainText('편집 도구를 사용할 수 없어요');
  await expect(page.getByRole('button', { name: '로컬 영상 열기', exact: true })).toBeDisabled();
});

test('preview failure remains explicit and does not show a synthetic success image', async ({ page }) => {
  await importVideo(page, 'demoPreviewError=1');
  await setValidSettings(page);
  await page.getByRole('button', { name: '영상 미리보기 만들기', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('미리보기 오류');
  await expect(page.getByRole('img', { name: /합성 미리보기/ })).toHaveCount(0);
});

test('failed synthetic render does not claim completion or expose output paths', async ({ page }) => {
  await importVideo(page, 'demoRenderError=1');
  await setValidSettings(page);
  await page.getByRole('button', { name: '영상과 표지 내보내기', exact: true }).click();
  await expect(page.getByRole('heading', { name: '내보내기 실패', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('렌더 오류');
  await expect(page.getByRole('button', { name: '결과 폴더 열기', exact: true })).toHaveCount(0);
});

test('HDR source metadata is distinguished from the SDR playback proxy', async ({ page }) => {
  await importVideo(page, 'demoHDR=1');
  await expect(page.getByText('원본 HDR · 재생용 SDR 프록시', { exact: true })).toBeVisible();
  await expect(page.getByText(/내보내기는 HDR 원본을 사용해요/)).toBeVisible();
});

test('mobile editor retains named controls without horizontal overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await importVideo(page);
  await setValidSettings(page);
  await addCaption(page, 1, '0', '2', '천천히 걸어봤어요.');
  await page.getByRole('button', { name: '표지 미리보기 만들기', exact: true }).click();
  await expect(page.getByRole('img', { name: /표지 .* 합성 미리보기/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('editor-mobile.png'), fullPage: true });
});
