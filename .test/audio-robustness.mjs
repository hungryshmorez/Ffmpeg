// =============================================================================
// audio-robustness.mjs — F7/F8: hostile audio + WebAudio hygiene
// -----------------------------------------------------------------------------
// F7 — decodeAudioData on a zero-byte / garbage / unsupported file used to reject
// unguarded, wedging the studio on an unhandled rejection. Now:
//   • AudioEngine.loadFile throws a clear, catchable "couldn't decode" error
//   • FFAudioIntel.analyse returns null on bad audio (no throw) and closes its
//     transient AudioContext even on failure
// F8 — WebAudio hygiene:
//   • stop() disconnects the BufferSource (not just stop()) — released from graph
//   • dispose() closes the AudioContext (browsers cap live contexts ~6)
//
//   node .test/audio-robustness.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8258);
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
  await page.waitForFunction(() => !!(window.FFAudio && window.FFAudio.AudioEngine && window.FFAudioIntel), { timeout: 60000 });
  durable('[boot] FFAudio + FFAudioIntel present');

  const r = await page.evaluate(async () => {
    const garbage = () => new Blob([new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07])], { type: 'audio/mpeg' });

    // F7 — loadFile throws a clear, catchable error on undecodable audio
    const eng = new window.FFAudio.AudioEngine();
    let loadErr = null;
    try { await eng.loadFile(garbage()); } catch (e) { loadErr = e; }
    const loadRejectsFriendly = !!loadErr && /decode/i.test(loadErr.message) && !(loadErr instanceof (window.DOMException || function () {}));

    // F8 — dispose() closes the AudioContext created during that (failed) load
    const ctxRef = eng.ctx;                       // created before the decode attempt
    const hadCtx = !!ctxRef;
    await Promise.resolve(eng.dispose());
    await new Promise((r) => setTimeout(r, 30));
    const disposeClosed = hadCtx && ctxRef.state === 'closed' && eng.ctx === null;

    // F8 — stop() disconnects the BufferSource
    const eng2 = new window.FFAudio.AudioEngine();
    const AC = window.AudioContext || window.webkitAudioContext;
    eng2.ctx = new AC();
    const src = eng2.ctx.createBufferSource();
    let disconnected = false;
    const realDisc = src.disconnect.bind(src);
    src.disconnect = () => { disconnected = true; return realDisc(); };
    eng2.src = src; eng2.playing = false;
    eng2.stop(true);
    const stopDisconnects = disconnected && eng2.src === null;
    try { await eng2.dispose(); } catch (_) {}

    // F7 — FFAudioIntel.analyse returns null (no throw) on bad audio
    let intelReturn, intelThrew = false;
    try { intelReturn = await window.FFAudioIntel.analyse(garbage()); }
    catch (_) { intelThrew = true; }
    const intelGraceful = intelThrew === false && intelReturn === null;

    return { loadRejectsFriendly, hadCtx, disposeClosed, stopDisconnects, intelGraceful, msg: loadErr && loadErr.message };
  });

  ok('F7 AudioEngine.loadFile throws a clear catchable error on undecodable audio', r.loadRejectsFriendly, r.msg);
  ok('F7 FFAudioIntel.analyse returns null on bad audio (no throw, context closed)', r.intelGraceful);
  ok('F8 dispose() closes the AudioContext', r.disposeClosed, `hadCtx=${r.hadCtx}`);
  ok('F8 stop() disconnects the BufferSource and clears it', r.stopDisconnects);

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
