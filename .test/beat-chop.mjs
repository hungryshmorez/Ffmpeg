// =============================================================================
// beat-chop.mjs — beat-grid quantised chopping (#36)
// -----------------------------------------------------------------------------
// Slice on beats, then rearrange/repeat. Verified DETERMINISTICALLY over a
// 120 BPM grid (a beat every 0.5 s):
//   • chopOnBeats turns N beats into N-1 contiguous slices (last extends to the
//     clip end)
//   • rearrangeSlices lays a source-index order onto a fresh timeline — a
//     shuffle reorders, a repeat (stutter) duplicates a slice, and the output
//     duration is the sum of the taken slices
//   • an out-of-range index is skipped, not fatal
//
//   node .test/beat-chop.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8228);
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
  await page.waitForFunction(() => !!(window.FFBeatSync && window.FFBeatSync.chopOnBeats), { timeout: 60000 });
  durable('[boot] FFBeatSync.chopOnBeats present');

  const r = await page.evaluate(async () => {
    const BS = window.FFBeatSync;
    const beats = [0, 0.5, 1.0, 1.5];
    const slices = BS.chopOnBeats(beats, { duration: 2.0 });
    const choppedRight = slices.length === 4 &&
      slices[0].start === 0 && slices[0].end === 0.5 &&
      slices[3].start === 1.5 && slices[3].end === 2.0;

    // shuffle: reverse the order
    const shuffle = BS.rearrangeSlices(slices, [3, 2, 1, 0]);
    const shuffled = shuffle.steps.length === 4 && shuffle.steps[0].from === 3 && shuffle.steps[3].from === 0 &&
      shuffle.steps[0].at === 0 && Math.abs(shuffle.steps[1].at - 0.5) < 1e-9;

    // stutter: repeat slice 0 four times
    const stutter = BS.rearrangeSlices(slices, [0, 0, 0, 0]);
    const stuttered = stutter.steps.length === 4 && stutter.steps.every((s) => s.from === 0) && Math.abs(stutter.duration - 2.0) < 1e-9;

    // out-of-range index skipped
    const safe = BS.rearrangeSlices(slices, [0, 99, 1]);
    const skips = safe.steps.length === 2 && safe.steps[1].from === 1;

    return { choppedRight, shuffled, stuttered, skips, dbg: { n: slices.length, stutterDur: stutter.duration } };
  });

  ok('#36 chopOnBeats slices the clip on the grid', r.choppedRight, `${r.dbg.n} slices`);
  ok('#36 rearrange shuffles slices onto a fresh timeline', r.shuffled);
  ok('#36 repeat (stutter) duplicates a slice, duration sums', r.stuttered, `dur=${r.dbg.stutterDur}`);
  ok('#36 an out-of-range index is skipped, not fatal', r.skips);

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
