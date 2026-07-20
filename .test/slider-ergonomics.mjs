// =============================================================================
// slider-ergonomics.mjs — DAW-style range-input ergonomics (UX redesign)
// -----------------------------------------------------------------------------
// Every <input type=range> now supports double-click-to-reset and (when focused)
// wheel-to-nudge, via one delegated listener so it covers dynamically-built
// controls. Verified on real editor sliders + a dynamically-added one:
//   • double-click resets a slider to its markup default and fires input+change
//   • wheel over a FOCUSED slider nudges by one step; Shift = ×10
//   • wheel over an UNFOCUSED slider does nothing (never hijacks page scroll)
//   • the behaviour reaches a slider added to the DOM after load (delegation)
//
//   node .test/slider-ergonomics.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8263);
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
  await page.waitForFunction(() => !!(window.FFSliders && document.getElementById('crf')), { timeout: 60000 });
  durable('[boot] FFSliders + #crf present');

  const r = await page.evaluate(() => {
    // #crf lives in the Editor tab; it must be visible to be focusable for wheel.
    if (window.switchTab) window.switchTab('editor');
    const crf = document.getElementById('crf');          // min 0 max 51 value 23 step 1
    const def = crf.getAttribute('value');
    let inputFired = false;
    const onInput = () => { inputFired = true; };

    // double-click resets to default + fires input
    crf.value = '40';
    crf.addEventListener('input', onInput, { once: true });
    crf.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const resetOk = crf.value === def && inputFired;

    // wheel while focused nudges by step; Shift = ×10
    crf.focus();
    crf.value = '20';
    crf.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    const nudgedUp = crf.value === '21';
    crf.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    const nudgedDown = crf.value === '20';
    crf.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, shiftKey: true, bubbles: true, cancelable: true }));
    const bigStep = crf.value === '30';

    // wheel while NOT focused does nothing
    crf.blur(); document.body.focus();
    crf.value = '25';
    crf.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
    const unfocusedNoOp = crf.value === '25';

    // clamps to min/max
    crf.focus(); crf.value = '51';
    crf.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, shiftKey: true, bubbles: true, cancelable: true }));
    const clamped = crf.value === '51';

    // delegation reaches a slider added AFTER load
    const s = document.createElement('input');
    s.type = 'range'; s.min = '0'; s.max = '10'; s.step = '1'; s.setAttribute('value', '5');
    document.body.appendChild(s);
    s.value = '8';
    s.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const dynamicReset = s.value === '5';
    s.remove();

    return { resetOk, nudgedUp, nudgedDown, bigStep, unfocusedNoOp, clamped, dynamicReset };
  });

  ok('double-click resets a slider to its default and fires input/change', r.resetOk);
  ok('wheel over a focused slider nudges by one step (up and down)', r.nudgedUp && r.nudgedDown);
  ok('Shift+wheel nudges by ×10 and the value clamps to the range', r.bigStep && r.clamped);
  ok('wheel over an unfocused slider does nothing (no page-scroll hijack)', r.unfocusedNoOp);
  ok('the behaviour reaches a slider added to the DOM after load (delegation)', r.dynamicReset);

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
