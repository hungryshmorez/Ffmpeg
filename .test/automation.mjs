// =============================================================================
// automation.mjs — automation recording (#76)
// -----------------------------------------------------------------------------
// The Automation recorder is pure, verified DETERMINISTICALLY:
//   • record() only logs while recording, and stamps each move relative to the
//     take start
//   • valueAt is sample-and-hold — the last move at or before t (undefined before
//     the first move)
//   • stateAt returns every parameter's value at a time (the patch to apply)
//   • serialize / deserialize round-trips the take
//
//   node .test/automation.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8235);
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
  await page.waitForFunction(() => !!(window.FFAutomation && window.FFAutomation.Automation), { timeout: 60000 });
  durable('[boot] FFAutomation present');

  const r = await page.evaluate(async () => {
    const A = window.FFAutomation.Automation;
    const a = new A();
    // not recording yet → record() is a no-op
    a.record('master', 0.9, 100);
    const ignoredBeforeStart = a.length === 0;

    a.start(10);                       // take starts at clock=10
    a.record('master', 0.5, 10);       // t=0
    a.record('master', 0.8, 11);       // t=1
    a.record('bpm', 128, 11.5);        // t=1.5
    a.record('master', 0.2, 12);       // t=2
    a.stop();

    const relTimes = a.events.map((e) => +e.t.toFixed(2));
    const stamped = JSON.stringify(relTimes) === JSON.stringify([0, 1, 1.5, 2]);

    // sample-and-hold
    const beforeFirst = a.valueAt('master', -1) === undefined;
    const holdMid = a.valueAt('master', 0.5) === 0.5 && a.valueAt('master', 1.5) === 0.8 && a.valueAt('master', 5) === 0.2;
    const otherParam = a.valueAt('bpm', 2) === 128 && a.valueAt('bpm', 0.5) === undefined;

    // stateAt = whole patch
    const st = a.stateAt(1.6);
    const stateOk = st.master === 0.8 && st.bpm === 128;

    // round-trip
    const back = window.FFAutomation.Automation.deserialize(a.serialize());
    const roundTrips = back.length === 4 && back.valueAt('master', 5) === 0.2;

    return { ignoredBeforeStart, stamped, sampleHold: beforeFirst && holdMid && otherParam, stateOk, roundTrips, dbg: { relTimes } };
  });

  ok('#76 record() is a no-op until a take starts, then stamps relative time', r.ignoredBeforeStart && r.stamped, `t=${JSON.stringify(r.dbg.relTimes)}`);
  ok('#76 valueAt is sample-and-hold (last move ≤ t)', r.sampleHold);
  ok('#76 stateAt returns the whole patch at a time', r.stateOk);
  ok('#76 serialize / deserialize round-trips the take', r.roundTrips);

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
