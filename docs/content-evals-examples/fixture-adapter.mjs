import {writeFile} from 'node:fs/promises';
import path from 'node:path';
// Deterministic contract exercise. Does not run a model or measure writing quality.
export async function run({directory,input,signal}) {
  signal.throwIfAborted();
  const findings=input.spec.cases.map(c=>({caseId:c.id,ids:input.spec.settings.variant==='regressed'?[]:[...c.expectedFindingIds]}));
  await writeFile(path.join(directory,'trace.json'),JSON.stringify({execution:'fixture',findings}));
  return {findings,evidence:['trace.json'],usage:null,execution:'fixture',unexecuted:['actual model','visual review','publishing']};
}
