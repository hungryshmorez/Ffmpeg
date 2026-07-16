// =============================================================================
// shortcuts.mjs — keyboard-shortcut coverage + cheat sheet (#96)
// -----------------------------------------------------------------------------
// Boots the REAL app and drives the keyboard, asserting on observed UI state:
//   • "?"            opens the cheat sheet, and it lists the VJ performance keys
//                    (auto-generated from FFVJ.TRIGGERS, so they can't drift)
//   • Escape         closes it
//   • "]" / "["      cycle to the next / previous tab
//   • Alt+6          jumps straight to the VJ tab
//
// These are real KeyboardEvents dispatched on document, and every check reads
// back the resulting DOM (active tab, modal visibility, row contents) — not a
// claim that the handler "exists".
//
//   node .test/shortcuts.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8151);
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
  return new Promise((resolve, reject) => {
    srv.on('error', reject);
    srv.listen(PORT, () => resolve(srv));
  });
}

// Dispatch a keydown on document exactly as the browser would.
const key = (page, k, opts = {}) => page.evaluate(({ k, opts }) => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
}, { k, opts });

let server, browser, code = 1;
const checks = [];
const ok = (name, pass, detail) => {
  checks.push(pass);
  durable(`  ${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`);
};

try {
  if (!USE_EXTERNAL) { server = await startServer(); console.log(`[server] listening on ${BASE}`); }
  else console.log(`[server] using external ${BASE}`);

  browser = await chromium.launch({ executablePath: process.env.PW_EXEC || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  page.on('dialog', (d) => d.accept().catch(() => {}));

  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.engineReady === true, { timeout: 120000 });
  durable('[boot] engine ready');

  const modalHidden = () => page.evaluate(() =>
    document.getElementById('shortcuts-modal').classList.contains('hidden'));
  const activeTab = () => page.evaluate(() =>
    document.querySelector('.tab-btn.active')?.dataset.tab || null);

  ok('cheat sheet starts hidden', await modalHidden());

  // "?" opens it.
  await key(page, '?');
  ok('"?" opens the cheat sheet', !(await modalHidden()));

  // VJ performance keys are listed, auto-generated from FFVJ.TRIGGERS.
  const vj = await page.evaluate(() => {
    const body = document.getElementById('shortcuts-vj-body');
    const rows = body ? body.querySelectorAll('tr').length : 0;
    const txt = body ? body.textContent : '';
    const triggerCount = window.FFVJ?.TRIGGERS ? Object.keys(window.FFVJ.TRIGGERS).length : 0;
    return { rows, hasDatamosh: /Datamosh/.test(txt), hasFlash: /Flash/.test(txt), triggerCount };
  });
  ok('cheat sheet lists every VJ key',
    vj.rows === vj.triggerCount && vj.triggerCount >= 16 && vj.hasDatamosh && vj.hasFlash,
    `${vj.rows} rows / ${vj.triggerCount} triggers`);

  // Escape closes it.
  await key(page, 'Escape');
  ok('Escape closes the cheat sheet', await modalHidden());

  // Tab cycling with "]" then "[".
  const start = await activeTab();
  await key(page, ']');
  const afterNext = await activeTab();
  await key(page, '[');
  const afterPrev = await activeTab();
  ok('"]" / "[" cycle tabs',
    afterNext && afterNext !== start && afterPrev === start,
    `${start} →] ${afterNext} →[ ${afterPrev}`);

  // Alt+6 jumps to the VJ tab.
  await key(page, '6', { altKey: true });
  ok('Alt+6 → VJ tab', (await activeTab()) === 'vj', `active=${await activeTab()}`);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 6 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
