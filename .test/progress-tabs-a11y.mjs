// =============================================================================
// progress-tabs-a11y.mjs — UX: honest progress feedback + accessible tablist
// -----------------------------------------------------------------------------
// Area 3 (visual feedback) + area 5 (a11y):
//   • setProgress is now MONOTONIC within a run (ffmpeg.wasm reports jittery,
//     backward-jumping values) — the bar never goes backward; pct<=0 resets it
//   • an indeterminate "working…" pulse shows while processing but progress is
//     still 0 (encoder warmup), and clears once real progress arrives
//   • the progressbar's ARIA (role + aria-valuenow) tracks the state
//   • the tab bar is a real WAI tablist: the active tab is aria-selected with a
//     roving tabindex, and ←/→/Home/End move + activate tabs by keyboard
//
//   node .test/progress-tabs-a11y.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8260);
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
  await page.addInitScript(() => { try { localStorage.setItem('ffs.mode', 'both'); localStorage.setItem('ffstudio.tour.v1', 'done'); } catch (_) {} });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.setProgress === 'function' && typeof window.switchTab === 'function', { timeout: 60000 });
  // bootV2() binds the tab-bar arrow navigation ~50ms after DOMContentLoaded.
  await page.waitForFunction(() => document.getElementById('tab-bar') && document.getElementById('tab-bar').__tabnav === true, { timeout: 20000 });
  durable('[boot] setProgress + switchTab + tab nav present');

  const r = await page.evaluate(() => {
    const track = document.getElementById('progress-track');
    const fill = document.getElementById('progress-fill');
    const widthPct = () => parseFloat(fill.style.width) || 0;

    // --- monotonic: a backward-jumping report never moves the bar backward ---
    window.state.isProcessing = false;
    window.setProgress(0);
    window.setProgress(50);
    const at50 = widthPct();
    window.setProgress(30);                 // ffmpeg jitter — must be ignored
    const stayed = widthPct();
    window.setProgress(70);
    const rose = widthPct();
    const monotonic = at50 === 50 && stayed === 50 && rose === 70;

    // --- reset on a fresh run (pct <= 0) ---
    window.setProgress(0);
    const reset = widthPct() === 0;

    // --- ARIA valuenow tracks progress ---
    window.setProgress(42);
    const ariaTracks = track.getAttribute('role') === 'progressbar' && track.getAttribute('aria-valuenow') === '42';

    // --- indeterminate pulse while processing but progress still 0 ---
    window.state.isProcessing = true;
    window.setProgress(0);
    const indetOn = track.classList.contains('indeterminate') && !track.hasAttribute('aria-valuenow');
    window.setProgress(25);                 // real progress arrives → pulse clears
    const indetOff = !track.classList.contains('indeterminate') && track.getAttribute('aria-valuenow') === '25';
    window.state.isProcessing = false;

    // --- accessible tablist: aria-selected + roving tabindex ---
    window.switchTab('workflows');
    const bar = document.getElementById('tab-bar');
    const btnFor = (t) => bar.querySelector(`.tab-btn[data-tab="${t}"]`);
    const wfBtn = btnFor('workflows');
    const selectedOnActive = wfBtn.getAttribute('aria-selected') === 'true' && wfBtn.tabIndex === 0;
    const othersDeselected = Array.from(bar.querySelectorAll('.tab-btn'))
      .filter((b) => b !== wfBtn).every((b) => b.getAttribute('aria-selected') === 'false' && b.tabIndex === -1);

    // --- ←/→ move + activate across the tablist ---
    const visibleTabs = Array.from(bar.querySelectorAll('.tab-btn')).filter((b) => !b.hidden && b.offsetParent !== null);
    wfBtn.focus();
    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const afterRight = bar.querySelector('.tab-btn[aria-selected="true"]');
    const movedRight = afterRight && afterRight !== wfBtn;
    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    const afterHome = bar.querySelector('.tab-btn[aria-selected="true"]');
    const homeWorks = afterHome === visibleTabs[0];

    return { monotonic, at50, stayed, rose, reset, ariaTracks, indetOn, indetOff, selectedOnActive, othersDeselected, movedRight, homeWorks };
  });

  ok('progress is monotonic — a backward ffmpeg report never moves the bar back', r.monotonic, `50→${r.stayed}→${r.rose}`);
  ok('a fresh run (pct<=0) resets the progress ceiling', r.reset);
  ok('the progressbar ARIA (role + aria-valuenow) tracks progress', r.ariaTracks);
  ok('indeterminate pulse shows during the 0% warmup and clears on real progress', r.indetOn && r.indetOff, `on=${r.indetOn} off=${r.indetOff}`);
  ok('the active tab is aria-selected with a roving tabindex (others deselected)', r.selectedOnActive && r.othersDeselected);
  ok('arrow / Home keys move and activate tabs across the tablist', r.movedRight && r.homeWorks);

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
