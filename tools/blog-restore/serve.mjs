#!/usr/bin/env node
// Local-only static server for a restore output folder. Usage: node tools/blog-restore/serve.mjs <dir> [port]
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve, extname, relative, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

export function serve(dir, port = 0) {
  const root = resolve(dir);
  const types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2', '.png': 'image/png'};
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const p = resolve(root, '.' + (path.endsWith('/') ? path + 'index.html' : path));
      const rel = relative(root, p);
      if (req.method !== 'GET' || rel.startsWith('..') || isAbsolute(rel)) { res.writeHead(403).end(); return; }
      const body = await readFile(p);
      res.writeHead(200, {'content-type': types[extname(p)] || 'application/octet-stream'}).end(body);
    } catch { res.writeHead(404).end(); }
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) { console.error('Usage: serve.mjs <dir> [port]'); process.exit(1); }
  const s = await serve(process.argv[2], Number(process.argv[3] || 8770));
  console.log(`http://127.0.0.1:${s.address().port}/`);
}
