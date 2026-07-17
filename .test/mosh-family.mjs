// =============================================================================
// mosh-family.mjs — directional / masking / amplification / bloom (#58–61)
// -----------------------------------------------------------------------------
// These shape the motion-vector field, so they're verified DETERMINISTICALLY on
// the field and the composited pixels — no MediaRecorder, no video decode. A
// MotionMosher is fed two canvas frames where a textured patch has shifted by a
// known vector, and we read back m.vec (the estimated field) and the output
// canvas:
//   • directional (#58): with directionY=0 every vector's Y component is 0
//   • amplification (#60): amplify≠1 changes the field's max magnitude
//   • bloom (#61): 4 iterations displace the picture further than 1 (pixels differ)
//   • masking (#59): a still region shows the CLEAN frame, not the smear
//
//   node .test/mosh-family.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8195);
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
  await page.waitForFunction(() => typeof window.FFMosh !== 'undefined' && !!window.FFMosh.MotionMosher, { timeout: 60000 });
  durable('[boot] FFMosh present');

  const r = await page.evaluate(async () => {
    const W = 160, H = 96, SHIFT = 4;
    // A textured (noisy) frame shifted whole by (SHIFT,SHIFT). Real video always
    // carries residual SAD after the best match — that residual is what keeps a
    // moving block above the "no motion" threshold, so a clean synthetic frame
    // would match too perfectly and register as static. The noise reproduces it.
    function frame(dx, dy) {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      const img = g.createImageData(W, H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        // shift the whole texture by (dx,dy) so every block has the SAME motion
        const sx = (x - dx + W) % W, sy = (y - dy + H) % H;
        const v = ((sx * 53 + sy * 97) * 2654435761 >>> 0) & 0xff;
        const i = (y * W + x) * 4;
        img.data[i] = v; img.data[i + 1] = (v * 5) & 0xff; img.data[i + 2] = 255 - v; img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      return c;
    }
    const A = frame(0, 0), B = frame(SHIFT, SHIFT);

    // Run the mosher over A then B with a given param patch; return the vector
    // field and the output pixels.
    function run(params) {
      const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      const m = new window.FFMosh.MotionMosher(cv);
      // threshold:0 keeps the raw best-match vector for every block (a static
      // block still resolves to (0,0)); the "no motion" zeroing would otherwise
      // discard the clean synthetic matches we're measuring.
      m.setParams(Object.assign({ blockSize: 16, motionRadius: 16, threshold: 0, persistence: 1, iFrameInterval: 0 }, params));
      m.processFrame(A);   // primes prevY/accum
      m.processFrame(B);   // estimates + applies
      const vec = Array.from(m.vec || []);
      const px = cv.getContext('2d').getImageData(0, 0, W, H).data;
      return { vec, px: Array.from(px) };
    }
    const COLS = Math.ceil(W / 16);
    // First-column blocks (bx=0) have no left-neighbour seed, so they resolve to
    // the true (SHIFT,SHIFT) motion without the estimator's row-drift. Average
    // their magnitude — a stable signal the shaping curve acts on.
    const col0Mag = (vec) => {
      let s = 0, n = 0;
      for (let by = 0; by < Math.floor(H / 16); by++) { const i = (by * COLS) * 2; s += Math.hypot(vec[i], vec[i + 1]); n++; }
      return n ? s / n : 0;
    };
    const anyY = (vec) => { for (let i = 1; i < vec.length; i += 2) if (Math.abs(vec[i]) > 0.001) return true; return false; };
    const diff = (a, b) => { let d = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) > 24) d++; return d; };

    const base = run({});
    const horiz = run({ directionY: 0 });
    const amp = run({ amplify: 0.5 });   // explode: pushes magnitude up toward the radius
    const one = run({ bloomIterations: 1 });
    const four = run({ bloomIterations: 4 });
    // Masking is a pure block op — unit-test it directly: a smeared frame (all
    // red) + a clean frame (all green) + a zero-motion field must come back
    // green in the still blocks, and stay red where motion exceeds the cutoff.
    let maskShowsClean = false, maskKeepsMoving = false;
    {
      const cv = document.createElement('canvas'); cv.width = 32; cv.height = 32;
      const m = new window.FFMosh.MotionMosher(cv);
      m.setParams({ blockSize: 16, maskMotion: 2 });
      const N = 32 * 32 * 4;
      const red = new Uint8ClampedArray(N), green = new Uint8ClampedArray(N);
      for (let i = 0; i < N; i += 4) { red[i] = 255; red[i + 3] = 255; green[i + 1] = 255; green[i + 3] = 255; }
      const cols = 2, rows = 2;
      const still = new Float32Array(cols * rows * 2);                 // all zero
      const outA = red.slice(); m._maskLowMotion(outA, green, still, cols, rows, 32, 32);
      maskShowsClean = outA[1] === 255 && outA[0] === 0;               // became green
      const moving = new Float32Array(cols * rows * 2).fill(10);       // magnitude > cutoff
      const outB = red.slice(); m._maskLowMotion(outB, green, moving, cols, rows, 32, 32);
      maskKeepsMoving = outB[0] === 255 && outB[1] === 0;              // stayed red
    }

    return {
      maskShowsClean, maskKeepsMoving,
      baseHasMotion: col0Mag(base.vec) > 1,
      baseHasY: anyY(base.vec),
      horizNoY: !anyY(horiz.vec),
      ampBoosted: col0Mag(amp.vec) > col0Mag(base.vec) + 0.5,
      bloomDiffers: diff(one.px, four.px) > 20,
      dbg: { baseCol: +col0Mag(base.vec).toFixed(2), ampCol: +col0Mag(amp.vec).toFixed(2), bloomDiff: diff(one.px, four.px) },
    };
  });

  ok('estimator finds the motion (baseline sane)', r.baseHasMotion && r.baseHasY, `col0Mag=${r.dbg.baseCol}`);
  ok('#58 directional: directionY=0 zeroes every Y component', r.horizNoY);
  ok('#60 amplification: the curve boosts the field magnitude', r.ampBoosted, `base=${r.dbg.baseCol} amp=${r.dbg.ampCol}`);
  ok('#61 bloom: 4 iterations displace further than 1', r.bloomDiffers, `${r.dbg.bloomDiff} px differ`);
  ok('#59 masking: still block → clean, moving block → smear', r.maskShowsClean && r.maskKeepsMoving);

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
