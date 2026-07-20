// =============================================================================
// mobile.mjs — the app fits and responds to touch on iPad + phone
// -----------------------------------------------------------------------------
// Loads the real app in touch-emulated contexts at phone, iPad-portrait and
// iPad-landscape sizes and asserts on OBSERVED layout + touch behaviour:
//   • the page never scrolls sideways (no element overflows the viewport width —
//     the iPad-portrait header used to push the body 99px wide)
//   • a real touch TAP switches tabs (buttons respond to touch, not just mouse)
//   • an off-screen tab (VJ) is reachable — the tab bar scrolls and taps through
//
// Chromium's touch emulation is not Safari, so this proves layout + touch
// dispatch, not iOS-specific engine quirks (SharedArrayBuffer, codecs). Those
// are called out in the README as needing real hardware.
//
//   node .test/mobile.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8185);
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

const PROFILES = [
  { name: 'iPhone', w: 390, h: 844 },
  { name: 'iPad-portrait', w: 820, h: 1180 },
  { name: 'iPad-landscape', w: 1180, h: 820 },
];

let server, browser, code = 1;
const checks = [];
const ok = (name, pass, detail) => { checks.push(pass); durable(`  ${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`); };

try {
  if (!USE_EXTERNAL) { server = await startServer(); console.log(`[server] listening on ${BASE}`); }
  browser = await chromium.launch({ executablePath: process.env.PW_EXEC || undefined, args: ['--no-sandbox'] });

  for (const prof of PROFILES) {
    const ctx = await browser.newContext({ viewport: { width: prof.w, height: prof.h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    // This test checks LAYOUT, not onboarding — pre-gate the mode picker and the
    // getting-started tour so neither overlay intercepts the layout taps.
    await page.addInitScript(() => { try { localStorage.setItem('ffs.mode', 'both'); localStorage.setItem('ffstudio.tour.v1', 'done'); } catch (_) {} });
    await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof state !== 'undefined' && state.engineReady === true, { timeout: 120000 }).catch(() => {});
    await page.evaluate(() => document.querySelector('.firstrun [data-mode="both"]')?.click());
    await page.waitForTimeout(300);

    // No horizontal page scroll on any tab.
    const overflow = await page.evaluate(() => {
      const tabs = ['workflows', 'editor', 'preview', 'audio', 'tripcam', 'vj', 'clips', 'graph', 'agents'];
      let worst = 0, worstTab = '';
      for (const t of tabs) {
        window.switchTab?.(t);
        const o = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth;
        if (o > worst) { worst = o; worstTab = t; }
      }
      window.switchTab?.('workflows');
      return { worst, worstTab };
    });
    ok(`${prof.name}: no horizontal page overflow`, overflow.worst <= 2,
      overflow.worst > 2 ? `${overflow.worst}px on ${overflow.worstTab}` : '0px');

    // Only exercise touch on the phone (the tightest case).
    if (prof.name === 'iPhone') {
      // A real touch tap switches tabs.
      await page.tap('.tab-btn[data-tab="editor"]');
      await page.waitForTimeout(150);
      const t1 = await page.evaluate(() => document.querySelector('.tab-btn.active')?.dataset.tab);
      ok('touch tap switches tabs', t1 === 'editor', `active=${t1}`);

      // An off-screen tab (VJ) is reachable — Playwright taps scroll it in first.
      await page.tap('.tab-btn[data-tab="vj"]');
      await page.waitForTimeout(150);
      const t2 = await page.evaluate(() => document.querySelector('.tab-btn.active')?.dataset.tab);
      ok('off-screen VJ tab reachable by touch', t2 === 'vj', `active=${t2}`);
    }
    await ctx.close();
  }

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 5 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
