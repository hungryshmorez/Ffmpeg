// Minimal static server with the COOP/COEP headers ffmpeg.wasm MT needs.
// Serves the repo root. Used by the headless round-trip test.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT || 8099);

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.map': 'application/json', '.ttf': 'font/ttf',
};

const server = http.createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(req.url.split('?')[0]);
    if (path === '/') path = '/index.html';
    const full = normalize(join(ROOT, path));
    if (!full.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    const data = await readFile(full);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(full)] || 'application/octet-stream',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Cache-Control': 'no-store',
    });
    res.end(data);
  } catch (e) {
    res.writeHead(404).end('not found: ' + req.url);
  }
});

server.listen(PORT, () => console.log(`[server] http://localhost:${PORT}  root=${ROOT}`));
