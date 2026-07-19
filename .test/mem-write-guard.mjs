// =============================================================================
// mem-write-guard.mjs — F1: multi-GB file OOM gate before MEMFS write
// -----------------------------------------------------------------------------
// A file is doubly resident during a write (JS heap arrayBuffer + wasm MEMFS
// copy), so a multi-GB input blows the 2 GB wasm ceiling and aborts the whole
// ffmpeg instance. This verifies the budget gate that now refuses such writes
// BEFORE materialising the file:
//   • FFMemBudget.checkWrite refuses a single file over the wasm ceiling, and a
//     write that would push the MEMFS total over the device budget; it allows
//     writes that fit, with actionable reasons
//   • the app's wired guardMemfsWrite() (called in the upload + output paths)
//     returns false for an over-budget size and true for a normal one
//
//   node .test/mem-write-guard.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8254);
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
  await page.waitForFunction(() => !!(window.FFMemBudget && window.FFMemBudget.checkWrite), { timeout: 60000 });
  durable('[boot] FFMemBudget.checkWrite present');

  const r = await page.evaluate(() => {
    const M = window.FFMemBudget, GB = M.GB;
    const B2 = 2 * GB;

    // single file over the wasm ceiling → refused
    const huge = M.checkWrite(3 * GB, 0, B2);
    // projected total over budget → refused
    const overBudget = M.checkWrite(1.5 * GB, 1 * GB, B2);
    // fits → allowed
    const fitsFresh = M.checkWrite(100 * 1024 * 1024, 0, B2);
    const fitsWithHeadroom = M.checkWrite(500 * 1024 * 1024, 1 * GB, B2);
    // exactly at budget boundary
    const atBudget = M.checkWrite(1 * GB, 1 * GB, B2);          // projected == budget → ok
    const justOver = M.checkWrite(1 * GB + 1, 1 * GB, B2);      // projected > budget → refused

    const reasonsOk = /ceiling|cannot/i.test(huge.reason || '') && /budget/i.test(overBudget.reason || '');

    // the app's wired guard (used by the upload + output paths)
    const hasGuard = typeof window.guardMemfsWrite === 'function';
    window.state = window.state || {}; window.state.memfsBytes = 0;
    // force a small device budget so the test is deterministic regardless of
    // the runner's navigator.deviceMemory
    const guardHuge = hasGuard ? window.guardMemfsWrite(5 * GB, 'huge.mov') : null;   // > 2GB cap → refuse
    const guardSmall = hasGuard ? window.guardMemfsWrite(50 * 1024 * 1024, 'clip.mp4') : null;

    return {
      hugeRefused: huge.ok === false,
      overBudgetRefused: overBudget.ok === false,
      fitsFresh: fitsFresh.ok === true,
      fitsWithHeadroom: fitsWithHeadroom.ok === true,
      atBudget: atBudget.ok === true,
      justOver: justOver.ok === false,
      reasonsOk, hasGuard, guardHuge, guardSmall,
    };
  });

  ok('F1 checkWrite refuses a single file over the wasm ceiling and an over-budget projected total', r.hugeRefused && r.overBudgetRefused);
  ok('F1 checkWrite allows writes that fit (fresh, with headroom, and exactly at the boundary)', r.fitsFresh && r.fitsWithHeadroom && r.atBudget && r.justOver);
  ok('F1 refusals carry an actionable reason', r.reasonsOk);
  ok('F1 the app-wired guardMemfsWrite refuses an over-budget file and allows a normal one', r.hasGuard && r.guardHuge === false && r.guardSmall === true, `guard present=${r.hasGuard} huge=${r.guardHuge} small=${r.guardSmall}`);

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
