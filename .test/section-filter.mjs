// =============================================================================
// section-filter.mjs — progressive disclosure for the Editor controls
// -----------------------------------------------------------------------------
// The 33-section Editor column now has a controller that reduces the wall to
// just what's relevant. Verified on the real Editor DOM:
//   • the toolbar is injected (search, Active-only, Expand, Collapse, count)
//   • "Active only" hides sections whose enable toggle is off and shows the
//     enabled ones; aria-pressed + the live count update
//   • the search box filters sections by title
//   • Expand / Collapse set the open state of the visible sections
//   • toggling a section's enable live re-applies the filter
//   • the Active-only preference persists to localStorage
//
//   node .test/section-filter.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8261);
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
  await page.waitForFunction(() => !!(window.FFSections && document.getElementById('section-filter')), { timeout: 60000 });
  durable('[boot] FFSections + toolbar present');

  const r = await page.evaluate(() => {
    const S = window.FFSections;
    const secs = () => Array.from(document.querySelectorAll('#controls-column details.section'));
    const titleOf = (s) => (s.querySelector('.section-title')?.textContent || '').toLowerCase();

    // toolbar exists with all controls
    const bar = document.getElementById('section-filter');
    const toolbarOk = !!bar && !!document.getElementById('section-search') && !!document.getElementById('section-active-only')
      && !!document.getElementById('section-expand') && !!document.getElementById('section-collapse') && !!document.getElementById('section-count');

    // reset: uncheck every enable, then enable just the Crop section
    S.setTerm(''); S.setActiveOnly(false);
    secs().forEach((s) => { const cb = s.querySelector('.section-enable'); if (cb) cb.checked = false; });
    const crop = secs().find((s) => titleOf(s).includes('crop'));
    const cropCb = crop && crop.querySelector('.section-enable');
    if (cropCb) cropCb.checked = true;

    // --- Active only ---
    S.setActiveOnly(true);
    const disabledSection = secs().find((s) => { const cb = s.querySelector('.section-enable'); return cb && !cb.checked; });
    const activeOnlyWorks = crop && !crop.hidden && disabledSection && disabledSection.hidden === true
      && document.getElementById('section-active-only').getAttribute('aria-pressed') === 'true';
    const countHasNumber = /\d/.test(document.getElementById('section-count').textContent);

    // --- live: enabling a hidden section reveals it while active-only is on ---
    const target = secs().find((s) => { const cb = s.querySelector('.section-enable'); return cb && !cb.checked && s.hidden; });
    let liveReveal = false;
    if (target) { const cb = target.querySelector('.section-enable'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); liveReveal = !target.hidden; }

    // --- Search filters by title ---
    S.setActiveOnly(false);
    S.setTerm('crop');
    const searchShows = crop && !crop.hidden;
    const searchHidesRest = secs().filter((s) => !titleOf(s).includes('crop')).every((s) => s.hidden);
    S.setTerm('');

    // --- Expand / Collapse the visible sections ---
    document.getElementById('section-expand').click();
    const allOpen = secs().filter((s) => !s.hidden).every((s) => s.open);
    document.getElementById('section-collapse').click();
    const allClosed = secs().filter((s) => !s.hidden).every((s) => !s.open);

    // --- persistence ---
    S.setActiveOnly(true);
    const persisted = (() => { try { return localStorage.getItem(S.KEY) === '1'; } catch (_) { return false; } })();
    S.setActiveOnly(false);

    return { total: secs().length, toolbarOk, activeOnlyWorks, countHasNumber, liveReveal, searchShows, searchHidesRest, allOpen, allClosed, persisted };
  });

  ok('the disclosure toolbar is injected with all controls', r.toolbarOk, `${r.total} sections`);
  ok('"Active only" hides disabled sections, shows enabled ones, updates aria-pressed + count', r.activeOnlyWorks && r.countHasNumber);
  ok('enabling a section live reveals it while "Active only" is on', r.liveReveal);
  ok('the search box filters sections by title', r.searchShows && r.searchHidesRest);
  ok('Expand / Collapse set the open state of the visible sections', r.allOpen && r.allClosed);
  ok('the Active-only preference persists to localStorage', r.persisted);

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
