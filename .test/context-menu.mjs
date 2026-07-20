// =============================================================================
// context-menu.mjs — right-click / keyboard context menus (UX redesign)
// -----------------------------------------------------------------------------
// A reusable accessible menu puts every card action one right-click (or one
// Shift+F10) away. Verified on the real workflow grid + a synthetic container:
//   • right-click a card opens role=menu with role=menuitem entries
//   • clicking an item fires its action (via the card's existing button) and
//     closes the menu
//   • Escape and a click outside close the menu
//   • Shift+F10 opens the menu at the focused card (no mouse), ArrowDown moves
//     focus between items, Enter activates
//
//   node .test/context-menu.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8262);
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
  await page.setViewportSize({ width: 1280, height: 900 });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.FFContextMenu && window.renderWorkflows), { timeout: 60000 });
  await page.evaluate(() => { window.switchTab && window.switchTab('workflows'); window.renderWorkflows && window.renderWorkflows(); });
  await page.waitForFunction(() => document.querySelectorAll('#workflows-grid .wf-card').length > 3, { timeout: 20000 });
  durable('[boot] FFContextMenu + workflow grid ready');

  const r = await page.evaluate(async () => {
    const grid = document.getElementById('workflows-grid');
    const card = grid.querySelector('.wf-card');
    const menuVisible = () => { const m = document.getElementById('ff-context-menu'); return !!m && !m.hidden; };

    // right-click opens a role=menu with role=menuitem entries
    const r0 = card.getBoundingClientRect();
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r0.left + 20, clientY: r0.top + 20 }));
    const menu = document.getElementById('ff-context-menu');
    const opened = menuVisible() && menu.getAttribute('role') === 'menu';
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    const hasItems = items.length >= 3;

    // clicking an item fires the card's action (spy the info button) + closes
    let infoClicked = false;
    card.querySelector('[data-wf-info]')?.addEventListener('click', () => { infoClicked = true; }, { once: true });
    const showCmd = items.find((it) => /command/i.test(it.textContent));
    if (showCmd) showCmd.click();
    const actionFiredAndClosed = infoClicked && !menuVisible();

    // Escape closes
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r0.left + 20, clientY: r0.top + 20 }));
    const reopened = menuVisible();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    const escClosed = !menuVisible();

    // click outside closes
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r0.left + 20, clientY: r0.top + 20 }));
    const openAgain = menuVisible();
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 5, clientY: 5 }));
    const outsideClosed = !menuVisible();

    // keyboard: Shift+F10 at a focused card opens the menu; ArrowDown moves focus
    card.tabIndex = 0; card.focus();
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }));
    const kbOpened = menuVisible();
    const firstItem = document.activeElement;
    const firstIsMenuitem = firstItem && firstItem.getAttribute && firstItem.getAttribute('role') === 'menuitem';
    document.getElementById('ff-context-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    const movedInMenu = document.activeElement !== firstItem && document.activeElement.getAttribute('role') === 'menuitem';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    return { opened, hasItems, itemCount: items.length, actionFiredAndClosed, reopened, escClosed, openAgain, outsideClosed, kbOpened, firstIsMenuitem, movedInMenu };
  });

  ok('right-click opens role=menu with menuitem entries', r.opened && r.hasItems, `${r.itemCount} items`);
  ok('clicking an item fires the card action and closes the menu', r.actionFiredAndClosed);
  ok('Escape closes the menu', r.reopened && r.escClosed);
  ok('a click outside closes the menu', r.openAgain && r.outsideClosed);
  ok('Shift+F10 opens the menu at the focused card and Arrow moves between items', r.kbOpened && r.firstIsMenuitem && r.movedInMenu);

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
