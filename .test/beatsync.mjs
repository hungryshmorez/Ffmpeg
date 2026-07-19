// =============================================================================
// beatsync.mjs — auto-sync an edit to the beat grid (#83)
// -----------------------------------------------------------------------------
// The cut-on-beat assembler, verified DETERMINISTICALLY over a synthetic beat
// grid (120 BPM → a beat every 0.5 s):
//   • snapToBeats nudges arbitrary cut times to the nearest beat
//   • beatSegments(perCut=4) puts a boundary every 4 beats (every 2 s)
//   • assembleOnBeats lays clips into beat-length segments — every cut lands on
//     a beat, and a clip shorter than its segment is used whole while a longer
//     one is trimmed to fit
//
//   node .test/beatsync.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8225);
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
  await page.waitForFunction(() => !!(window.FFBeatSync && window.FFBeatSync.assembleOnBeats), { timeout: 60000 });
  durable('[boot] FFBeatSync present');

  const r = await page.evaluate(async () => {
    const BS = window.FFBeatSync;
    const beats = []; for (let i = 0; i < 17; i++) beats.push(i * 0.5);   // 0,0.5,…,8.0

    const snapped = BS.snapToBeats([0.3, 0.9, 1.4, 2.1], beats);
    const snapOk = JSON.stringify(snapped) === JSON.stringify([0.5, 1.0, 1.5, 2.0]);

    const segs = BS.beatSegments(beats, 4);      // every 4th beat → 0,2,4,6,8
    const segOk = JSON.stringify(segs) === JSON.stringify([0, 2, 4, 6, 8]);

    // 3 clips: one shorter than its 2 s segment, one longer, one unspecified
    const clips = [{ id: 'a', duration: 1.2 }, { id: 'b', duration: 5 }, { id: 'c' }];
    const timeline = BS.assembleOnBeats(clips, beats, 4);
    const onBeat = timeline.every((t) => beats.includes(t.at));
    const shortWhole = Math.abs(timeline[0].take - 1.2) < 1e-9;      // clip a used whole
    const longTrimmed = Math.abs(timeline[1].take - 2.0) < 1e-9;     // clip b trimmed to 2 s
    const positions = timeline.map((t) => t.at);
    const cutsSpaced = JSON.stringify(positions) === JSON.stringify([0, 2, 4]);

    return { snapOk, segOk, onBeat, shortWhole, longTrimmed, cutsSpaced, dbg: { snapped, segs, positions, takes: timeline.map((t) => t.take) } };
  });

  ok('#83 snapToBeats nudges cuts to the nearest beat', r.snapOk, `${JSON.stringify(r.dbg.snapped)}`);
  ok('#83 beatSegments puts a boundary every N beats', r.segOk, `${JSON.stringify(r.dbg.segs)}`);
  ok('#83 assembled cuts all land on beats, spaced by the segment', r.onBeat && r.cutsSpaced, `at=${JSON.stringify(r.dbg.positions)}`);
  ok('#83 short clip used whole, long clip trimmed to the segment', r.shortWhole && r.longTrimmed, `takes=${JSON.stringify(r.dbg.takes)}`);

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
