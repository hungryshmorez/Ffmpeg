// =============================================================================
// interpolate.mjs — optical-flow frame interpolation (#41)
// -----------------------------------------------------------------------------
// The whole point of flow interpolation (vs frame duplication) is that a moving
// object lands at its IN-BETWEEN position. Verified DETERMINISTICALLY with a
// hand-built uniform flow and a block that moves 20 px between two frames:
//   • interpolate(A,B,flow,…,0.5) puts the block at the MIDPOINT (~x=32), not at
//     A's position (22) or B's (42)
//   • t=0.25 lands it a quarter of the way, t=0.75 three-quarters
//   • t=0 returns A exactly, t=1 returns B exactly
//
//   node .test/interpolate.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8219);
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
  await page.waitForFunction(() => !!(window.FFMosh && window.FFMosh.MotionMosher), { timeout: 60000 });
  durable('[boot] FFMosh present');

  const r = await page.evaluate(async () => {
    const W = 96, H = 32, BS = 16, MOVE = 20;
    const cols = Math.ceil(W / BS), rows = Math.ceil(H / BS);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const m = new window.FFMosh.MotionMosher(cv);
    m.setParams({ blockSize: BS });

    // a white block, centred at cx (width 8), on a black band
    const block = (cx) => { const d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < d.length; i += 4) d[i + 3] = 255; for (let y = 0; y < H; y++) for (let x = cx - 4; x < cx + 4; x++) { if (x < 0 || x >= W) continue; const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = 255; } return d; };
    const A = block(22), B = block(42);         // moves +20
    // uniform flow field (+20, 0)
    const vec = new Float32Array(cols * rows * 2); for (let i = 0; i < cols * rows; i++) { vec[i * 2] = MOVE; vec[i * 2 + 1] = 0; }

    // centre of mass (x) of the bright pixels on the mid row
    const comX = (buf) => { const y = H / 2 | 0; let s = 0, n = 0; for (let x = 0; x < W; x++) { const v = buf[(y * W + x) * 4]; if (v > 60) { s += x * v; n += v; } } return n ? s / n : -1; };

    const mid = m.interpolate(A, B, vec, cols, rows, W, H, 0.5);
    const q = m.interpolate(A, B, vec, cols, rows, W, H, 0.25);
    const tq = m.interpolate(A, B, vec, cols, rows, W, H, 0.75);
    const t0 = m.interpolate(A, B, vec, cols, rows, W, H, 0);
    const t1 = m.interpolate(A, B, vec, cols, rows, W, H, 1);

    const xMid = comX(mid), xQ = comX(q), xTq = comX(tq);
    let sameA = true, sameB = true;
    for (let i = 0; i < A.length; i++) { if (t0[i] !== A[i]) sameA = false; if (t1[i] !== B[i]) sameB = false; }

    return {
      atMidpoint: Math.abs(xMid - 32) <= 3,
      quarterThenThreeQuarter: Math.abs(xQ - 27) <= 3 && Math.abs(xTq - 37) <= 3,
      endpointsExact: sameA && sameB,
      dbg: { xQ: +xQ.toFixed(1), xMid: +xMid.toFixed(1), xTq: +xTq.toFixed(1) },
    };
  });

  ok('#41 t=0.5 puts the object at the midpoint (not A or B)', r.atMidpoint, `x=${r.dbg.xMid} (A=22, B=42)`);
  ok('#41 t=0.25 / 0.75 land a quarter / three-quarters along', r.quarterThenThreeQuarter, `q=${r.dbg.xQ} tq=${r.dbg.xTq}`);
  ok('#41 t=0 returns A exactly, t=1 returns B exactly', r.endpointsExact);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 3 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
