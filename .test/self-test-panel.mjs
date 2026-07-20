// =============================================================================
// self-test-panel.mjs — #8 in-UI self-test surfaces DECODED-frame results
// -----------------------------------------------------------------------------
// The 🩺 Self-test button runs the encoder smoke test (assertRealVideo) on two
// codecs and reports FRAMES, not bytes, straight into the topbar. This drives
// the real button and asserts the visible panel reports a decoded-frame count
// and a pass verdict — i.e. the encoder actually produced real video, observed
// through the UI the user clicks.
//
//   node .test/self-test-panel.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8273);
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
  // Gate the mode picker + onboarding tour so neither overlay intercepts the click.
  await page.addInitScript(() => { try { localStorage.setItem('ffstudio.tour.v1', 'done'); localStorage.setItem('ffs.mode', 'video'); } catch (_) {} });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.engineReady === true, { timeout: 120000 });
  durable('[boot] engine ready');

  // the button exists in the DOM (the "visible panel" of #8)
  const present = await page.evaluate(() => !!document.getElementById('btn-selftest') && !!document.getElementById('selftest-result'));
  ok('the self-test button + result element are present in the UI', present);

  // click it and wait for the result element to leave the "running" state
  await page.click('#btn-selftest');
  await page.waitForFunction(() => {
    const el = document.getElementById('selftest-result');
    return el && !el.hidden && !el.classList.contains('running') && /\d+f/.test(el.textContent || '');
  }, { timeout: 120000 });

  const res = await page.evaluate(() => {
    const el = document.getElementById('selftest-result');
    return { text: el.textContent || '', cls: el.className, hidden: el.hidden };
  });
  durable(`[selftest] result: "${res.text}" (class="${res.cls}")`);

  const frameHits = [...res.text.matchAll(/(\d+)f/g)].map(m => parseInt(m[1], 10));
  ok('the panel reports a DECODED-frame count for each codec (frames, not bytes)',
     frameHits.length >= 2 && frameHits.every(n => n > 0), `frames=${frameHits.join(',')}`);
  ok('the self-test passed — the encoder produced real video (result shows ✓ / ok state)',
     res.cls.includes('ok') && res.text.includes('✓'), `class=${res.cls}`);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 3 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
