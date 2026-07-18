// =============================================================================
// highlights.mjs — auto-detect interesting moments (#82)
// -----------------------------------------------------------------------------
// The scoring + reel assembler over per-window signals, verified
// DETERMINISTICALLY:
//   • scoreWindows normalises energy + motion and adds a scene-cut bonus — a
//     window that peaks in both scores highest
//   • pickHighlights returns the top moments, MINGAP seconds apart (so a burst
//     of adjacent hot windows contributes one pick, not five)
//   • the reel comes back in chronological order
//   • a scene-cut window outscores an otherwise identical non-cut window
//
//   node .test/highlights.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8226);
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
  await page.waitForFunction(() => !!(window.FFHighlights && window.FFHighlights.pickHighlights), { timeout: 60000 });
  durable('[boot] FFHighlights present');

  const r = await page.evaluate(async () => {
    const HL = window.FFHighlights;
    // 20 one-second windows; energy+motion peak around t=5 and t=14, quiet elsewhere
    const windows = [];
    for (let t = 0; t < 20; t++) {
      const e = Math.exp(-((t - 5) ** 2) / 4) + 0.8 * Math.exp(-((t - 14) ** 2) / 4) + 0.05;
      const mo = Math.exp(-((t - 5) ** 2) / 6) + 0.6 * Math.exp(-((t - 14) ** 2) / 6) + 0.05;
      windows.push({ t, energy: e, motion: mo, sceneCut: t === 14 });
    }
    const reel = HL.pickHighlights(windows, { count: 3, minGap: 3 });
    const times = reel.map((w) => w.t);
    // top two picks should be near the two peaks (5 and 14)
    const foundPeaks = times.some((t) => Math.abs(t - 5) <= 1) && times.some((t) => Math.abs(t - 14) <= 1);
    // spacing: all picks ≥ minGap apart
    let spaced = true; for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] < 3) spaced = false;
    // chronological
    const chrono = times.slice().sort((a, b) => a - b).join(',') === times.join(',');

    // scene-cut bonus: identical windows, one with a cut, scores higher
    const base = [{ t: 0, energy: 0.5, motion: 0.5 }, { t: 1, energy: 0.5, motion: 0.5, sceneCut: true }];
    const sc = HL.scoreWindows(base);
    const cutBoost = sc[1].score > sc[0].score;

    return { foundPeaks, spaced, chrono, cutBoost, dbg: { times } };
  });

  ok('#82 the reel picks the energy/motion peaks', r.foundPeaks, `times=${JSON.stringify(r.dbg.times)}`);
  ok('#82 picks are kept minGap apart (a burst contributes one)', r.spaced, `times=${JSON.stringify(r.dbg.times)}`);
  ok('#82 the reel is returned chronologically', r.chrono);
  ok('#82 a scene-cut window outscores an identical non-cut one', r.cutBoost);

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
