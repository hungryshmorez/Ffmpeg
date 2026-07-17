// =============================================================================
// vector-overlay.mjs — motion-vector overlay (#57)
// -----------------------------------------------------------------------------
// MotionMosher.drawVectors renders the estimated field as arrows. Verified
// DETERMINISTICALLY: prime the mosher with two frames of a texture shifted by a
// KNOWN (dx,dy), draw the vectors onto a blank canvas, and read the ink back:
//   • something is actually drawn (non-empty overlay)
//   • the ink extends in the +x,+y direction from a block centre (arrows point
//     the way the texture moved — right/down for a (+,+) shift)
//   • a zero field (no prior frame) draws nothing
//
//   node .test/vector-overlay.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8199);
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
    const W = 160, H = 96, BS = 16, SHIFT = 5;
    // textured frame shifted whole by (dx,dy) — same generator the mosh tests use
    function frame(dx, dy) {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      const img = g.createImageData(W, H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const sx = (x - dx + W) % W, sy = (y - dy + H) % H;
        const v = ((sx * 53 + sy * 97) * 2654435761 >>> 0) & 0xff;
        const i = (y * W + x) * 4;
        img.data[i] = v; img.data[i + 1] = (v * 5) & 0xff; img.data[i + 2] = 255 - v; img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      return c;
    }
    const A = frame(0, 0), B = frame(SHIFT, SHIFT);

    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const m = new window.FFMosh.MotionMosher(cv);
    m.setParams({ blockSize: BS, motionRadius: 16, threshold: 0 });

    // overlay canvas we draw the arrows onto (blank/transparent to start)
    const oc = document.createElement('canvas'); oc.width = W; oc.height = H;
    const octx = oc.getContext('2d', { willReadFrequently: true });

    // BEFORE any field: nothing to draw
    m.drawVectors(octx, { color: '#00ff88', scale: 2.5 });
    let inkBefore = 0;
    { const d = octx.getImageData(0, 0, W, H).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) inkBefore++; }

    // prime + estimate the (5,5) field — proves the ESTIMATED field draws ink
    m.captureField(A); m.captureField(B);
    octx.clearRect(0, 0, W, H);
    m.drawVectors(octx, { color: '#00ff88', scale: 2.5, arrows: true });
    let inkAfter = 0; { const d = octx.getImageData(0, 0, W, H).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) inkAfter++; }

    // Directionality: draw a SINGLE isolated vector so no neighbouring arrow
    // overlaps. Zero the whole field, set one block to (+5,+5), draw, and check
    // the ink runs toward the tip (+x,+y) and NOT the other way (−x,−y).
    const cols = Math.ceil(W / BS);
    const one = new Float32Array(m.vec.length);
    const bx = 4, by = 3;                       // interior block, far from edges
    const bi = (by * cols + bx) * 2; one[bi] = 5; one[bi + 1] = 5;
    m.vec = one;
    octx.clearRect(0, 0, W, H);
    m.drawVectors(octx, { color: '#00ff88', scale: 2.5, arrows: true });
    const img = octx.getImageData(0, 0, W, H).data;
    const ink = (x, y) => { const i = (y * W + x) * 4; return img[i + 3] > 8; };
    const cx = bx * BS + BS / 2, cy = by * BS + BS / 2;
    let posLine = 0, negLine = 0;
    for (let t = 2; t <= 10; t++) { if (ink(cx + t, cy + t)) posLine++; if (ink(cx - t, cy - t)) negLine++; }

    return { inkBefore, inkAfter, posLine, negLine };
  });

  ok('#57 nothing is drawn before a field exists', r.inkBefore === 0);
  ok('#57 the overlay actually draws the estimated field', r.inkAfter > 50, `${r.inkAfter} px inked`);
  ok('#57 arrows point the way the block moved (+x,+y)', r.posLine >= 6 && r.negLine === 0, `pos=${r.posLine} neg=${r.negLine}`);

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
