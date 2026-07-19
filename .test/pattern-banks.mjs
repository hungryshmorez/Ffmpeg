// =============================================================================
// pattern-banks.mjs — pattern banks, 8 slots (#75)
// -----------------------------------------------------------------------------
// Drives the REAL VJ deck via FFVJ. Verified:
//   • save the current sequencer pattern to bank 0, change the pattern, recall
//     bank 0 (stopped → immediate) → the pattern is restored
//   • the recalled pattern is a DEEP COPY — editing it doesn't mutate the bank
//   • an empty bank recalls to a no-op (no throw)
//   • while playing, a recall is QUEUED (pendingBank set) not applied instantly
//
//   node .test/pattern-banks.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8234);
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
  await page.waitForFunction(() => typeof state !== 'undefined' && state.engineReady === true, { timeout: 120000 });
  await page.evaluate(() => document.querySelector('[data-tab="vj"]')?.click());
  await page.waitForFunction(() => !!(window.FFVJ && window.FFVJ.saveBank && window.FFVJ.S), { timeout: 15000 });
  durable('[boot] VJ deck + FFVJ.saveBank present');

  const r = await page.evaluate(async () => {
    const VJ = window.FFVJ, S = VJ.S;
    const id = Object.keys(VJ.TRIGGERS)[0];
    S.playing = false; S.pendingBank = -1;
    // set a distinctive pattern (steps 0,4,8,12 on for the first trigger)
    S.pattern = {}; S.pattern[id] = new Array(S.steps).fill(false);
    [0, 4, 8, 12].forEach((s) => { S.pattern[id][s] = true; });
    const saved = JSON.stringify(S.pattern);

    VJ.saveBank(0);
    // now change the pattern completely
    S.pattern[id] = new Array(S.steps).fill(false); S.pattern[id][1] = true;
    const changed = JSON.stringify(S.pattern) !== saved;

    VJ.recallBank(0);                    // stopped → immediate
    const restored = JSON.stringify(S.pattern) === saved;

    // deep copy: mutate the recalled pattern, the bank must not change
    S.pattern[id][2] = true;
    const bankUntouched = S.banks[0][id][2] === false;

    // empty bank recall is a no-op (no throw)
    let emptyOk = true; try { VJ.recallBank(5); } catch (_) { emptyOk = false; }

    // while playing, a recall is queued not applied
    S.playing = true; S.pattern[id] = new Array(S.steps).fill(false);
    VJ.saveBank(1);                      // bank 1 = all-off
    S.pattern[id][3] = true;             // change current
    VJ.recallBank(1);                    // should QUEUE (pendingBank=1), not apply now
    const queued = S.pendingBank === 1 && S.pattern[id][3] === true;
    S.playing = false;

    return { changed, restored, bankUntouched, emptyOk, queued };
  });

  ok('#75 save + recall restores the pattern', r.changed && r.restored);
  ok('#75 the recalled pattern is a deep copy (bank untouched by edits)', r.bankUntouched);
  ok('#75 recalling an empty bank is a safe no-op', r.emptyOk);
  ok('#75 while playing, a recall is queued for the next bar', r.queued);

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
