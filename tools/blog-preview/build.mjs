import {build} from 'esbuild';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const output=process.argv[2];
if(!output)throw new Error('Usage: node tools/blog-preview/build.mjs <output-directory>');
await build({entryPoints:[resolve(dirname(fileURLToPath(import.meta.url)),'main.jsx')],bundle:true,external:['fonts/*'],outfile:resolve(output,'blog-preview.js'),format:'esm',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},minify:true});
