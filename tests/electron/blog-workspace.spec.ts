import {test,expect} from '@playwright/test';
import {mkdir,writeFile,readFile,realpath} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {launchApp,makeProfile,closeApp,cleanProfile} from './helpers';

test('blog imports selected spec after review, previews local photo and persists private layout',async({}, testInfo)=>{
 const profile=await realpath(await makeProfile());let app;
 try {
  const media=path.join(profile,'media');await mkdir(media);const photo=path.join(media,'photo.png');
  execFileSync(path.resolve('native/editor-engine/.build/runtime/bin/ffmpeg'),['-v','error','-f','lavfi','-i','color=blue:size=100x100','-frames:v','1',photo]);
  const spec={title:'여행 기록',layout:{background:'#ffffff',headingColor:'#85613f',paragraphSize:16,mobileParagraphSize:17},fonts:{body:'sans'},spans:[{text:'강조',weight:700,color:'#a64132'}],blocks:[{type:'heading',text:'제목'},{type:'info',text:'방문 정보'},{type:'paragraph',text:'강조 문장'},{type:'image',src:'media/photo.png',alt:'테스트 사진'},{type:'source',text:'[참고 자료](https://example.org/info)'},{type:'native-map',label:'지도 자리'}]};
  const raw='개인 메모는 본문 아님\n\n```json\n'+JSON.stringify(spec)+'\n```\n\n과거 원고';const doc=path.join(profile,'source.md');await writeFile(doc,raw);
  const project={id:'blog-test',title:'블로그 테스트',date:'2026-10-31',stage:'review',nextAction:'',publicURL:'',shared:false,resources:[{role:'document',path:doc,label:'원고'},{role:'folder',path:media,label:'사진'}]};
  await writeFile(path.join(profile,'dashboard.json'),JSON.stringify({schemaVersion:1,updatedAt:'2026-10-31T00:00:00.000Z',projects:[project]}));
  app=await launchApp(profile,false);let page=await app.firstWindow();
  await page.getByRole('button',{name:'블로그',exact:true}).click();await page.getByRole('button',{name:'원고·배치',exact:true}).click();await page.getByLabel('블로그 프로젝트',{exact:true}).selectOption(project.id);
  await page.getByLabel('블로그 원고').selectOption(doc);await page.getByRole('button',{name:'원고 열기'}).click();
  await page.getByLabel('블로그 사진 폴더').selectOption(media);
  const source=page.getByLabel('원고 내용 선택');await source.evaluate((el:HTMLTextAreaElement)=>{const start=el.value.indexOf('```json');const end=el.value.indexOf('```',start+7)+3;el.setSelectionRange(start,end);});
  await page.getByRole('button',{name:'선택한 render-spec 가져오기'}).click();
  await expect(page.getByText('가져올 블록 7개 확인')).toBeVisible();
  await expect(page.locator('.blog-preview')).not.toContainText('제목');
  await page.getByRole('button',{name:'확인하고 배치에 추가'}).click();
  await expect(page.locator('.blog-preview h2')).toHaveText('여행 기록');await expect(page.locator('.blog-preview h3')).toHaveText('제목');await expect(page.locator('.blog-preview a')).toHaveAttribute('href','https://example.org/info');await expect(page.locator('.blog-info-card')).toContainText('방문 정보');
  await expect(page.locator('.blog-preview span',{hasText:'강조'})).toHaveCSS('font-weight','700');
  await expect(page.locator('.blog-preview img')).toBeVisible();await expect(page.locator('.blog-preview')).not.toContainText('개인 메모는 본문 아님');
  await page.getByRole('button',{name:'PC 폭 보기'}).click();await expect(page.locator('.blog-preview')).not.toHaveClass(/blog-preview-mobile/);
  await page.locator('.blog-preview').screenshot({path:testInfo.outputPath('blog-preview.png')});
  await page.getByRole('button',{name:'배치 저장'}).click();await expect(page.getByText('배치를 저장했어요.')).toBeVisible();
  await page.getByRole('button',{name:'대시보드',exact:true}).click();await page.getByRole('button',{name:'블로그',exact:true}).click();await expect(page.locator('.blog-preview h3')).toHaveText('제목');
  await closeApp(app);app=await launchApp(profile,false);page=await app.firstWindow();await page.getByRole('button',{name:'블로그',exact:true}).click();await page.getByRole('button',{name:'원고·배치',exact:true}).click();await page.getByLabel('블로그 프로젝트',{exact:true}).selectOption(project.id);await expect(page.locator('.blog-preview h3')).toHaveText('제목');
  expect(await readFile(doc,'utf8')).toBe(raw);
 } finally {if(app)await closeApp(app);await cleanProfile(profile);}
});
