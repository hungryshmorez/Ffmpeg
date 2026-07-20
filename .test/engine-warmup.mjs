// =============================================================================
// engine-warmup.mjs — #23 preload the core on Editor intent
// -----------------------------------------------------------------------------
// The ~30 MB core load is deferred 2 s after paint (#22). #23 warms it EARLY the
// moment the user shows intent to edit (hovering the Editor tab), and otherwise
// falls back to the 2 s timer. Whoever fires first wins; the other is a no-op.
// window.__engineWarm records {reason, at} so we can observe which path warmed.
//
// Asserts:
//   • hovering the Editor tab warms the engine with reason "editor intent",
//     well before the 2 s fallback timer would have fired
//   • with no interaction, the fallback timer warms it with reason "boot timer"
//   • warming actually starts the load (the engine reaches ready)
//
//   node .test/engine-warmup.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8274);
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

// keep the mode picker + tour from overlaying the tab bar
const gate = () => { try { localStorage.setItem('ffstudio.tour.v1', 'done'); localStorage.setItem('ffs.mode', 'video'); } catch (_) {} };

try {
  if (!USE_EXTERNAL) { server = await startServer(); console.log(`[server] listening on ${BASE}`); }
  browser = await chromium.launch({ executablePath: process.env.PW_EXEC || undefined, args: ['--no-sandbox'] });

  // ---- intent path: hover the Editor tab before the 2 s timer ---------------
  {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
    await page.addInitScript(gate);
    await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
    // sanity: crossOriginIsolated so the SAB (2 s-deferred) boot branch is the one running
    const coi = await page.evaluate(() => window.crossOriginIsolated === true);
    await page.waitForSelector('.tab-btn[data-tab="editor"]', { state: 'visible', timeout: 15000 });
    await page.hover('.tab-btn[data-tab="editor"]');    // intent — before 2 s
    await page.waitForFunction(() => !!window.__engineWarm, { timeout: 4000 });
    const warm = await page.evaluate(() => window.__engineWarm);
    ok('hovering the Editor tab warms the engine with reason "editor intent"',
       coi && warm && warm.reason === 'editor intent', `coi=${coi} reason=${warm && warm.reason} at=${warm && Math.round(warm.at)}ms`);

    // and warming actually kicks the load through to ready
    const ready = await page.waitForFunction(() => typeof state !== 'undefined' && state.engineReady === true, { timeout: 120000 }).then(() => true).catch(() => false);
    ok('the early-warmed engine loads through to ready', ready);
    await page.close();
  }

  // ---- fallback path: no interaction → the 2 s timer warms it ---------------
  {
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
    await page.addInitScript(gate);
    await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
    // do nothing; wait past the 2 s deferral
    const warm = await page.waitForFunction(() => window.__engineWarm || null, { timeout: 8000 }).then(h => h.jsonValue()).catch(() => null);
    ok('with no interaction, the fallback timer warms the engine with reason "boot timer"',
       !!warm && warm.reason === 'boot timer', `reason=${warm && warm.reason}`);
    await page.close();
  }

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
