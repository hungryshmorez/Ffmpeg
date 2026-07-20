// =============================================================================
// motion-worker.mjs — #15 motion estimation in a Worker
// -----------------------------------------------------------------------------
// Block-matching (SAD) is moved off the main thread. The Worker body is
// generated from flowKernel.toString(), and flowKernel is a faithful port of
// the on-thread MotionMosher._estimate — so the ONLY thing that can go wrong is
// the port drifting or the worker plumbing mangling the field. This proves it
// can't, against the existing on-thread estimateFlow as ground truth:
//
//   • for many random luma pairs across full + half (hierarchical) modes and a
//     spread of block sizes / radii / amplify / direction, the WORKER field is
//     byte-identical to estimateFlow (Float32-exact) — and lastPath === 'worker'
//     (it really ran off-thread, not silently on the main thread)
//   • it recovers a KNOWN shift: cur = prev shifted +x by S → mean vx clearly
//     positive; shifted −x → clearly negative (real estimation, not noise)
//   • forcing 'main' mode returns path 'main' with the identical field (the
//     graceful fallback when Workers are unavailable)
//
//   node .test/motion-worker.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8275);
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
  await page.waitForFunction(() => !!(window.FFMotion && window.FFMosh && window.FFMosh.estimateFlow), { timeout: 60000 });
  durable('[boot] FFMotion + FFMosh present');

  const r = await page.evaluate(async () => {
    const M = window.FFMotion, G = window.FFMosh;

    // deterministic PRNG so a failure is reproducible
    let s = 0x2545f491;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1000) / 1000; };
    const randLuma = (w, h) => { const a = new Uint8ClampedArray(w * h); for (let i = 0; i < a.length; i++) a[i] = (rnd() * 255) | 0; return a; };
    const eqF32 = (a, b) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

    // 1) EQUIVALENCE — worker field must be Float32-exact vs on-thread estimateFlow
    M.setMode('auto');
    const configs = [
      { w: 64, h: 48, opts: { mode: 'full', blockSize: 16, motionRadius: 6 } },
      { w: 80, h: 64, opts: { mode: 'half', blockSize: 16, motionRadius: 6 } },
      { w: 48, h: 48, opts: { mode: 'full', blockSize: 8,  motionRadius: 4, amplify: 1.5 } },
      { w: 96, h: 48, opts: { mode: 'full', blockSize: 16, motionRadius: 8, directionX: 1, directionY: 0 } },
      { w: 64, h: 64, opts: { mode: 'half', blockSize: 32, motionRadius: 6 } },
    ];
    let allExact = true, workerUsed = true, mism = -1;
    for (let i = 0; i < configs.length; i++) {
      const { w, h, opts } = configs[i];
      const cur = randLuma(w, h), prev = randLuma(w, h);
      const truth = G.estimateFlow(cur.slice(), prev.slice(), w, h, opts);   // on-thread ground truth
      const got = await M.estimateAsync(cur.slice(), prev.slice(), w, h, opts);
      if (got.path !== 'worker') workerUsed = false;
      if (!(got.cols === truth.cols && got.rows === truth.rows && eqF32(got.vec, truth.vec))) { allExact = false; if (mism < 0) mism = i; }
    }

    // 2) KNOWN SHIFT — cur = prev shifted +x by S → mean vx > 0; −x → mean vx < 0
    const shiftField = async (S) => {
      const w = 96, h = 64;
      const prev = randLuma(w, h);
      const cur = new Uint8ClampedArray(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = Math.min(w - 1, Math.max(0, x - S));
        cur[y * w + x] = prev[y * w + sx];
      }
      // threshold:0 — a perfect translation has ~zero residual, which the
      // default threshold would treat as "no motion" and zero out; drop it so
      // matched blocks keep the vector we're actually probing for.
      const f = await M.estimateAsync(cur, prev, w, h, { mode: 'full', blockSize: 16, motionRadius: 8, threshold: 0 });
      let sum = 0, n = 0;
      for (let i = 0; i < f.vec.length; i += 2) { sum += f.vec[i]; n++; }
      return sum / n;
    };
    const meanRight = await shiftField(3);
    const meanLeft = await shiftField(-3);

    // 3) FALLBACK — forced 'main' returns path 'main' with identical field
    M.setMode('main');
    const w = 64, h = 48, opts = { mode: 'full', blockSize: 16, motionRadius: 6 };
    const cur = randLuma(w, h), prev = randLuma(w, h);
    const truthMain = G.estimateFlow(cur.slice(), prev.slice(), w, h, opts);
    const gotMain = await M.estimateAsync(cur.slice(), prev.slice(), w, h, opts);
    const mainExact = gotMain.path === 'main' && eqF32(gotMain.vec, truthMain.vec);
    M.setMode('auto');
    M.terminate();

    return { allExact, workerUsed, mism, meanRight, meanLeft, mainExact, configs: configs.length };
  });

  ok('the Worker field is Float32-exact vs on-thread estimateFlow across modes/sizes',
     r.allExact, r.allExact ? `${r.configs} configs` : `first mismatch at config #${r.mism}`);
  ok('estimation actually ran in a Worker (off the main thread)', r.workerUsed);
  ok('a known +x shift yields a clearly positive mean vx (real estimation)', r.meanRight > 0.5, `meanVx=${r.meanRight.toFixed(2)}`);
  ok('a known −x shift yields a clearly negative mean vx', r.meanLeft < -0.5, `meanVx=${r.meanLeft.toFixed(2)}`);
  ok('forced main-thread fallback returns path "main" with an identical field', r.mainExact);

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
