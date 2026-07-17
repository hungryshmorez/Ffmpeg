// =============================================================================
// panic.mjs — the VJ PANIC control resets everything (#77)
// -----------------------------------------------------------------------------
// A live tool can't ship without a panic. This latches triggers, starts the
// sequencer and pulls the master down, then hits PANIC (both the button and the
// "0" key) and asserts on OBSERVED state that everything dropped: no latched or
// held triggers, sequencer stopped, no lit pads, master back to full.
//
//   node .test/panic.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8193);
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

// state snapshot after a settle
const snap = (page) => page.evaluate(() => ({
  active: [...window.FFVJ.S.active],
  held: [...window.FFVJ.S.held],
  playing: window.FFVJ.S.playing,
  lit: document.querySelectorAll('.vj-pad.lit').length,
  master: document.getElementById('vj-master')?.value,
}));

try {
  if (!USE_EXTERNAL) { server = await startServer(); console.log(`[server] listening on ${BASE}`); }
  browser = await chromium.launch({ executablePath: process.env.PW_EXEC || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  page.on('dialog', (d) => d.accept().catch(() => {}));

  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.engineReady === true, { timeout: 120000 });
  durable('[boot] engine ready');

  // Open the VJ tab so the deck + engine build.
  await page.evaluate(() => document.querySelector('[data-tab="vj"]').click());
  await page.waitForFunction(() => !!(window.FFVJ && document.getElementById('vj-panic')), { timeout: 15000 });

  // Build the "everything on" state: latch two triggers, run the sequencer,
  // pull the master down.
  const on = await page.evaluate(async () => {
    window.FFVJ.fire('flash', false);       // latched
    window.FFVJ.fire('invert', false);      // latched
    document.getElementById('vj-play').click();          // sequencer on
    const mst = document.getElementById('vj-master'); mst.value = '0.4';
    await new Promise((r) => setTimeout(r, 100));
    return { active: [...window.FFVJ.S.active], playing: window.FFVJ.S.playing,
             lit: document.querySelectorAll('.vj-pad.lit').length, master: mst.value };
  });
  ok('triggers latch + sequencer runs (setup)',
    on.active.length >= 2 && on.playing === true && on.lit >= 2,
    `active=${on.active.length} playing=${on.playing} lit=${on.lit}`);

  // PANIC via the button.
  await page.evaluate(() => document.getElementById('vj-panic').click());
  await page.waitForTimeout(120);
  const afterBtn = await snap(page);
  ok('PANIC button resets everything',
    afterBtn.active.length === 0 && afterBtn.held.length === 0 && afterBtn.playing === false &&
    afterBtn.lit === 0 && afterBtn.master === '1',
    `active=${afterBtn.active.length} playing=${afterBtn.playing} lit=${afterBtn.lit} master=${afterBtn.master}`);

  // Re-arm, then PANIC via the "0" key.
  await page.evaluate(async () => {
    window.FFVJ.fire('flash', false);
    window.FFVJ.fire('glitch', false);
    document.getElementById('vj-master').value = '0.2';
    await new Promise((r) => setTimeout(r, 60));
  });
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true })));
  await page.waitForTimeout(120);
  const afterKey = await snap(page);
  ok('"0" key resets everything',
    afterKey.active.length === 0 && afterKey.held.length === 0 && afterKey.playing === false &&
    afterKey.lit === 0 && afterKey.master === '1',
    `active=${afterKey.active.length} lit=${afterKey.lit} master=${afterKey.master}`);

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
