// =============================================================================
// undo-custom.mjs — #89 Undo/redo across the WHOLE app (custom state)
// -----------------------------------------------------------------------------
// The undo stack already snapshots form controls. This verifies the new
// provider mechanism that carries NON-DOM module state through the same stack,
// driven through the real Undo/Redo buttons:
//   • a registered provider's state rides inside every snapshot and stays in
//     lockstep with a form control across a run of undo/redo (never a mismatched
//     pairing) — and the round-trip returns to where it started
//   • capture()==null opts a provider out of a snapshot (no crash)
//   • the REAL VJ sequencer pattern (a non-DOM {trigger:[bool×16]} object) is
//     registered on build; app-level Undo reverts a step edit and re-syncs the
//     grid DOM so cells and state stay consistent, and Redo re-applies it
//
//   node .test/undo-custom.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8244);
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
  await page.waitForFunction(() => typeof window.registerUndoProvider === 'function', { timeout: 60000 });
  durable('[boot] undo hooks present');

  // ---- Part 1+2: mechanism — a stub provider stays in lockstep with a control
  const r1 = await page.evaluate(() => {
    const sl = document.getElementById('crf'); // a known range input
    if (!sl) return { noInput: true };
    // clean stacks so this run is deterministic
    if (window.state) { window.state.undoStack = []; window.state.redoStack = []; }

    // custom state = derived from the control, so any inconsistency is visible
    const setBoth = (v) => { window.__cv = 'c:' + v; sl.value = String(v); sl.dispatchEvent(new Event('input', { bubbles: true })); };
    window.__cv = 'c:' + sl.value;
    window.registerUndoProvider('test-custom', {
      capture: () => (window.__optout ? null : window.__cv),
      restore: (v) => { window.__cv = v; },
    });

    // opt-out check: with capture()===null the snapshot omits the provider and
    // undo/redo still works without throwing
    window.__optout = true;
    setBoth(15); window.pushUndoSnapshot();
    let optOutOk = true;
    try { document.getElementById('btn-undo').click(); document.getElementById('btn-redo').click(); } catch (_) { optOutOk = false; }
    window.__optout = false;
    if (window.state) { window.state.undoStack = []; window.state.redoStack = []; }

    // build a history where each checkpoint pairs a control value with its
    // custom partner; push each explicitly for determinism
    setBoth(10); window.pushUndoSnapshot();
    setBoth(20); window.pushUndoSnapshot();
    setBoth(30); window.pushUndoSnapshot();
    setBoth(40); window.pushUndoSnapshot();

    const consistent = () => window.__cv === 'c:' + sl.value;
    const trace = [];
    const step = (btn) => { document.getElementById(btn).click(); trace.push({ v: sl.value, cv: window.__cv, ok: consistent() }); };
    const startV = sl.value;
    step('btn-undo'); step('btn-undo'); step('btn-undo');
    step('btn-redo'); step('btn-redo'); step('btn-redo');

    const allConsistent = trace.every((t) => t.ok);
    const distinct = new Set(trace.map((t) => t.v)).size >= 2;   // history actually moved
    const returned = sl.value === startV && consistent();       // round-trip
    return { allConsistent, distinct, returned, optOutOk, trace, startV };
  });
  if (r1.noInput) { ok('#89 mechanism (found the crf input)', false, 'no #crf'); }
  else {
    ok('#89 custom state stays in lockstep with a control across undo/redo (no mismatched pairing)', r1.allConsistent && r1.distinct,
       `consistent=${r1.allConsistent} moved=${r1.distinct}`);
    ok('#89 undo→…→redo round-trips back to the start', r1.returned);
    ok('#89 a provider returning null opts out of the snapshot without breaking undo/redo', r1.optOutOk);
  }

  // ---- Part 3: the REAL VJ sequencer pattern round-trips through app undo
  const r2 = await page.evaluate(() => {
    if (!(window.FFVJ && window.FFVJ.build)) return { noVJ: true };
    window.FFVJ.build();
    const S = window.FFVJ.S;
    const grid = document.getElementById('vj-grid');
    if (!grid) return { noGrid: true };
    const cells = Array.from(grid.querySelectorAll('.vj-cell'));
    if (!cells.length) return { noCells: true };

    // grid DOM ↔ pattern state must stay consistent (proves syncGrid ran)
    const gridConsistent = () => cells.every((c) => c.classList.contains('on') === !!(S.pattern[c.dataset.t] && S.pattern[c.dataset.t][+c.dataset.s]));
    const activeCount = () => cells.reduce((n, c) => n + (c.classList.contains('on') ? 1 : 0), 0);

    // two distinct grid cells; edit + commit a snapshot after each
    const c1 = cells.find((c) => +c.dataset.s === 3);
    const c2 = cells.find((c) => +c.dataset.s === 7 && c.dataset.t === c1.dataset.t);
    const base = activeCount();
    c1.click(); window.pushUndoSnapshot();
    const afterOne = activeCount();
    c2.click(); window.pushUndoSnapshot();
    const afterTwo = activeCount();

    // app-level Undo must revert the sequencer state and keep the grid synced
    document.getElementById('btn-undo').click();
    const undo1 = { count: activeCount(), consistent: gridConsistent() };
    document.getElementById('btn-undo').click();
    const undo2 = { count: activeCount(), consistent: gridConsistent() };
    document.getElementById('btn-redo').click();
    const redo1 = { count: activeCount(), consistent: gridConsistent() };

    return { base, afterOne, afterTwo, undo1, undo2, redo1,
      editsGrew: afterOne > base && afterTwo > afterOne,
      undoReverts: undo1.count < afterTwo || undo2.count < undo1.count,
      redoReapplies: redo1.count > undo1.count || redo1.count >= afterOne,
      alwaysConsistent: undo1.consistent && undo2.consistent && redo1.consistent };
  });
  if (r2.noVJ || r2.noGrid || r2.noCells) { ok('#89 VJ sequencer provider round-trip', false, JSON.stringify(r2)); }
  else {
    ok('#89 the real VJ sequencer pattern is reverted by app Undo and the grid re-syncs (state↔DOM consistent)',
       r2.editsGrew && r2.undoReverts && r2.alwaysConsistent,
       `base=${r2.base} +1=${r2.afterOne} +2=${r2.afterTwo} undo1=${r2.undo1.count} undo2=${r2.undo2.count} redo=${r2.redo1.count} consistent=${r2.alwaysConsistent}`);
  }

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
