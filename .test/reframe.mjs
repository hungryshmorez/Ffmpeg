// =============================================================================
// reframe.mjs — auto-reframe / subject tracking (#45)
// -----------------------------------------------------------------------------
// The subject is the centre of mass of the motion field. Verified
// DETERMINISTICALLY on hand-built fields:
//   • motion concentrated in the TOP-RIGHT blocks → centroid lands top-right
//   • motion concentrated BOTTOM-LEFT → centroid lands bottom-left (it tracks)
//   • a still field → [null, null] (no subject; the crop should hold)
//   • the centroid is magnitude-weighted: a loud block outweighs many faint ones
//
//   node .test/reframe.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8216);
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
  await page.waitForFunction(() => !!(window.FFMosh && window.FFMosh.motionCentroid), { timeout: 60000 });
  durable('[boot] FFMosh.motionCentroid present');

  const r = await page.evaluate(async () => {
    const MC = window.FFMosh.motionCentroid;
    const cols = 10, rows = 6, bs = 16;                 // → 160×96 px field
    const W = cols * bs, H = rows * bs;
    const field = (fn) => { const v = new Float32Array(cols * rows * 2); for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) { const [dx, dy] = fn(bx, by); const i = (by * cols + bx) * 2; v[i] = dx; v[i + 1] = dy; } return v; };

    // motion only in the top-right quadrant
    const tr = field((bx, by) => (bx >= cols * 0.7 && by <= rows * 0.3 ? [6, 6] : [0, 0]));
    const [trx, tryy] = MC(tr, cols, rows, bs);
    const topRight = trx > W * 0.6 && tryy < H * 0.4;

    // motion only in the bottom-left quadrant
    const bl = field((bx, by) => (bx <= cols * 0.3 && by >= rows * 0.7 ? [6, 6] : [0, 0]));
    const [blx, blyy] = MC(bl, cols, rows, bs);
    const bottomLeft = blx < W * 0.4 && blyy > H * 0.6;

    // still field → null
    const still = field(() => [0, 0]);
    const [sx] = MC(still, cols, rows, bs);
    const isNull = sx === null;

    // magnitude weighting: one loud block far right vs many faint blocks left
    const weighted = field((bx, by) => (bx === cols - 1 && by === (rows / 2 | 0)) ? [40, 0] : (bx < 3 ? [0.4, 0] : [0, 0]));
    const [wx] = MC(weighted, cols, rows, bs);
    const pulledRight = wx > W * 0.6;

    return { topRight, bottomLeft, isNull, pulledRight, dbg: { trx: +trx.toFixed(0), tryy: +tryy.toFixed(0), blx: +blx.toFixed(0), blyy: +blyy.toFixed(0), wx: +wx.toFixed(0), W, H } };
  });

  ok('#45 centroid tracks motion to the top-right', r.topRight, `(${r.dbg.trx},${r.dbg.tryy}) of ${r.dbg.W}×${r.dbg.H}`);
  ok('#45 centroid tracks motion to the bottom-left', r.bottomLeft, `(${r.dbg.blx},${r.dbg.blyy})`);
  ok('#45 a still field yields no subject (null → hold)', r.isNull);
  ok('#45 the centroid is magnitude-weighted', r.pulledRight, `x=${r.dbg.wx}`);

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
