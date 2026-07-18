// =============================================================================
// stereo-width.mjs — stereo width + correlation meter (#31)
// -----------------------------------------------------------------------------
// The DSP core (audio-dsp.js) is verified DETERMINISTICALLY on synthesised PCM,
// and the width matrix is verified END-TO-END by rendering a stereo buffer
// through the REAL engine graph (OfflineAudioContext) and reading the output
// channels back:
//   • correlation: mono (L==R) → +1, anti-phase (L=-R) → -1
//   • widthChannels(…,0) collapses to mono (L==R)
//   • engine bounce at width=0 → output correlation ≈ +1 (mono)
//   • engine bounce at width=2 is WIDER than width=1 (correlation drops)
//
//   node .test/stereo-width.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8202);
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
  await page.waitForFunction(() => !!(window.FFAudioDSP && window.FFAudio && window.FFAudio.AudioEngine), { timeout: 60000 });
  durable('[boot] FFAudioDSP + FFAudio present');

  const r = await page.evaluate(async () => {
    const DSP = window.FFAudioDSP;
    const N = 4096;
    // ---- pure DSP ----
    const mono = new Float32Array(N), monoR = new Float32Array(N);
    const anti = new Float32Array(N), antiR = new Float32Array(N);
    for (let i = 0; i < N; i++) { const s = Math.sin(i * 0.05); mono[i] = monoR[i] = s; anti[i] = s; antiR[i] = -s; }
    const corrMono = DSP.correlation(mono, monoR);
    const corrAnti = DSP.correlation(anti, antiR);
    // widthChannels width 0 → mono
    const wl = new Float32Array(N), wr = new Float32Array(N);
    for (let i = 0; i < N; i++) { wl[i] = Math.sin(i * 0.05); wr[i] = Math.sin(i * 0.09 + 1); }
    DSP.widthChannels(wl, wr, 0);
    let mDiff = 0; for (let i = 0; i < N; i++) mDiff = Math.max(mDiff, Math.abs(wl[i] - wr[i]));
    const widthZeroMono = mDiff < 1e-6;

    // ---- end-to-end through the engine graph ----
    const sr = 44100, LEN = sr; // 1 s
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    function stereoBuf() {
      const b = ac.createBuffer(2, LEN, sr);
      const L = b.getChannelData(0), R = b.getChannelData(1);
      for (let i = 0; i < LEN; i++) { L[i] = 0.5 * Math.sin(i * 2 * Math.PI * 220 / sr); R[i] = 0.5 * Math.sin(i * 2 * Math.PI * 330 / sr + 0.7); }
      return b;
    }
    async function renderAt(width) {
      const eng = new window.FFAudio.AudioEngine();
      eng.buffer = stereoBuf();
      eng.params = { ...window.FFAudio.DEFAULT_PARAMS, width };
      const out = await eng.bounce();
      // correlate the settled middle of the render (skip filter/phaser onset + tail)
      const L = out.getChannelData(0).subarray(sr * 0.2 | 0, sr * 0.8 | 0);
      const R = out.getChannelData(1).subarray(sr * 0.2 | 0, sr * 0.8 | 0);
      return { corr: DSP.correlation(L, R), wide: DSP.widthAmount(L, R) };
    }
    const w0 = await renderAt(0);
    const w1 = await renderAt(1);
    const w2 = await renderAt(2);

    return { corrMono, corrAnti, widthZeroMono, w0, w1, w2 };
  });

  ok('#31 correlation: mono (L==R) → +1', r.corrMono > 0.999, `${r.corrMono.toFixed(4)}`);
  ok('#31 correlation: anti-phase (L=-R) → -1', r.corrAnti < -0.999, `${r.corrAnti.toFixed(4)}`);
  ok('#31 widthChannels(…,0) collapses to mono', r.widthZeroMono);
  ok('#31 engine bounce at width=0 → mono output (corr ≈ +1)', r.w0.corr > 0.99, `corr=${r.w0.corr.toFixed(3)}`);
  ok('#31 engine bounce at width=2 is wider than width=1', r.w2.wide > r.w1.wide + 0.05 && r.w2.corr < r.w1.corr,
     `wide ${r.w1.wide.toFixed(2)}→${r.w2.wide.toFixed(2)}, corr ${r.w1.corr.toFixed(2)}→${r.w2.corr.toFixed(2)}`);

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
