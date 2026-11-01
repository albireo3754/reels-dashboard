import { test, expect } from '@playwright/test';
import { mkdir, writeFile, realpath, stat, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { launchApp, makeProfile, closeApp, cleanProfile } from './helpers';

test('face candidates can be reviewed, added, removed and strength adjusted', async () => {
  const profile = await realpath(await makeProfile()); let app;
  try {
    const media = path.join(profile, 'media'); await mkdir(media);
    const source = path.join(media, 'synthetic.jpg');
    execFileSync(path.resolve('native/editor-engine/.build/runtime/bin/ffmpeg'), ['-v','error','-f','lavfi','-i','color=blue:size=200x200','-frames:v','1',source]);
    const info = await stat(source);
    const project = {id:'mosaic-test', title:'모자이크 테스트', date:'2026-10-31', stage:'review', nextAction:'', publicURL:'', shared:false, resources:[{role:'folder',path:media,label:'사진'}]};
    await writeFile(path.join(profile,'dashboard.json'), JSON.stringify({schemaVersion:1,updatedAt:'2026-10-31T00:00:00.000Z',projects:[project]}));
    await mkdir(path.join(profile,'media-analysis'));
    const fields = {description:'합성 사진',tags:[],ocr:[],uncertainties:[],faceRegions:[{x:.1,y:.1,width:.2,height:.2}]};
    const doc = {schemaVersion:1,projectId:project.id,revision:1,runs:[],corrections:{},results:[{sample:{id:'sample',sourcePath:source,sourceVersion:createHash('sha256').update(`${info.size}:${info.mtimeMs}`).digest('hex'),kind:'photo',time:null,imagePath:source},provider:'fake',runId:'run',analyzedAt:'2026-10-31',fields}]};
    await writeFile(path.join(profile,'media-analysis',createHash('sha256').update(project.id).digest('hex')+'.json'),JSON.stringify(doc));
    app=await launchApp(profile,false); const page=await app.firstWindow();
    await page.getByRole('button',{name:'사진·영상 메타데이터 분석'}).click();
    await page.getByRole('button',{name:'얼굴 모자이크 검토'}).click();
    await expect(page.getByRole('img',{name:'분석 이미지'})).toBeVisible();
    await page.getByRole('button',{name:'얼굴 영역 1'}).click();
    await page.getByRole('button',{name:'선택 영역 삭제'}).click();
    await expect(page.getByText('선택한 영역: 없음 / 0개')).toBeVisible();
    const box=await page.getByRole('img',{name:'분석 이미지'}).boundingBox(); if(!box) throw Error('no image');
    await page.mouse.move(box.x+100,box.y+100); await page.mouse.down(); await page.mouse.move(box.x+150,box.y+150); await page.mouse.up();
    await expect(page.getByRole('button',{name:'얼굴 영역 1'})).toBeVisible();
    await page.getByLabel('모자이크 강도').fill('30');
    await expect(page.getByText('30px')).toBeVisible();
    const output = path.join(profile, 'reviewed.png');
    const before = await readFile(source);
    await app.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, output);
    await page.getByRole('button', {name:'모자이크 사본 저장'}).click();
    await expect(page.getByRole('status').filter({hasText:'저장됨:'})).toBeVisible();
    expect((await readFile(output)).subarray(0, 8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));
    const plan = JSON.parse(await readFile(output + '.mosaic.json', 'utf8'));
    expect(plan.blockSize).toBe(30);
    expect(plan.regions).toHaveLength(1);
    expect(plan.regions[0].x).toBeCloseTo(.5, 2);
    expect(plan.regions[0].width).toBeCloseTo(.25, 2);
    expect(await readFile(source)).toEqual(before);
  } finally {if(app) await closeApp(app); await cleanProfile(profile);}
});
