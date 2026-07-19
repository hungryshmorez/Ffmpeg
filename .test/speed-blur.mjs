// =============================================================================
// speed-blur.mjs — motion blur on speed-up (#43)
// -----------------------------------------------------------------------------
// frameBlend averages the frames a fast decimation would otherwise DROP, so
// motion smears like a long exposure instead of strobing. Verified
// DETERMINISTICALLY: a bright dot steps across N frames; the blend must smear it
// along the path:
//   • a point the dot passes THROUGH mid-path is lit in the blend though it was
//     black in the first frame
//   • the blend's peak brightness is LOWER than a single frame (energy spread)
//   • the lit span is WIDER than the dot itself (the motion trail)
//   • blending identical frames changes nothing (no false blur on a still)
//
//   node .test/speed-blur.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8209);
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
  await page.waitForFunction(() => !!(window.FFShaderPlus && window.FFShaderPlus.frameBlend), { timeout: 60000 });
  durable('[boot] FFShaderPlus.frameBlend present');

  const r = await page.evaluate(async () => {
    const W = 128, H = 32, R = 3;
    // a white dot at x = cx on a black row-band
    const frameAt = (cx) => {
      const d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < d.length; i += 4) d[i + 3] = 255;
      for (let y = H / 2 - R; y < H / 2 + R; y++) for (let x = cx - R; x < cx + R; x++) { if (x < 0 || x >= W) continue; const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = 255; }
      return new ImageData(d, W, H);
    };
    const N = 8;
    const frames = [];
    for (let k = 0; k < N; k++) frames.push(frameAt(30 + k * 8));   // dot moves 30→86
    const blend = window.FFShaderPlus.frameBlend(frames);

    const val = (img, x) => img.data[((H / 2 | 0) * W + x) * 4];
    // a point on the path the dot lands on (cx=54): black in frame 0, lit in blend
    const midX = 54;
    const midInFrame0 = val(frames[0], midX);
    const midInBlend = val(blend, midX);
    // peak of the blend vs a single frame
    let peakBlend = 0; for (let x = 0; x < W; x++) peakBlend = Math.max(peakBlend, val(blend, x));
    const peakSingle = 255;
    // lit span (pixels above 20) in blend vs single
    const span = (img) => { let n = 0; for (let x = 0; x < W; x++) if (val(img, x) > 20) n++; return n; };
    const spanBlend = span(blend), spanSingle = span(frames[0]);

    // still: blending identical frames = unchanged
    const still = window.FFShaderPlus.frameBlend([frameAt(40), frameAt(40), frameAt(40)]);
    let maxDelta = 0; const ref = frameAt(40);
    for (let i = 0; i < ref.data.length; i++) maxDelta = Math.max(maxDelta, Math.abs(still.data[i] - ref.data[i]));

    return { midInFrame0, midInBlend, peakBlend, peakSingle, spanBlend, spanSingle, stillUnchanged: maxDelta <= 1 };
  });

  ok('#43 a mid-path point is lit in the blend though black in frame 0', r.midInFrame0 < 10 && r.midInBlend > 20, `f0=${r.midInFrame0} blend=${r.midInBlend}`);
  ok('#43 the blend peak is lower than a single frame (energy spread)', r.peakBlend < r.peakSingle * 0.6, `peak=${r.peakBlend}`);
  ok('#43 the lit span is wider than the dot (motion trail)', r.spanBlend > r.spanSingle * 3, `${r.spanSingle}→${r.spanBlend}`);
  ok('#43 blending identical frames leaves a still untouched', r.stillUnchanged);

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
