// =============================================================================
// retime-toggle.mjs — frame-blend vs optical-flow retime toggle (#56)
// -----------------------------------------------------------------------------
// The SAME in-between frame, two ways — the whole point of the toggle is that
// they look different. Verified DETERMINISTICALLY with a block that moves 20 px
// between frame A (x=22) and B (x=42), at t=0.5:
//   • method 'flow' warps → ONE block at the midpoint (x≈32), A and B positions dark
//   • method 'blend' cross-dissolves → TWO ghosts (bright at x=22 AND x=42),
//     the midpoint dark
//
//   node .test/retime-toggle.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8232);
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
    const m = new window.FFMosh.MotionMosher(Object.assign(document.createElement('canvas'), { width: W, height: H }));
    m.setParams({ blockSize: BS });
    const block = (cx) => { const d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < d.length; i += 4) d[i + 3] = 255; for (let y = 0; y < H; y++) for (let x = cx - 4; x < cx + 4; x++) { if (x < 0 || x >= W) continue; const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = 255; } return d; };
    const A = block(22), B = block(42);
    const vec = new Float32Array(cols * rows * 2); for (let i = 0; i < cols * rows; i++) { vec[i * 2] = MOVE; vec[i * 2 + 1] = 0; }
    const val = (buf, x) => buf[((H / 2 | 0) * W + x) * 4];

    const flow = m.retime(A, B, vec, cols, rows, W, H, 0.5, 'flow');
    const blend = m.retime(A, B, vec, cols, rows, W, H, 0.5, 'blend');

    // flow: one block at the midpoint (32), ends dark
    const flowMid = val(flow, 32), flowA = val(flow, 22), flowB = val(flow, 42);
    const flowSharp = flowMid > 180 && flowA < 80 && flowB < 80;
    // blend: two ghosts at 22 and 42 (each ~half), midpoint dark
    const blMid = val(blend, 32), blA = val(blend, 22), blB = val(blend, 42);
    const blendGhosts = blA > 90 && blB > 90 && blMid < 60;

    return { flowSharp, blendGhosts, dbg: { flow: [flowA, flowMid, flowB], blend: [blA, blMid, blB] } };
  });

  ok("#56 'flow' warps to one sharp in-between block at the midpoint", r.flowSharp, `[A,mid,B]=${JSON.stringify(r.dbg.flow)}`);
  ok("#56 'blend' cross-dissolves to two ghosts, dark midpoint", r.blendGhosts, `[A,mid,B]=${JSON.stringify(r.dbg.blend)}`);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 2 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
