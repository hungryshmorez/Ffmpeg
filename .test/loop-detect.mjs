// =============================================================================
// loop-detect.mjs — auto loop-point detection (#86)
// -----------------------------------------------------------------------------
// A seamless loop is where the audio a whole period later lines up with the
// start. detectLoop takes the normalised autocorrelation over candidate lengths
// and picks the peak. Verified DETERMINISTICALLY:
//   • a 0.5 s random motif tiled 4× → detected loop length ≈ 0.5 s, high confidence
//   • a DIFFERENT motif length (0.3 s) is found too (it's not hard-coded)
//   • pure noise (no repeat) scores low confidence
//
//   node .test/loop-detect.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8223);
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
  await page.waitForFunction(() => !!(window.FFAudioDSP && window.FFAudioDSP.detectLoop), { timeout: 60000 });
  durable('[boot] FFAudioDSP.detectLoop present');

  const r = await page.evaluate(async () => {
    const sr = 44100, DSP = window.FFAudioDSP;
    let seed = 424242;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
    // a SMOOTH motif of period `sec` (harmonics of 1/sec, so it's exactly
    // periodic and survives the decimated search), tiled `reps` times
    const tiled = (sec, reps) => {
      const mlen = Math.round(sec * sr);
      const motif = new Float32Array(mlen);
      const f0 = 1 / sec;   // fundamental — period is exactly `sec`
      for (let i = 0; i < mlen; i++) {
        const t = i / sr;
        motif[i] = Math.sin(2 * Math.PI * f0 * t) + 0.6 * Math.sin(2 * Math.PI * 2 * f0 * t + 0.5) + 0.4 * Math.sin(2 * Math.PI * 3 * f0 * t + 1.1);
      }
      const out = new Float32Array(mlen * reps);
      for (let k = 0; k < reps; k++) out.set(motif, k * mlen);
      return out;
    };

    const half = DSP.detectLoop(tiled(0.5, 4), sr, { minSec: 0.25, maxSec: 0.9 });
    const third = DSP.detectLoop(tiled(0.3, 6), sr, { minSec: 0.15, maxSec: 0.55 });

    // pure (unrepeating) noise
    const noise = new Float32Array(sr * 2); for (let i = 0; i < noise.length; i++) noise[i] = rnd();
    const noiseLoop = DSP.detectLoop(noise, sr, { minSec: 0.25, maxSec: 0.9 });

    return {
      halfLen: half.lengthSec, halfConf: half.confidence,
      thirdLen: third.lengthSec, thirdConf: third.confidence,
      noiseConf: noiseLoop.confidence,
    };
  });

  ok('#86 a 0.5 s motif loops at ≈0.5 s with high confidence', Math.abs(r.halfLen - 0.5) < 0.03 && r.halfConf > 0.85, `len=${r.halfLen.toFixed(3)}s conf=${r.halfConf.toFixed(2)}`);
  ok('#86 a 0.3 s motif loops at ≈0.3 s (not hard-coded)', Math.abs(r.thirdLen - 0.3) < 0.03 && r.thirdConf > 0.85, `len=${r.thirdLen.toFixed(3)}s conf=${r.thirdConf.toFixed(2)}`);
  ok('#86 unrepeating noise scores low confidence', r.noiseConf < 0.5, `conf=${r.noiseConf.toFixed(2)}`);

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
