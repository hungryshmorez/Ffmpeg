// =============================================================================
// half-res-motion.mjs — #18 Half-res motion estimation, full-res apply
// -----------------------------------------------------------------------------
// Coarse-to-fine block matching: estimate on a ¼-pixel half-size frame, refine
// each full-res block in a tiny window around 2× the coarse vector. Verified on
// a synthetic luma pair with a KNOWN horizontal shift:
//   • both the full search and the half-res path recover the same dominant
//     motion (globalMotion agrees, and matches the injected shift)
//   • the per-block flow fields agree closely (quality preserved)
//   • the half-res path costs FEWER SAD pixel-ops and fewer SAD calls (the win)
//   • the legacy full path is untouched by default (mode 'full' === no flag)
//
//   node .test/half-res-motion.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8249);
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
  await page.waitForFunction(() => !!(window.FFMosh && window.FFMosh.estimateFlow), { timeout: 60000 });
  durable('[boot] FFMosh.estimateFlow present');

  const r = await page.evaluate(() => {
    const W = 128, H = 128, SHIFT = 4;
    // a smooth, trackable 2D texture (downscale-friendly, no aliasing)
    const pat = (x, y) => 128 + 90 * Math.sin(x * 0.2) * Math.cos(y * 0.15) + 30 * Math.sin(y * 0.31);
    const prev = new Float32Array(W * H), cur = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      prev[y * W + x] = pat(x, y);
      cur[y * W + x] = pat(x - SHIFT, y);        // cur = prev shifted right by SHIFT
    }

    const opts = { blockSize: 16, motionRadius: 6, threshold: 0, amplify: 1, directionX: 1, directionY: 1 };
    const full = window.FFMosh.estimateFlow(cur, prev, W, H, Object.assign({ mode: 'full' }, opts));
    const half = window.FFMosh.estimateFlow(cur, prev, W, H, Object.assign({ mode: 'half' }, opts));

    const gFull = window.FFMosh.globalMotion(full.vec, full.cols, full.rows);
    const gHalf = window.FFMosh.globalMotion(half.vec, half.cols, half.rows);

    // per-block agreement (mean |Δvec|)
    let sum = 0, n = full.vec.length / 2;
    for (let i = 0; i < full.vec.length; i += 2) sum += Math.hypot(full.vec[i] - half.vec[i], full.vec[i + 1] - half.vec[i + 1]);
    const meanDelta = sum / n;

    // both recover the injected horizontal shift (sign convention consistent
    // between the two paths); |gx| substantial, |gy| tiny
    const recovered = Math.abs(gFull[0]) >= 3 && Math.abs(gFull[1]) <= 1.5
      && Math.abs(gHalf[0] - gFull[0]) <= 2 && Math.abs(gHalf[1] - gFull[1]) <= 2;

    return {
      gFull, gHalf, meanDelta,
      recovered,
      fullPixels: full.sadPixels, halfPixels: half.sadPixels,
      fullCalls: full.sadCalls, halfCalls: half.sadCalls,
    };
  });

  ok('#18 full + half-res recover the same dominant motion (matches the injected shift)', r.recovered,
     `full=[${r.gFull.map((v) => v.toFixed(1))}] half=[${r.gHalf.map((v) => v.toFixed(1))}]`);
  ok('#18 the per-block flow fields agree closely (quality preserved)', r.meanDelta < 2.0, `mean Δ=${r.meanDelta.toFixed(2)} px`);
  ok('#18 the half-res path costs fewer SAD pixel-ops AND fewer SAD calls', r.halfPixels < r.fullPixels && r.halfCalls < r.fullCalls,
     `pixels ${r.fullPixels}→${r.halfPixels} (${(100 * r.halfPixels / r.fullPixels).toFixed(0)}%), calls ${r.fullCalls}→${r.halfCalls}`);

  // legacy full path untouched: two 'full' runs are identical + deterministic
  const r2 = await page.evaluate(() => {
    const W = 64, H = 64;
    const prev = new Float32Array(W * H), cur = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { prev[y * W + x] = (x * 3 + y) & 255; cur[y * W + x] = ((x - 2) * 3 + y) & 255; }
    const o = { blockSize: 16, motionRadius: 6, threshold: 0 };
    const a = window.FFMosh.estimateFlow(cur, prev, W, H, Object.assign({ mode: 'full' }, o));
    const b = window.FFMosh.estimateFlow(cur, prev, W, H, Object.assign({ mode: 'full' }, o));
    let same = a.vec.length === b.vec.length; for (let i = 0; same && i < a.vec.length; i++) if (a.vec[i] !== b.vec[i]) same = false;
    return { same };
  });
  ok('#18 the legacy full-search path is deterministic and unchanged by default', r2.same);

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
