// =============================================================================
// prefs.mjs — preferences panel (#95)
// -----------------------------------------------------------------------------
// Verified in the REAL app:
//   • defaults are returned before anything is saved
//   • set() persists to localStorage AND survives a reload (round trip)
//   • apply() reflects prefs onto the document — reduce-motion class + accent var
//   • reset() clears back to defaults
//   • the "," key opens the preferences modal
//
//   node .test/prefs.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8237);
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
  await page.waitForFunction(() => !!(window.FFPrefs && window.FFPrefs.set), { timeout: 60000 });
  durable('[boot] FFPrefs present');

  // start clean
  await page.evaluate(() => window.FFPrefs.reset());

  const defaultsOk = await page.evaluate(() => {
    const p = window.FFPrefs.all();
    return p.defaultFormat === 'mp4' && p.reduceMotion === false && p.autoSuggest === true;
  });
  ok('#95 defaults are returned before anything is saved', defaultsOk);

  const applied = await page.evaluate(() => {
    window.FFPrefs.set('reduceMotion', true);
    window.FFPrefs.set('accent', '#ff3366');
    window.FFPrefs.set('defaultFormat', 'webm');
    return {
      cls: document.documentElement.classList.contains('reduce-motion'),
      accent: document.documentElement.style.getPropertyValue('--accent').trim(),
      stored: !!localStorage.getItem('ffstudio.prefs.v1'),
    };
  });
  ok('#95 set() applies to the document (reduce-motion + accent) and persists', applied.cls && applied.accent === '#ff3366' && applied.stored, `accent=${applied.accent}`);

  // reload — prefs must survive
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.FFPrefs && window.FFPrefs.all), { timeout: 30000 });
  const survived = await page.evaluate(() => {
    const p = window.FFPrefs.all();
    return { fmt: p.defaultFormat, motion: p.reduceMotion, cls: document.documentElement.classList.contains('reduce-motion') };
  });
  ok('#95 preferences survive a reload and re-apply', survived.fmt === 'webm' && survived.motion === true && survived.cls, `fmt=${survived.fmt}`);

  // "," opens the modal
  await page.evaluate(() => document.getElementById('ff-prefs-modal')?.remove());
  await page.keyboard.press(',');
  const opened = await page.evaluate(() => { const m = document.getElementById('ff-prefs-modal'); return !!m && !m.hidden; });
  ok('#95 the "," key opens the preferences modal', opened);

  // reset clears back
  const wasReset = await page.evaluate(() => { window.FFPrefs.reset(); return window.FFPrefs.all().defaultFormat === 'mp4'; });
  ok('#95 reset() returns to defaults', wasReset);

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
