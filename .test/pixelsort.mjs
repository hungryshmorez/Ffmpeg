// =============================================================================
// pixelsort.mjs — masked / angled pixel sort (#64)
// -----------------------------------------------------------------------------
// The band-mask + angle sort is pure pixel math, so it's verified
// DETERMINISTICALLY on ImageData — no MediaRecorder, no video decode. We feed a
// hand-built row through sortBands and read the pixels back:
//   • MASK selectivity: pixels whose luma is OUTSIDE [lo,hi] are byte-identical
//   • SORT: each contiguous in-band run comes back ordered (asc) / reversed (desc)
//   • ANGLE: pixelSortMasked at 90° produces a different frame than at 0°
//
//   node .test/pixelsort.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8196);
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
  await page.waitForFunction(() => !!(window.FFShaderPlus && window.FFShaderPlus.sortBands && window.FFShaderPlus.pixelSortMasked), { timeout: 60000 });
  durable('[boot] FFShaderPlus.sortBands + pixelSortMasked present');

  const r = await page.evaluate(async () => {
    // Grayscale so luma == value/255. lo=0.25→~64, hi=0.75→~191. One row where
    // the below/above pixels BREAK the in-band runs:
    //   idx: 0    1   2    3    4    5    6
    //   val: 150  80  180  10   240  100  170
    //   band: in  in  in  BELOW ABOVE in   in
    // → run A [150,80,180] (idx0-2), run B [100,170] (idx5-6).
    const vals = [150, 80, 180, 10, 240, 100, 170];
    const W = vals.length, H = 1;
    function mkRow() {
      const d = new Uint8ClampedArray(W * H * 4);
      for (let x = 0; x < W; x++) { const i = x * 4; d[i] = d[i + 1] = d[i + 2] = vals[x]; d[i + 3] = 255; }
      return d;
    }
    const lo = 0.25, hi = 0.75;

    const asc = mkRow();
    window.FFShaderPlus.sortBands(asc, W, H, lo, hi, 'brightness', 'asc');
    const ascR = [asc[0], asc[4], asc[8], asc[12], asc[16], asc[20], asc[24]];

    const desc = mkRow();
    window.FFShaderPlus.sortBands(desc, W, H, lo, hi, 'brightness', 'desc');
    const descR = [desc[0], desc[4], desc[8], desc[12], desc[16], desc[20], desc[24]];

    // ANGLE: a 2D frame with a diagonal-ish texture — sort at 0° vs 90° must
    // differ (different scan lines get sorted). Use pixelSortMasked (needs DOM).
    function mkFrame(w, h) {
      const img = new ImageData(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const v = ((x * 37 + y * 91) * 2654435761 >>> 0) & 0xff; // deterministic noise, mostly in-band
        img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255;
      }
      return img;
    }
    const fw = 48, fh = 48;
    const a0 = mkFrame(fw, fh); window.FFShaderPlus.pixelSortMasked(a0, { lo: 0.1, hi: 0.9, angle: 0 });
    const a90 = mkFrame(fw, fh); window.FFShaderPlus.pixelSortMasked(a90, { lo: 0.1, hi: 0.9, angle: 90 });
    let angleDiff = 0;
    for (let i = 0; i < a0.data.length; i += 4) if (Math.abs(a0.data[i] - a90.data[i]) > 8) angleDiff++;

    // A masked sort at 0° must still CHANGE the noisy frame (it actually sorts).
    const base = mkFrame(fw, fh);
    let changed = 0;
    for (let i = 0; i < base.data.length; i += 4) if (Math.abs(base.data[i] - a0.data[i]) > 8) changed++;

    return { ascR, descR, angleDiff, changed, px: (fw * fh) };
  });

  // run A [150,80,180] asc → [80,150,180]; idx3=10, idx4=240 UNTOUCHED; run B [100,170] stays.
  const expAsc = [80, 150, 180, 10, 240, 100, 170];
  const expDesc = [180, 150, 80, 10, 240, 170, 100];
  const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  ok('#64 mask: out-of-band pixels (idx3=10, idx4=240) untouched',
     r.ascR[3] === 10 && r.ascR[4] === 240, `got ${r.ascR[3]},${r.ascR[4]}`);
  ok('#64 sort: in-band runs come back ascending', eq(r.ascR, expAsc), `[${r.ascR}]`);
  ok('#64 order:desc reverses each in-band run', eq(r.descR, expDesc), `[${r.descR}]`);
  ok('#64 angle: 90° differs from 0°', r.angleDiff > r.px * 0.1, `${r.angleDiff}/${r.px} px differ`);
  ok('#64 the sort actually changes the frame', r.changed > r.px * 0.1, `${r.changed}/${r.px} px changed`);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 5 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
