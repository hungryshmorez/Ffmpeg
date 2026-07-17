// =============================================================================
// flow-displace.mjs — optical-flow-driven displacement (#68)
// -----------------------------------------------------------------------------
// displaceByFlow uses the block-grid motion field as a per-pixel DISPLACEMENT
// MAP (bilinearly interpolated) and samples the SAME picture through it. Pure
// pixel math → verified DETERMINISTICALLY with hand-built fields:
//   • a uniform field shifts a vertical edge by exactly dx*scale
//   • scale scales the shift (2× field-scale → 2× the move)
//   • a zero field leaves the picture untouched
//   • a field that varies top→bottom warps the two halves DIFFERENTLY
//
//   node .test/flow-displace.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8198);
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
    const W = 128, H = 64, BS = 16;
    const cols = Math.ceil(W / BS), rows = Math.ceil(H / BS);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const m = new window.FFMosh.MotionMosher(cv);
    m.setParams({ blockSize: BS, motionStrength: 1 });

    // A sharp vertical edge: black left of x=64, white right of it.
    const EDGE = 64;
    function edgePic() {
      const d = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; const v = x >= EDGE ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
      return d;
    }
    // where is the edge on the centre row (first x that's bright)?
    function edgeAt(out, y = H / 2 | 0) { for (let x = 0; x < W; x++) if (out[(y * W + x) * 4] > 127) return x; return -1; }

    const field = (fn) => { const v = new Float32Array(cols * rows * 2); for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) { const i = (by * cols + bx) * 2; const [dx, dy] = fn(bx, by); v[i] = dx; v[i + 1] = dy; } return v; };

    const pic = edgePic();
    // out[x] samples cur[x - dx*scale]; cur bright for x>=64 → out bright when
    // x - dx*scale >= 64 → edge moves RIGHT by dx*scale.
    const uni6 = m.displaceByFlow(pic, field(() => [6, 0]), cols, rows, W, H, { scale: 1 });
    const uni6s2 = m.displaceByFlow(pic, field(() => [6, 0]), cols, rows, W, H, { scale: 2 });
    const zero = m.displaceByFlow(pic, field(() => [0, 0]), cols, rows, W, H, { scale: 3 });

    // top half no motion, bottom half dx=10 → top edge stays ~64, bottom moves.
    const split = m.displaceByFlow(pic, field((bx, by) => (by >= rows / 2 ? [10, 0] : [0, 0])), cols, rows, W, H, { scale: 1 });
    const topEdge = edgeAt(split, 4), botEdge = edgeAt(split, H - 4);

    let zeroSame = true;
    for (let i = 0; i < pic.length; i++) if (pic[i] !== zero[i]) { zeroSame = false; break; }

    return {
      e6: edgeAt(uni6), e6s2: edgeAt(uni6s2), zeroSame, topEdge, botEdge,
    };
  });

  // dx=6 scale=1 → edge at 64+6=70; scale=2 → 64+12=76 (±1 for rounding)
  ok('#68 uniform field shifts the edge by dx*scale', Math.abs(r.e6 - 70) <= 1, `edge at ${r.e6}`);
  ok('#68 scale scales the displacement (2× → 2× move)', Math.abs(r.e6s2 - 76) <= 1, `edge at ${r.e6s2}`);
  ok('#68 zero field leaves the picture untouched', r.zeroSame);
  ok('#68 a spatially-varying field warps the halves differently', r.botEdge - r.topEdge >= 6, `top=${r.topEdge} bot=${r.botEdge}`);

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
