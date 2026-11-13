import {writeFile} from 'node:fs/promises';
import path from 'node:path';
// Existing runs are evidence, not a new model invocation and not gold labels.
// The input JSON contains explicit per-variant findings/usage with source citations.
export async function run({directory,input,signal}){
  signal.throwIfAborted();
  const source=input.files.find(f=>f.role==='input'&&f.file.endsWith('.json'));
  if(!source)throw Error('A frozen archive index JSON is required');
  const archive=JSON.parse(source.text),variant=archive.variants[input.spec.settings.variant];
  if(!variant)throw Error('Unknown archive variant');
  await writeFile(path.join(directory,'archive-evidence.json'),JSON.stringify({sourceHash:source.sha256,variant},null,2));
  return {findings:variant.findings??[],evidence:['archive-evidence.json'],usage:variant.usage??null,execution:'existing-artifact',unexecuted:variant.unexecuted??[]};
}
