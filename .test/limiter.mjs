// =============================================================================
// limiter.mjs — lookahead master limiter (#29)
// -----------------------------------------------------------------------------
// A real lookahead limiter: it must cap peaks at the ceiling WITHOUT letting the
// transient overshoot (which a react-after limiter does). Verified
// DETERMINISTICALLY on synthesised PCM plus an END-TO-END bounce:
//   • a signal with spikes at 2.0 comes back with NO sample above the ceiling
//   • the very first spike (the transient) does not overshoot — lookahead pulled
//     the gain down before it arrived
//   • a signal already under the ceiling is left essentially untouched
//   • engine bounce with limiterCeiling=-3 dB caps the rendered output there
//
//   node .test/limiter.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8203);
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
  browser = await chromium.launch({ executablePath: process.env.PW_EXEC || undefined, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.FFAudioDSP && window.FFAudioDSP.limiter && window.FFAudio), { timeout: 60000 });
  durable('[boot] FFAudioDSP.limiter + FFAudio present');

  const r = await page.evaluate(async () => {
    const DSP = window.FFAudioDSP, sr = 44100, N = sr; // 1 s
    const peakOf = (a) => { let p = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > p) p = v; } return p; };

    // ---- pure DSP: a tone at 0.4 with three fat spikes at 2.0 ----
    const sig = new Float32Array(N);
    for (let i = 0; i < N; i++) sig[i] = 0.4 * Math.sin(i * 2 * Math.PI * 200 / sr);
    const spikes = [5000, 12000, 30000];
    for (const s of spikes) sig[s] = 2.0;
    const ceiling = 0.9;
    const proc = sig.slice();
    DSP.limiter([proc], sr, { ceiling, lookaheadMs: 5, releaseMs: 60 });
    const outPeak = peakOf(proc);
    const noOverAnywhere = outPeak <= ceiling + 1e-4;
    // transient specifically: the sample AT the first spike must be capped
    const firstSpikeCapped = Math.abs(proc[spikes[0]]) <= ceiling + 1e-4;

    // ---- a signal already under the ceiling passes ~unchanged ----
    const quiet = new Float32Array(N);
    for (let i = 0; i < N; i++) quiet[i] = 0.3 * Math.sin(i * 2 * Math.PI * 200 / sr);
    const q2 = quiet.slice();
    DSP.limiter([q2], sr, { ceiling: 0.9, lookaheadMs: 5, releaseMs: 60 });
    let maxDelta = 0; for (let i = 0; i < N; i++) maxDelta = Math.max(maxDelta, Math.abs(q2[i] - quiet[i]));
    const quietUntouched = maxDelta < 1e-4;

    // ---- end-to-end: bounce with limiterCeiling=-3 dB caps the output ----
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    const buf = ac.createBuffer(1, N, sr);
    const bd = buf.getChannelData(0);
    for (let i = 0; i < N; i++) bd[i] = 0.8 * Math.sin(i * 2 * Math.PI * 200 / sr);
    for (const s of spikes) bd[s] = 1.5;
    const eng = new window.FFAudio.AudioEngine();
    eng.buffer = buf;
    eng.params = { ...window.FFAudio.DEFAULT_PARAMS, limiterCeiling: -3 };
    const rendered = await eng.bounce();
    const ceilLin = Math.pow(10, -3 / 20);
    const rPeak = peakOf(rendered.getChannelData(0));
    const bounceCapped = rPeak <= ceilLin + 0.02;   // small slack for filter ripple

    return { outPeak, noOverAnywhere, firstSpikeCapped, quietUntouched, bounceCapped, ceilLin, rPeak };
  });

  ok('#29 no sample exceeds the ceiling after limiting', r.noOverAnywhere, `peak=${r.outPeak.toFixed(4)}`);
  ok('#29 the transient is caught (lookahead, no overshoot)', r.firstSpikeCapped);
  ok('#29 a signal under the ceiling is left untouched', r.quietUntouched);
  ok('#29 engine bounce caps the output at the ceiling', r.bounceCapped, `peak=${r.rPeak.toFixed(3)} ≤ ${r.ceilLin.toFixed(3)}`);

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
