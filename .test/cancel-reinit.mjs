// =============================================================================
// cancel-reinit.mjs — F5: cancel leaves state stuck + races the re-init
// -----------------------------------------------------------------------------
// cancelProcessing() used to only flip cancelRequested + terminate() + schedule
// a re-init, never clearing isProcessing and never taking the engine offline —
// so the UI could stick "processing" and a render fired in the ~250ms re-init
// window ran against a terminated/reloading worker. Verified:
//   • cancel synchronously takes the engine offline (engineReady=false), clears
//     the processing lock, terminates the worker, and schedules the re-init
//   • executeFFmpeg refuses while the engine is offline (returns null, does NOT
//     acquire the processing lock)
//
//   node .test/cancel-reinit.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8256);
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
  await page.waitForFunction(() => typeof window.cancelProcessing === 'function' && typeof window.executeFFmpeg === 'function', { timeout: 60000 });
  durable('[boot] cancelProcessing + executeFFmpeg present');

  const r = await page.evaluate(async () => {
    const s = window.state;
    // stub the re-init so cancel doesn't boot a real engine; record it fired
    window.__reinitCalled = false;
    window.initFFmpeg = () => { window.__reinitCalled = true; };

    // simulate a render in flight against a live worker
    let terminated = false;
    s.ffmpeg = { terminate: () => { terminated = true; } };
    s.inputFile = { id: 't', virtualName: 'clip.mp4', name: 'clip.mp4' };
    s.engineReady = true; s.isProcessing = true; s.cancelRequested = false;

    window.cancelProcessing();

    // synchronous post-cancel state
    const afterCancel = {
      engineReady: s.engineReady, isProcessing: s.isProcessing,
      terminated, cancelRequested: s.cancelRequested,
    };

    // a render must refuse while the engine is offline (re-init window)
    const ret = await window.executeFFmpeg(['-i', 'clip.mp4', '-c:v', 'libx264', '-y', 'out.mp4']);
    const refusedWhileOffline = ret === null && s.isProcessing === false;

    // the re-init was scheduled (fires ~250ms later)
    await new Promise((r) => setTimeout(r, 350));
    const reinitScheduled = window.__reinitCalled === true;

    return { afterCancel, refusedWhileOffline, reinitScheduled };
  });

  const a = r.afterCancel;
  ok('F5 cancel synchronously: engine offline, processing lock cleared, worker terminated',
     a.engineReady === false && a.isProcessing === false && a.terminated === true && a.cancelRequested === true,
     `engineReady=${a.engineReady} isProcessing=${a.isProcessing} terminated=${a.terminated}`);
  ok('F5 a render refuses during the offline/re-init window (no lock acquired)', r.refusedWhileOffline);
  ok('F5 a fresh engine re-init is scheduled after cancel', r.reinitScheduled);

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
