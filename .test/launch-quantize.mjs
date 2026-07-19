// =============================================================================
// launch-quantize.mjs — beat-synced clip launching (#78)
// -----------------------------------------------------------------------------
// The launch quantiser is pure time math, verified DETERMINISTICALLY at 120 BPM
// (beat = 500 ms, bar = 2000 ms):
//   • a launch 300 ms in, quantised to the BEAT, fires at 500 ms (delay 200)
//   • the same launch quantised to the BAR fires at 2000 ms (delay 1700)
//   • a launch exactly ON a boundary fires immediately (delay 0)
//   • tempo scales the grid (60 BPM → beat = 1000 ms)
//
//   node .test/launch-quantize.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8227);
const BASE = process.env.BASE || `http://localhost:${PORT}`;
const USE_EXTERNAL = !!process.env.BASE;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.map': 'application/json', '.ttf': 'font/ttf' };

function startServer() {
  const srv = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      const full = normalize(join(ROOT, p));
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
    } catch { res.writeHead(404).end('not found: ' + req.url); }
  });
  return new Promise((resolve, reject) => { srv.on('error', reject); srv.listen(PORT, () => resolve(srv)); });
}

let server, browser, code = 1;
const checks = [];
const ok = (name, pass, detail) => { checks.push(pass); durable(`  ${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`); };

try {
  if (!USE_EXTERNAL) { server = await startServer(); console.log(`[server] listening on ${BASE}`); }
  browser = await chromium.launch({ executablePath: process.env.PW_EXEC || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.FFBeatSync && window.FFBeatSync.nextGridTime), { timeout: 60000 });
  durable('[boot] FFBeatSync.nextGridTime present');

  const r = await page.evaluate(async () => {
    const N = window.FFBeatSync.nextGridTime;
    const beat = N(300, 120, 'beat');
    const bar = N(300, 120, 'bar');
    const onGrid = N(500, 120, 'beat');           // exactly on a beat
    const slow = N(300, 60, 'beat');              // 60 BPM → beat 1000 ms
    return {
      beatAt: beat.at, beatDelay: beat.delay,
      barAt: bar.at, barDelay: bar.delay,
      onGridDelay: onGrid.delay,
      slowGrid: slow.grid, slowAt: slow.at,
    };
  });

  ok('#78 beat quantise: 300 ms → fires at 500 ms (delay 200)', Math.abs(r.beatAt - 500) < 1 && Math.abs(r.beatDelay - 200) < 1, `at=${r.beatAt} delay=${r.beatDelay}`);
  ok('#78 bar quantise: 300 ms → fires at 2000 ms (delay 1700)', Math.abs(r.barAt - 2000) < 1 && Math.abs(r.barDelay - 1700) < 1, `at=${r.barAt} delay=${r.barDelay}`);
  ok('#78 a launch on the boundary fires immediately (delay 0)', r.onGridDelay < 1, `delay=${r.onGridDelay}`);
  ok('#78 tempo scales the grid (60 BPM → 1000 ms beat)', Math.abs(r.slowGrid - 1000) < 1 && Math.abs(r.slowAt - 1000) < 1, `grid=${r.slowGrid}`);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 4 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
