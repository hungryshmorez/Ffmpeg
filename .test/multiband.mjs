// =============================================================================
// multiband.mjs — multiband compression (3-band + GR meters) (#28)
// -----------------------------------------------------------------------------
// Split into low/mid/high, compress each band on its own, sum back, and report
// per-band gain reduction. Verified DETERMINISTICALLY on a mix of a LOUD 60 Hz
// tone (low band) + a quiet 6 kHz tone (high band):
//   • compress the LOW band hard → the low-band energy drops and its GR meter
//     reads a real reduction
//   • the HIGH band (well under its threshold) is left alone → GR ≈ 0, high
//     energy ~unchanged
//   • amount/DSP off → the signal is untouched
//
//   node .test/multiband.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8207);
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
  await page.waitForFunction(() => !!(window.FFAudioDSP && window.FFAudioDSP.multibandCompress), { timeout: 60000 });
  durable('[boot] FFAudioDSP.multibandCompress present');

  const r = await page.evaluate(async () => {
    const DSP = window.FFAudioDSP, sr = 44100, N = sr;
    function mk() {
      const s = new Float32Array(N);
      for (let i = 0; i < N; i++) s[i] = 0.8 * Math.sin(i * 2 * Math.PI * 60 / sr) + 0.06 * Math.sin(i * 2 * Math.PI * 6000 / sr);
      return s;
    }
    // band energy via steep biquad filters (isolate 60 Hz vs 6 kHz cleanly, so
    // the "high" read isn't polluted by low-frequency leakage)
    const band = (a, mode) => {
      const c = Float32Array.from(a);
      if (mode === 'low') DSP.lowpass(c, sr, 200); else DSP.highpass(c, sr, 3000);
      let s = 0, cnt = 0; for (let i = sr * 0.1; i < a.length; i++) { s += c[i] * c[i]; cnt++; }
      return Math.sqrt(s / cnt);
    };
    const base = mk();
    const lowBase = band(base, 'low'), highBase = band(base, 'high');

    // compress the LOW band hard, leave mid/high gentle & high-threshold
    const proc = mk();
    const res = DSP.multibandCompress([proc], sr, {
      crossLow: 200, crossHigh: 2500,
      bands: [
        { threshold: -30, ratio: 8, attackMs: 5, releaseMs: 120 },   // low: hard
        { threshold: 0, ratio: 1, attackMs: 10, releaseMs: 120 },    // mid: off
        { threshold: 0, ratio: 1, attackMs: 10, releaseMs: 120 },    // high: off
      ],
    });
    const lowProc = band(proc, 'low'), highProc = band(proc, 'high');

    // neutral: all bands 0 dB / ratio 1 → essentially unity (allow tiny filter ripple)
    const nu = mk();
    DSP.multibandCompress([nu], sr, { bands: [{ threshold: 0, ratio: 1 }, { threshold: 0, ratio: 1 }, { threshold: 0, ratio: 1 }] });
    let maxDelta = 0; for (let i = sr * 0.1; i < N; i++) maxDelta = Math.max(maxDelta, Math.abs(nu[i] - base[i]));

    return {
      gr: res.gr, lowBase, lowProc, highBase, highProc, maxDelta,
      lowDropped: lowProc < lowBase * 0.75,
      lowGrReal: res.gr[0] > 2,
      highUntouched: res.gr[2] < 0.5 && Math.abs(highProc - highBase) < highBase * 0.3,
      neutralClean: maxDelta < 0.03,
    };
  });

  ok('#28 the low band is compressed down', r.lowDropped, `low ${r.lowBase.toFixed(3)}→${r.lowProc.toFixed(3)}`);
  ok('#28 the low band GR meter reads a real reduction', r.lowGrReal, `GR=${r.gr.map((g) => g.toFixed(1)).join('/')} dB`);
  ok('#28 the high band is left alone (GR ≈ 0)', r.highUntouched, `highGR=${r.gr[2].toFixed(2)}`);
  ok('#28 unity settings leave the signal ~untouched', r.neutralClean, `Δ=${r.maxDelta.toFixed(4)}`);

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
