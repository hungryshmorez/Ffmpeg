// =============================================================================
// palette-a11y.mjs — accessibility for the existing Ctrl/⌘+K command palette
// -----------------------------------------------------------------------------
// The app already ships a command palette (tools.js). It worked but used plain
// <div>s with no ARIA, so assistive tech couldn't follow it. This verifies the
// added semantics + that the core interaction still works:
//   • Ctrl+K opens a role=dialog; the input is a role=combobox and is focused
//   • results are role=option inside a role=listbox; the selected one is
//     aria-selected=true and the input's aria-activedescendant points at it
//   • ArrowDown advances the selection and the aria-activedescendant follows
//   • Escape closes the palette
//
//   node .test/palette-a11y.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8264);
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
  await page.waitForFunction(() => !!(window.FFTools && window.FFTools.openPalette), { timeout: 60000 });
  durable('[boot] FFTools.openPalette present');

  const r = await page.evaluate(async () => {
    const type = (v) => { const i = document.getElementById('cmdk-input'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); };
    const key = (k) => { const ov = document.querySelector('.cmdk-overlay'); (ov || document).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); };
    const isOpen = () => !!document.querySelector('.cmdk-overlay');

    // Ctrl+K opens the dialog
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 40));
    const dlg = document.querySelector('.cmdk-overlay .cmdk');
    const inp = document.getElementById('cmdk-input');
    const openedDialog = isOpen() && dlg.getAttribute('role') === 'dialog' && inp.getAttribute('role') === 'combobox' && document.activeElement === inp;

    // results carry listbox/option roles + aria-selected on the active one
    type('go');
    const list = document.getElementById('cmdk-list');
    const listboxRole = list.getAttribute('role') === 'listbox';
    const opts = Array.from(list.querySelectorAll('[role="option"]'));
    const haveOptions = opts.length > 1;
    const firstSelected = opts[0] && opts[0].getAttribute('aria-selected') === 'true';
    const adPointsFirst = inp.getAttribute('aria-activedescendant') === opts[0].id;

    // ArrowDown advances selection + aria-activedescendant follows
    key('ArrowDown');
    const opts2 = Array.from(document.querySelectorAll('#cmdk-list [role="option"]'));
    const secondSelected = opts2[1] && opts2[1].getAttribute('aria-selected') === 'true';
    const adFollows = document.getElementById('cmdk-input').getAttribute('aria-activedescendant') === opts2[1].id;

    // Escape closes
    key('Escape');
    const closed = !isOpen();

    return { openedDialog, listboxRole, haveOptions, firstSelected, adPointsFirst, secondSelected, adFollows, closed, optCount: opts.length };
  });

  ok('Ctrl+K opens a role=dialog with a role=combobox input, focused', r.openedDialog);
  ok('results are role=option in a role=listbox with the active one aria-selected', r.listboxRole && r.haveOptions && r.firstSelected, `${r.optCount} options`);
  ok('the input aria-activedescendant points at the selected option', r.adPointsFirst);
  ok('ArrowDown advances the selection and aria-activedescendant follows', r.secondSelected && r.adFollows);
  ok('Escape closes the palette', r.closed);

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
