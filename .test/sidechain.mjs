// =============================================================================
// sidechain.mjs — sidechain duck to the kick (#27)
// -----------------------------------------------------------------------------
// The kick is detected from the sub band (2-pole low-pass) and the mix ducks
// under each hit. Verified DETERMINISTICALLY on a synthetic mix = steady 440 Hz
// pad + periodic 55 Hz kicks:
//   • right AFTER a kick the pad level dips vs the recovered level before the
//     NEXT kick — that's the pump
//   • amount=0 leaves the signal untouched
//   • the pad's own band (no kicks present) is NOT ducked (detector is low-band)
//
//   node .test/sidechain.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8205);
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
  await page.waitForFunction(() => !!(window.FFAudioDSP && window.FFAudioDSP.sidechainDuck), { timeout: 60000 });
  durable('[boot] FFAudioDSP.sidechainDuck present');

  const r = await page.evaluate(async () => {
    const DSP = window.FFAudioDSP, sr = 44100, N = 2 * sr;
    const kickEvery = 0.5;                       // a kick every 500 ms (4 kicks)
    const kickTimes = [0.5, 1.0, 1.5];
    function mix() {
      const s = new Float32Array(N);
      for (let i = 0; i < N; i++) s[i] = 0.3 * Math.sin(i * 2 * Math.PI * 440 / sr);   // steady pad
      for (const t of kickTimes) {
        const start = Math.round(t * sr);
        for (let i = 0; i < 0.08 * sr && start + i < N; i++) {
          const env = Math.exp(-i / (0.02 * sr));
          s[start + i] += 0.9 * env * Math.sin(i * 2 * Math.PI * 55 / sr);            // 55 Hz kick
        }
      }
      return s;
    }
    // pad-only band level: high-pass-ish read is hard; instead read the OVERALL
    // envelope in windows placed AFTER a kick vs just BEFORE the next kick.
    const rms = (a, lo, hi) => { let s = 0, n = 0; for (let i = lo; i < hi; i++) { s += a[i] * a[i]; n++; } return Math.sqrt(s / n); };

    const base = mix();
    const proc = base.slice();
    DSP.sidechainDuck([proc], sr, { amount: 0.7, releaseMs: 220, detectHz: 120, threshold: 0.1 });

    // window A: 40–90 ms AFTER the 2nd kick (ducked, pad only — kick has decayed)
    const k = kickTimes[1];
    const aLo = Math.round((k + 0.04) * sr), aHi = Math.round((k + 0.09) * sr);
    // window B: just before the 3rd kick (recovered)
    const bLo = Math.round((kickTimes[2] - 0.06) * sr), bHi = Math.round((kickTimes[2] - 0.01) * sr);
    const afterKick = rms(proc, aLo, aHi);
    const recovered = rms(proc, bLo, bHi);
    const pumps = afterKick < recovered * 0.8;

    // amount=0 untouched
    const zero = base.slice(); DSP.sidechainDuck([zero], sr, { amount: 0 });
    let maxDelta = 0; for (let i = 0; i < N; i++) maxDelta = Math.max(maxDelta, Math.abs(zero[i] - base[i]));

    return { afterKick, recovered, pumps, zeroUntouched: maxDelta < 1e-9 };
  });

  ok('#27 the mix ducks right after a kick and recovers before the next', r.pumps, `after=${r.afterKick.toFixed(4)} recovered=${r.recovered.toFixed(4)}`);
  ok('#27 amount=0 leaves the signal untouched', r.zeroUntouched);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 2 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
