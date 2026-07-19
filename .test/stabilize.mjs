// =============================================================================
// stabilize.mjs — stabilisation from the motion field (#44)
// -----------------------------------------------------------------------------
// Verified DETERMINISTICALLY on the two pure cores:
//   • globalMotion returns the dominant translation of a block field as the
//     MEDIAN — a handful of outlier vectors (a moving object) don't sway it
//   • stabilizePath integrates the per-frame motions into the camera path,
//     smooths it, and returns corrections. Applying them to a jittery pan
//     (smooth ramp + high-frequency shake) removes the shake — the path's
//     "acceleration" energy drops sharply — while the pan (endpoints) survives
//
//   node .test/stabilize.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8215);
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
  await page.waitForFunction(() => !!(window.FFMosh && window.FFMosh.globalMotion && window.FFMosh.stabilizePath), { timeout: 60000 });
  durable('[boot] FFMosh.globalMotion + stabilizePath present');

  const r = await page.evaluate(async () => {
    const GM = window.FFMosh.globalMotion, SP = window.FFMosh.stabilizePath;

    // a 6×4 field that's mostly (5,3) with two wild outliers (a moving object)
    const cols = 6, rows = 4, vec = new Float32Array(cols * rows * 2);
    for (let i = 0; i < cols * rows; i++) { vec[i * 2] = 5; vec[i * 2 + 1] = 3; }
    vec[0] = -40; vec[1] = 40; vec[2] = 60; vec[3] = -60;   // outliers
    const [gx, gy] = GM(vec, cols, rows);
    const robust = Math.abs(gx - 5) < 0.5 && Math.abs(gy - 3) < 0.5;

    // a jittery pan: smooth ramp (0.5 px/frame) + high-freq shake
    const N = 120, motions = [];
    let seed = 99;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
    for (let i = 0; i < N; i++) motions.push([0.5 + rnd() * 6, 0.3 + rnd() * 6]);  // ramp + shake

    // integrate to the raw path
    const rawX = []; let ax = 0; for (let i = 0; i < N; i++) { ax += motions[i][0]; rawX.push(ax); }
    const corr = SP(motions, 20);
    const stabX = rawX.map((x, i) => x + corr[i][0]);   // path after correction

    // "jitter" = mean |second difference| (acceleration); shake is high-accel
    const accel = (a) => { let s = 0, n = 0; for (let i = 2; i < a.length; i++) { s += Math.abs(a[i] - 2 * a[i - 1] + a[i - 2]); n++; } return s / n; };
    const rawJit = accel(rawX), stabJit = accel(stabX);
    const smoother = stabJit < rawJit * 0.35;
    // the pan (overall drift) is preserved: total travel similar within the middle
    const rawTravel = rawX[N - 1] - rawX[0], stabTravel = stabX[N - 1] - stabX[0];
    const panKept = Math.abs(stabTravel - rawTravel) < Math.abs(rawTravel) * 0.4 + 10;

    return { robust, smoother, panKept, dbg: { gx: +gx.toFixed(2), gy: +gy.toFixed(2), rawJit: +rawJit.toFixed(2), stabJit: +stabJit.toFixed(2), rawTravel: +rawTravel.toFixed(1), stabTravel: +stabTravel.toFixed(1) } };
  });

  ok('#44 globalMotion is outlier-robust (median)', r.robust, `(${r.dbg.gx}, ${r.dbg.gy})`);
  ok('#44 stabilizePath removes the shake (acceleration drops)', r.smoother, `accel ${r.dbg.rawJit}→${r.dbg.stabJit}`);
  ok('#44 the intended pan survives the stabilisation', r.panKept, `travel ${r.dbg.rawTravel}→${r.dbg.stabTravel}`);

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
