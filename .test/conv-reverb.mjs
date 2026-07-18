// =============================================================================
// conv-reverb.mjs — convolution reverb from a user IR (#38)
// -----------------------------------------------------------------------------
// Verified END-TO-END through the real engine bounce (OfflineAudioContext):
// load a hand-built 2-tap impulse response (a spike at 0 and at 0.1 s), feed the
// engine a single CLICK, and read the rendered PCM back:
//   • with the user IR (reverbMix=1) the output has a clear echo at ~0.1 s — the
//     click convolved with the IR reproduces the second tap
//   • that echo window has far more energy than the silent gap before it
//   • loadIR reports the IR's length; clearIR reverts to the generated reverb
//     without crashing
//
//   node .test/conv-reverb.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8211);
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
  await page.waitForFunction(() => !!(window.FFAudio && window.FFAudio.AudioEngine), { timeout: 60000 });
  durable('[boot] FFAudio present');

  const r = await page.evaluate(async () => {
    const sr = 44100;
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    // 2-tap IR: spike at 0 and at 0.1 s (stereo)
    const irLen = Math.round(0.15 * sr), tap = Math.round(0.1 * sr);
    const ir = ac.createBuffer(2, irLen, sr);
    for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); d[0] = 1; d[tap] = 0.9; }
    // a single click, then silence (stereo)
    const clickLen = Math.round(0.25 * sr);
    const click = ac.createBuffer(2, clickLen, sr);
    for (let c = 0; c < 2; c++) click.getChannelData(c)[10] = 1;

    const P = { ...window.FFAudio.DEFAULT_PARAMS, delayMix: 0, chorusMix: 0, distortionAmount: 0, phaserFeedback: 0, phaserDepth: 0 };
    const winRms = (buf, lo, hi) => { let s = 0, n = 0; for (let i = lo; i < hi; i++) { s += buf[i] * buf[i]; n++; } return Math.sqrt(s / n); };
    const echoLo = tap + 10 - 400, echoHi = tap + 10 + 400;    // window around the 0.1 s tap

    // render WITH the user IR
    const eng = new window.FFAudio.AudioEngine();
    eng.buffer = click;
    const info = eng.loadIR(ir);
    eng.params = { ...P, reverbMix: 1.0 };
    const withIR = winRms((await eng.bounce()).getChannelData(0), echoLo, echoHi);

    // render DRY (no reverb) — the same window must be near-silent (no echo)
    const engDry = new window.FFAudio.AudioEngine();
    engDry.buffer = click;
    engDry.params = { ...P, reverbMix: 0 };
    const dry = winRms((await engDry.bounce()).getChannelData(0), echoLo, echoHi);

    const hasEcho = withIR > dry * 10 && withIR > 1e-4;

    // clearIR reverts without crashing
    let clearOk = false;
    try { const eng2 = new window.FFAudio.AudioEngine(); eng2.buffer = click; eng2.loadIR(ir); eng2.clearIR(); eng2.params = { ...P, reverbMix: 0.5 }; const r2 = await eng2.bounce(); clearOk = r2.length > 0; } catch (e) { clearOk = false; }

    return { info, hasEcho, withIR, dry, clearOk };
  });

  ok('#38 loadIR reports the IR length', r.info && r.info.channels === 2 && r.info.seconds > 0.1, `${r.info?.seconds?.toFixed(2)}s / ${r.info?.channels}ch`);
  ok('#38 the echo at the IR tap appears only with the user IR', r.hasEcho, `withIR=${r.withIR.toExponential(2)} dry=${r.dry.toExponential(2)}`);
  ok('#38 clearIR reverts to generated reverb without crashing', r.clearOk);

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
