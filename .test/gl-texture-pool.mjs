// =============================================================================
// gl-texture-pool.mjs — #20 texture pooling on adaptive-quality resize
// -----------------------------------------------------------------------------
// The TripCam/VJ WebGL engine re-sizes its render target whenever the load
// shedder changes quality tiers (FFPerf.scale). The old path DELETED and
// RECREATED 3 textures + 2 framebuffers on EVERY tier change — GPU-object churn
// and GC pressure through the whole of a live set. Pooling reuses the objects
// and only re-specifies their storage.
//
// Instrumenting the real GL context (prototype patched BEFORE any engine is
// built, so counts are absolute) this asserts:
//   • the constructor allocates exactly 3 textures (srcTex + ping + pong)
//   • MANY resizes create ZERO new textures and delete ZERO — no churn
//   • _freeTextures() still releases everything on teardown (→ 0 live)
//
// (The older gl-texture-leak test only proves live = created − deleted stays
// bounded, which the delete+recreate path also satisfied; this proves the
// churn itself is gone.)
//
//   node .test/gl-texture-pool.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8272);
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
  browser = await chromium.launch({ executablePath: process.env.PW_EXEC || undefined, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.TripCam && window.TripCam.TripEngine), { timeout: 60000 });
  durable('[boot] TripCam.TripEngine present');

  const r = await page.evaluate(async () => {
    // Instrument the GL prototype BEFORE constructing — absolute call counts.
    const c = { createTex: 0, deleteTex: 0 };
    const patch = (proto) => {
      if (!proto || proto.__poolPatched) return;
      proto.__poolPatched = true;
      const ct = proto.createTexture, dt = proto.deleteTexture;
      proto.createTexture = function () { c.createTex++; return ct.call(this); };
      proto.deleteTexture = function (t) { if (t) c.deleteTex++; return dt.call(this, t); };
    };
    patch(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
    patch(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);

    const cv = document.createElement('canvas');
    cv.width = 320; cv.height = 240;
    document.body.appendChild(cv);
    let engine;
    try { engine = new window.TripCam.TripEngine(cv); }
    catch (e) { return { noGL: true, err: e.message }; }
    const createTexCtor = c.createTex;

    // many resizes (the load shedder flipping quality tiers)
    const createBefore = c.createTex, deleteBefore = c.deleteTex;
    const sizes = [[300, 220], [240, 180], [176, 132], [280, 210], [200, 150], [160, 120], [320, 240], [128, 96]];
    for (const [w, h] of sizes) { cv.width = w; cv.height = h; engine._initTextures(); }
    const createDuringResizes = c.createTex - createBefore;
    const deleteDuringResizes = c.deleteTex - deleteBefore;

    // teardown releases everything
    const liveBeforeFree = c.createTex - c.deleteTex;
    engine._freeTextures();
    const liveAfterFree = c.createTex - c.deleteTex;

    return { noGL: false, resizes: sizes.length, createTexCtor, createDuringResizes, deleteDuringResizes, liveBeforeFree, liveAfterFree };
  });

  if (r.noGL) {
    durable('  SKIP — WebGL unavailable in this environment (' + (r.err || '') + ')');
    durable('==== skipped (no WebGL) ====');
    code = 0;
  } else {
    ok('the constructor allocates exactly 3 textures (srcTex + ping + pong)',
       r.createTexCtor === 3, `createTex=${r.createTexCtor}`);
    ok('resizes create ZERO new textures — objects are pooled, not recreated',
       r.createDuringResizes === 0, `${r.createDuringResizes} created over ${r.resizes} resizes`);
    ok('resizes delete ZERO textures — no churn / GC pressure on tier changes',
       r.deleteDuringResizes === 0, `${r.deleteDuringResizes} deleted over ${r.resizes} resizes`);
    ok('_freeTextures() still releases the pooled textures on teardown',
       r.liveBeforeFree === 3 && r.liveAfterFree === 0, `${r.liveBeforeFree} → ${r.liveAfterFree} live`);

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
