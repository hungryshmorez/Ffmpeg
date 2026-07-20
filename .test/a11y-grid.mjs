// =============================================================================
// a11y-grid.mjs — keyboard-navigable, accessible card grids (UX redesign)
// -----------------------------------------------------------------------------
// The Media Bin and the 215-card Workflow grid are now single-tab-stop ARIA
// listboxes with roving-tabindex arrow navigation. Verified against the REAL
// workflow grid + a synthetic bin container:
//   • the grid is role=listbox with a label; cards are role=option
//   • exactly ONE card is in the tab order (tabindex 0); the rest are -1, and
//     inner buttons are removed from the tab order (no 600-stop keyboard trap)
//   • ArrowRight/Left move focus between cards; Home/End jump; the roving
//     tabindex follows focus
//   • Enter runs the card's primary action; a typed secondary key runs another
//   • columnsOf detects the grid's column count for up/down navigation
//
//   node .test/a11y-grid.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8259);
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
  await page.waitForFunction(() => !!(window.FFGridNav && window.renderWorkflows), { timeout: 60000 });
  durable('[boot] FFGridNav present');

  // ensure the workflow grid is rendered + enhanced
  await page.evaluate(() => { window.switchTab && window.switchTab('workflows'); window.renderWorkflows && window.renderWorkflows(); });
  await page.waitForFunction(() => document.querySelectorAll('#workflows-grid .wf-card').length > 5, { timeout: 20000 });

  const r = await page.evaluate(() => {
    const grid = document.getElementById('workflows-grid');
    const cards = () => Array.from(grid.querySelectorAll('.wf-card'));

    // ARIA + roving tabindex
    const listbox = grid.getAttribute('role') === 'listbox' && !!grid.getAttribute('aria-label');
    const optionRoles = cards().slice(0, 10).every((c) => c.getAttribute('role') === 'option');
    const tabStops = cards().filter((c) => c.tabIndex === 0).length;      // exactly one
    const innerTrapped = cards().slice(0, 10).every((c) => Array.from(c.querySelectorAll('button')).every((b) => b.tabIndex === -1));

    // arrow navigation moves focus between cards
    const list = cards();
    list[0].focus();
    const startFocused = document.activeElement === list[0];
    grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    // dispatch on the focused element so closest(sel) resolves
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const movedRight = document.activeElement === list[1] || document.activeElement === list[2];
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    const jumpedEnd = document.activeElement === list[list.length - 1];
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    const jumpedHome = document.activeElement === list[0];

    // 'i' toggles the info/command detail (done BEFORE Enter, which navigates
    // to the editor when no clip is loaded and would hide the grid).
    list[2].focus();
    const detailBefore = list[2].querySelector('.wf-detail')?.classList.contains('show');
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }));
    const detailAfter = list[2].querySelector('.wf-detail')?.classList.contains('show');
    const infoToggled = detailBefore !== detailAfter;

    // columnsOf detects a real multi-column layout (grid still visible here)
    const cols = window.FFGridNav.columnsOf(list);

    // Enter runs the primary action (spy the run button) — LAST, may switch tabs
    let ran = false;
    const firstRun = list[0].querySelector('[data-wf-run]');
    if (firstRun) firstRun.addEventListener('click', () => { ran = true; }, { once: true });
    list[0].focus();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    // --- synthetic bin container: generic module behaviour ---
    const strip = document.createElement('div');
    strip.id = '__test_strip';
    for (let i = 0; i < 4; i++) { const d = document.createElement('div'); d.className = 'media-bin-card'; d.innerHTML = '<button>x</button>'; strip.appendChild(d); }
    document.body.appendChild(strip);
    let activated = -1;
    window.FFGridNav.enhance(strip, { itemSelector: '.media-bin-card', label: 'Media bin', onActivate: (c) => { activated = Array.from(strip.children).indexOf(c); } });
    const binCards = Array.from(strip.querySelectorAll('.media-bin-card'));
    const binOneTabStop = binCards.filter((c) => c.tabIndex === 0).length === 1;
    binCards[0].focus();
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const binMoved = document.activeElement === binCards[1];
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const binActivated = activated === 1;
    strip.remove();

    return { listbox, optionRoles, tabStops, innerTrapped, startFocused, movedRight, jumpedEnd, jumpedHome, ran, infoToggled, cols, binOneTabStop, binMoved, binActivated };
  });

  ok('grid is an ARIA listbox with labelled options and exactly one tab stop', r.listbox && r.optionRoles && r.tabStops === 1, `tabStops=${r.tabStops}`);
  ok('inner card buttons are removed from the tab order (no keyboard trap)', r.innerTrapped);
  ok('Arrow / Home / End move focus between cards (roving tabindex)', r.startFocused && r.movedRight && r.jumpedEnd && r.jumpedHome,
     `right=${r.movedRight} end=${r.jumpedEnd} home=${r.jumpedHome}`);
  ok('Enter runs the primary action and a typed key runs a secondary one', r.ran && r.infoToggled, `ran=${r.ran} infoToggled=${r.infoToggled}`);
  ok('columnsOf detects the real multi-column grid layout', r.cols >= 2, `cols=${r.cols}`);
  ok('the generic module enhances a bin container (one tab stop, arrows move, Enter activates)', r.binOneTabStop && r.binMoved && r.binActivated);

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
