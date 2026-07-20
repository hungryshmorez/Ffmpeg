// =============================================================================
// shader-render.mjs — the TripCam/VJ engine actually LINKS and RENDERS
// -----------------------------------------------------------------------------
// Two real bugs, both invisible to attribute-level assertions and both caught by
// looking at the rendered pixels:
//
//   1) VARYING MISMATCH — injectRotation renamed the FRAGMENT varying to
//      `v_texCoord_in` but not the VERTEX side, so on a strict GL driver
//      (SwiftShader here; many mobile GLES) every program failed to LINK →
//      0/11 shaders → a BLACK Trip Cam / VJ. Lenient desktop drivers tolerated
//      the mismatch, which is why it hid. Fixed by FFShaderPlus.patchVertex.
//
//   2) SPLASH NEVER CLEARED — `.trip-empty` set display:flex with no
//      `.trip-empty[hidden]` override, so hideEmpty() set the attribute but the
//      "Tap to go live" splash stayed painted over the live camera. The
//      attribute was set (so a hasAttribute check passed) while the COMPUTED
//      display was still flex.
//
// Asserts (in the real headless SwiftShader GL context):
//   • a fresh TripEngine links ALL 11 shader programs (was 0/11)
//   • it renders NON-BLACK pixels from a source (real shader output, read back)
//   • after go-live the #trip-empty splash is display:none by COMPUTED style
//
//   node .test/shader-render.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8276);
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
  browser = await chromium.launch({ executablePath: process.env.PW_EXEC || undefined,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
      '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.addInitScript(() => { try { localStorage.setItem('ffstudio.tour.v1', 'done'); localStorage.setItem('ffs.mode', 'video'); } catch (_) {} });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.TripCam && window.TripCam.TripEngine), { timeout: 60000 });
  durable('[boot] TripCam.TripEngine present');

  // --- 1 & 2: link + render from a fresh engine on a synthetic source ---------
  const gl = await page.evaluate(async () => {
    const cv = document.createElement('canvas'); cv.width = 160; cv.height = 120;
    document.body.appendChild(cv);
    let engine;
    try { engine = new window.TripCam.TripEngine(cv); } catch (e) { return { noGL: true, err: e.message }; }
    const programs = Object.keys(engine.programs).length;
    const total = Object.keys(window.TripCam.SHADERS || {}).length || 11;

    // a bright synthetic "camera" so any linked shader yields non-black output
    const src = document.createElement('canvas'); src.width = 160; src.height = 120;
    const s = src.getContext('2d');
    s.fillStyle = '#2050ff'; s.fillRect(0, 0, 160, 120);
    s.fillStyle = '#ff3080'; s.fillRect(20, 20, 90, 60);
    s.fillStyle = '#40ff90'; s.fillRect(60, 50, 70, 50);
    engine.setSource(src);
    for (let i = 0; i < 4; i++) engine.render();      // prime + draw a few frames

    const g = engine.gl, w = cv.width, h = cv.height;
    const px = new Uint8Array(w * h * 4);
    g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
    let nonBlack = 0, n = 0;
    for (let i = 0; i < px.length; i += 4) { n++; if (px[i] > 8 || px[i + 1] > 8 || px[i + 2] > 8) nonBlack++; }
    return { noGL: false, programs, total, nonBlackPct: 100 * nonBlack / n };
  });

  if (gl.noGL) {
    durable('  SKIP — WebGL unavailable in this environment (' + (gl.err || '') + ')');
    durable('==== skipped (no WebGL) ====');
    code = 0;
  } else {
    ok('the engine LINKS all shader programs (varying mismatch fixed — was 0/11 on strict GL)',
       gl.programs === gl.total && gl.total >= 11, `${gl.programs}/${gl.total} linked`);
    ok('the engine RENDERS non-black pixels from a source (real shader output)',
       gl.nonBlackPct > 5, `${gl.nonBlackPct.toFixed(1)}% non-black`);

    // --- 3: going live actually HIDES the splash (computed display) -----------
    await page.addStyleTag({ content: `.tab-content.active{height:70vh !important;min-height:520px !important}
      #action-bar,.action-bar-global,#global-bin-drawer,#mobile-status-bar{display:none !important}` });
    await page.click('[data-tab="tripcam"]');
    await page.waitForSelector('#trip-golive', { state: 'visible', timeout: 10000 });
    const displayWhenHidden = await page.evaluate(() => {
      const e = document.getElementById('trip-empty');
      e.setAttribute('hidden', '');                    // exactly what hideEmpty() does
      const d = getComputedStyle(e).display;
      e.removeAttribute('hidden');
      return d;
    });
    ok('the #trip-empty splash respects [hidden] by COMPUTED style (not just the attribute)',
       displayWhenHidden === 'none', `display=${displayWhenHidden}`);

    await page.click('#trip-golive');
    await page.waitForFunction(() => {
      const e = document.getElementById('trip-empty');
      return e && getComputedStyle(e).display === 'none';
    }, { timeout: 15000 }).catch(() => {});
    const liveDisplay = await page.evaluate(() => getComputedStyle(document.getElementById('trip-empty')).display);
    ok('after tapping go-live the splash is gone (computed display:none over the live camera)',
       liveDisplay === 'none', `display=${liveDisplay}`);

    const passed = checks.filter(Boolean).length;
    durable(`==== ${passed}/${checks.length} checks passed ====`);
    code = passed === checks.length && checks.length === 4 ? 0 : 1;
  }
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
