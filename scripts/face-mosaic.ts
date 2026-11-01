// Reviewable local workflow using the same private analysis store and bundled editor engine.
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalStore } from '../src/shared/lib/storage';
import { ContentLibrary } from '../src/features/content-library';
import { MediaAnalysis } from '../src/desktop/media-analysis';
import { runFile } from '../src/desktop/analysis-provider';
import { faceRegion } from '../src/shared/media-analysis';

const [action, ...args] = process.argv.slice(2);
if (action === 'plan') {
  const [root, projectId, sampleId, planPath] = args;
  if (!root || !projectId || !sampleId || !planPath) throw new Error('plan USER_DATA PROJECT_ID SAMPLE_ID PLAN.json');
  const store = new LocalStore(root); await store.initialize();
  const library = new ContentLibrary(store);
  const service = new MediaAnalysis(store, library, path.resolve('native/editor-engine/.build/runtime'));
  const view = await service.search({projectId});
  const result = view.matches.find(r => r.sample.id === sampleId);
  if (!result || !result.fields.faceRegions) throw new Error('얼굴 영역 분석 결과가 없습니다. 얼굴 후보가 없는 결과와 분석 실패는 다릅니다.');
  const { sample } = result;
  const { info } = await library.resolveMedia(projectId, sample.sourcePath);
  const version = createHash('sha256').update(`${info.size}:${info.mtimeMs}`).digest('hex');
  if (version !== sample.sourceVersion) throw new Error('분석 후 원본이 변경됐습니다. 다시 분석해주세요.');
  // HEIC is decoded by the existing FFmpeg preparation; Pillow lacks a bundled HEIC decoder.
  const useOriginal = sample.kind === 'photo' && !/\.heic$/i.test(sample.sourcePath);
  const source = useOriginal ? sample.sourcePath : sample.imagePath;
  await stat(source);
  const plan = {sourcePath: source, originalPath: sample.sourcePath, sourceVersion: sample.sourceVersion,
    sampleId, kind: sample.kind, frameTime: sample.time, blockSize: 18, regions: result.fields.faceRegions};
  await writeFile(planPath, JSON.stringify(plan, null, 2) + '\n', {flag:'wx', mode:0o600});
  console.log('검토용 계획을 저장했습니다. 영역을 확인·수정한 뒤 미리보기와 출력을 실행하세요.');
} else if (action === 'preview' || action === 'render') {
  const [planPath, output] = args;
  if (!planPath || !output) throw new Error('preview|render PLAN.json OUTPUT.png');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  for (const region of plan.regions) faceRegion.parse(region);
  const info = await stat(plan.originalPath);
  const version = createHash('sha256').update(`${info.size}:${info.mtimeMs}`).digest('hex');
  if (version !== plan.sourceVersion) throw new Error('분석 후 원본이 변경됐습니다. 다시 분석해주세요.');
  const engine = path.resolve('native/editor-engine/.build/runtime/reels-editor');
  const result = await runFile(engine, ['face-mosaic', path.resolve(planPath), path.resolve(output), ...(action === 'preview' ? ['--preview'] : [])], {timeout: 90000, maxBuffer: 1024 * 1024});
  console.log(result.stdout);
} else throw new Error('Usage: face-mosaic.ts plan|preview|render ...');
