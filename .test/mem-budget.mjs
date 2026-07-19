// =============================================================================
// mem-budget.mjs — #24 A real (unified) memory budget
// -----------------------------------------------------------------------------
// MEMFS + GPU textures + VideoFrames + AudioBuffers unified into one number vs a
// device-derived budget. Verified:
//   • the per-source estimators compute correct byte counts (RGBA texture, YUV
//     vs RGBA video frame, Float32 audio, MEMFS file sum)
//   • report()/total() sum the live sources; clear() removes one
//   • status() trips ok → warn → over at the right fractions of the budget, and
//     the budget respects navigator.deviceMemory (capped at the wasm ceiling)
//   • renderInto paints one readout with the right level class, and attach()
//     surfaces a #mem-budget element that folds in the live MEMFS figure
//
//   node .test/mem-budget.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8250);
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
  await page.waitForFunction(() => !!(window.FFMemBudget && window.FFMemBudget.status), { timeout: 60000 });
  durable('[boot] FFMemBudget present');

  const r = await page.evaluate(() => {
    const M = window.FFMemBudget;

    // estimators
    const tex = M.textureBytes(1920, 1080, 3) === 1920 * 1080 * 4 * 3;
    const vfRgba = M.videoFrameBytes(1280, 720, 2, 'rgba') === 1280 * 720 * 4 * 2;
    const vfYuv = M.videoFrameBytes(1280, 720, 2, 'i420') === Math.round(1280 * 720 * 1.5 * 2);
    const aud = M.audioBufferBytes(2, 44100 * 10) === 2 * 44100 * 10 * 4;
    const memfs = M.memfsBytesOf([{ size: 1000 }, { length: 2000 }, {}]) === 3000;
    const estimatorsOk = tex && vfRgba && vfYuv && aud && memfs;

    // report / total / clear
    M.clear();
    M.report('memfs', 100 * 1024 * 1024);
    M.report('gpu', M.textureBytes(1920, 1080, 4));
    M.report('audio', M.audioBufferBytes(2, 44100 * 30));
    const t1 = M.total();
    const sumExpected = 100 * 1024 * 1024 + 1920 * 1080 * 4 * 4 + 2 * 44100 * 30 * 4;
    const totalOk = t1 === sumExpected;
    M.clear('gpu');
    const afterClear = M.total() === sumExpected - 1920 * 1080 * 4 * 4;

    // status thresholds against a fixed budget of 1 GB
    const B = 1024 * 1024 * 1024;
    M.clear(); M.report('x', 0.5 * B); const okLevel = M.status(B).level === 'ok';
    M.clear(); M.report('x', 0.8 * B); const warnLevel = M.status(B).level === 'warn';
    M.clear(); M.report('x', 0.95 * B); const overLevel = M.status(B).level === 'over';
    const thresholdsOk = okLevel && warnLevel && overLevel;

    // device budget honours navigator.deviceMemory and the wasm cap
    const dev = M.deviceBudgetBytes();
    const dm = navigator.deviceMemory;
    const budgetOk = dev > 0 && dev <= M.HARD_CAP && (!dm || dev <= Math.round(dm * M.GB * 0.4) + 1);

    // renderInto paints a readout + level class
    const el = document.createElement('span');
    M.clear(); M.report('x', 0.95 * B);
    M.renderInto(el, M.status(B));
    const painted = /MEM .* \/ .* \(95%\)/.test(el.textContent) && el.classList.contains('over');

    return { estimatorsOk, totalOk, afterClear, thresholdsOk, budgetOk, dev, dm: dm || null, painted, readout: el.textContent };
  });
  ok('#24 per-source estimators are correct (RGBA texture, RGBA/YUV frame, Float32 audio, MEMFS sum)', r.estimatorsOk);
  ok('#24 report()/total() sum live sources and clear() removes one', r.totalOk && r.afterClear);
  ok('#24 status() trips ok → warn → over at the right budget fractions', r.thresholdsOk);
  ok('#24 the budget respects navigator.deviceMemory and the wasm cap', r.budgetOk, `budget=${(r.dev / (1024 ** 3)).toFixed(2)}GB deviceMemory=${r.dm}`);
  ok('#24 renderInto paints one unified readout with the right level class', r.painted, r.readout);

  // attach() surfaces a live #mem-budget readout that folds in MEMFS
  const r2 = await page.evaluate(() => {
    const M = window.FFMemBudget;
    window.state = window.state || {};
    window.state.memfsBytes = 250 * 1024 * 1024;
    M.attach(600);
    M.refresh();
    const el = document.getElementById('mem-budget');
    const hasEl = !!el && /MEM /.test(el.textContent);
    const foldsMemfs = M.breakdown().memfs === 250 * 1024 * 1024;
    // multi-GB budgets must format correctly (no 32-bit overflow → "0 B")
    M.clear(); M.report('x', 3 * M.GB);
    const bigFmt = M.format(3 * M.GB) === '3.00 GB' && M.format(2 * M.GB) === '2.00 GB';
    const budgetNotZero = !/\/ 0 B/.test(el.textContent);
    return { hasEl, foldsMemfs, bigFmt, budgetNotZero, text: el ? el.textContent : null };
  });
  ok('#24 attach() surfaces a #mem-budget readout that folds in the live MEMFS figure', r2.hasEl && r2.foldsMemfs, r2.text);
  ok('#24 multi-GB figures format correctly (no 32-bit overflow to "0 B")', r2.bigFmt && r2.budgetNotZero);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 7 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
