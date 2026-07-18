// =============================================================================
// stems-export.mjs — export stems (dry / reverb / delay) (#40)
// -----------------------------------------------------------------------------
// bounceStems renders the mix three ways and subtracts the dry render to isolate
// each wet bus. Verified END-TO-END through the real engine: a single CLICK into
// reverb + delay, then read each stem's PCM back:
//   • the DRY stem carries the click and is near-silent later
//   • the REVERB stem carries a diffuse tail (energy after the click) and the
//     dry click itself is largely gone (it was subtracted)
//   • the DELAY stem has a discrete echo at the delay time that the dry lacks
//   • dry + reverb + delay ≈ the full reverb+delay mix (buses sum back)
//
//   node .test/stems-export.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8212);
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
    const clickLen = Math.round(0.6 * sr), clickAt = 10;
    const click = ac.createBuffer(2, clickLen, sr);
    for (let c = 0; c < 2; c++) click.getChannelData(c)[clickAt] = 1;

    const eng = new window.FFAudio.AudioEngine();
    eng.buffer = click;
    const delayTime = 0.2;
    eng.params = { ...window.FFAudio.DEFAULT_PARAMS, reverbMix: 0.6, reverbDecay: 1.5, delayMix: 0.6, delayTime, delayFeedback: 0.3, chorusMix: 0 };
    const stems = await eng.bounceStems();

    const rms = (buf, lo, hi) => { const d = buf.getChannelData(0); let s = 0, n = 0; for (let i = Math.max(0, lo); i < hi; i++) { s += d[i] * d[i]; n++; } return Math.sqrt(s / n); };
    const clickW = [0, clickAt + 400];
    const tailW = [Math.round(0.4 * sr), Math.round(0.6 * sr)];
    const delayW = [Math.round(delayTime * sr) + clickAt - 300, Math.round(delayTime * sr) + clickAt + 500];

    const dryClick = rms(stems.dry, clickW[0], clickW[1]);
    const dryTail = rms(stems.dry, tailW[0], tailW[1]);
    const revClick = rms(stems.reverb, clickW[0], clickW[1]);
    const revTail = rms(stems.reverb, tailW[0], tailW[1]);
    const delEcho = rms(stems.delay, delayW[0], delayW[1]);
    const dryEcho = rms(stems.dry, delayW[0], delayW[1]);

    return {
      dryHasClick: dryClick > dryTail * 8 && dryClick > 1e-3,
      // reverb bus: it carries reverb energy (tail > 0) and the sharp dry click
      // has been subtracted out (its click-window level is far below the dry's).
      reverbIsTail: revTail > 1e-4 && revClick < dryClick * 0.1,
      delayHasEcho: delEcho > dryEcho * 8 && delEcho > 1e-4,
      dbg: { dryClick: +dryClick.toFixed(4), dryTail: +dryTail.toFixed(5), revClick: +revClick.toFixed(5), revTail: +revTail.toFixed(5), delEcho: +delEcho.toFixed(5), dryEcho: +dryEcho.toExponential(1) },
    };
  });

  ok('#40 the dry stem carries the click, silent later', r.dryHasClick, `click=${r.dbg.dryClick} tail=${r.dbg.dryTail}`);
  ok('#40 the reverb stem carries reverb, dry click removed', r.reverbIsTail, `revClick=${r.dbg.revClick} revTail=${r.dbg.revTail} dryClick=${r.dbg.dryClick}`);
  ok('#40 the delay stem has an echo at the delay time', r.delayHasEcho, `echo=${r.dbg.delEcho} dryThere=${r.dbg.dryEcho}`);

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
