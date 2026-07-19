// =============================================================================
// transient.mjs — transient shaper (attack / sustain) (#39)
// -----------------------------------------------------------------------------
// Two envelope followers isolate the onset (fast leads slow) from the tail
// (fast falls first). Verified DETERMINISTICALLY on a synthetic drum hit (sharp
// onset + exponential decay), read via the CREST FACTOR (peak ÷ RMS):
//   • neutral (0,0) leaves the signal untouched
//   • attack=+1 emphasises the onset → crest factor RISES
//   • attack=-1 softens the onset → crest factor FALLS
//   • sustain=+1 lifts the tail → tail RMS RISES (body fills in)
//
//   node .test/transient.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8204);
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
  await page.waitForFunction(() => !!(window.FFAudioDSP && window.FFAudioDSP.transientShaper), { timeout: 60000 });
  durable('[boot] FFAudioDSP.transientShaper present');

  const r = await page.evaluate(async () => {
    const DSP = window.FFAudioDSP, sr = 44100;
    // a train of 6 drum hits: sharp onset, exponential decay, 150 ms apart
    function drums() {
      const N = sr; const s = new Float32Array(N);
      for (let h = 0; h < 6; h++) {
        const start = Math.round(h * 0.15 * sr);
        for (let i = 0; i < 0.12 * sr && start + i < N; i++) {
          const env = Math.exp(-i / (0.03 * sr));            // 30 ms decay
          s[start + i] = env * Math.sin(i * 2 * Math.PI * 90 / sr);
        }
      }
      return s;
    }
    const rms = (a, lo = 0, hi = a.length) => { let s = 0, n = 0; for (let i = lo; i < hi; i++) { s += a[i] * a[i]; n++; } return Math.sqrt(s / n); };
    const peak = (a) => { let p = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > p) p = v; } return p; };
    const crest = (a) => peak(a) / (rms(a) + 1e-9);

    const base = drums();
    const crest0 = crest(base);

    const up = base.slice(); DSP.transientShaper([up], sr, { attack: 1, sustain: 0 });
    const crestUp = crest(up);

    const down = base.slice(); DSP.transientShaper([down], sr, { attack: -1, sustain: 0 });
    const crestDown = crest(down);

    // sustain test: measure the TAIL of the first hit (just after the onset)
    const onset = 0, tailLo = Math.round(0.03 * sr), tailHi = Math.round(0.12 * sr);
    const tail0 = rms(base, tailLo, tailHi);
    const sus = base.slice(); DSP.transientShaper([sus], sr, { attack: 0, sustain: 1 });
    const tailSus = rms(sus, tailLo, tailHi);

    // neutral untouched
    const neu = base.slice(); DSP.transientShaper([neu], sr, { attack: 0, sustain: 0 });
    let maxDelta = 0; for (let i = 0; i < neu.length; i++) maxDelta = Math.max(maxDelta, Math.abs(neu[i] - base[i]));

    return { crest0, crestUp, crestDown, tail0, tailSus, neutralUntouched: maxDelta < 1e-6 };
  });

  ok('#39 neutral (0,0) leaves the signal untouched', r.neutralUntouched);
  ok('#39 attack=+1 emphasises the onset (crest rises)', r.crestUp > r.crest0 * 1.03, `${r.crest0.toFixed(2)}→${r.crestUp.toFixed(2)}`);
  ok('#39 attack=-1 softens the onset (crest falls)', r.crestDown < r.crest0 * 0.97, `${r.crest0.toFixed(2)}→${r.crestDown.toFixed(2)}`);
  ok('#39 sustain=+1 lifts the tail (tail RMS rises)', r.tailSus > r.tail0 * 1.05, `${r.tail0.toFixed(4)}→${r.tailSus.toFixed(4)}`);

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
