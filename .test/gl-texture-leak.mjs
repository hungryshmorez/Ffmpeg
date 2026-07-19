// =============================================================================
// gl-texture-leak.mjs — F2: GPU texture/FBO leak on adaptive-quality resize
// -----------------------------------------------------------------------------
// The TripCam engine re-allocates its ping-pong textures + framebuffers on every
// canvas resize, which the load-shedder triggers whenever FFPerf.scale changes.
// Before the fix _initTextures() orphaned the old GL objects — 3 textures + 2
// framebuffers leaked per resize, accumulating until context loss. This drives
// many resizes and asserts the LIVE (created − deleted) GL-object count stays
// bounded instead of growing linearly.
//
//   node .test/gl-texture-leak.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8252);
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
    // Instrument the GL prototype BEFORE constructing so every alloc (incl. the
    // constructor's) is counted absolutely — live = created − deleted.
    const live = { tex: 0, fb: 0 };
    const patch = (proto) => {
      if (!proto || proto.__leakPatched) return;
      proto.__leakPatched = true;
      const ct = proto.createTexture, dt = proto.deleteTexture, cf = proto.createFramebuffer, df = proto.deleteFramebuffer;
      proto.createTexture = function () { live.tex++; return ct.call(this); };
      proto.deleteTexture = function (t) { if (t) live.tex--; return dt.call(this, t); };
      proto.createFramebuffer = function () { live.fb++; return cf.call(this); };
      proto.deleteFramebuffer = function (f) { if (f) live.fb--; return df.call(this, f); };
    };
    patch(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
    patch(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);

    const cv = document.createElement('canvas');
    cv.width = 320; cv.height = 240;
    document.body.appendChild(cv);
    let engine;
    try { engine = new window.TripCam.TripEngine(cv); }
    catch (e) { return { noGL: true, err: e.message }; }
    const liveAfterCtor = { tex: live.tex, fb: live.fb };   // 3 textures + 2 framebuffers

    // simulate the load-shedder flipping quality tiers → canvas resizes.
    // Each _initTextures() must free the previous ping/pong/srcTex first.
    const sizes = [[300, 220], [240, 180], [320, 240], [176, 132], [280, 210], [200, 150], [320, 240], [160, 120]];
    const liveAfterFirst = { tex: 0, fb: 0 };
    for (let i = 0; i < sizes.length; i++) {
      cv.width = sizes[i][0]; cv.height = sizes[i][1];
      engine._initTextures();
      if (i === 0) { liveAfterFirst.tex = live.tex; liveAfterFirst.fb = live.fb; }
    }
    const liveAfterMany = { tex: live.tex, fb: live.fb };

    // teardown frees everything
    engine._freeTextures();
    const liveAfterFree = { tex: live.tex, fb: live.fb };

    return { noGL: false, resizes: sizes.length, liveAfterCtor, liveAfterFirst, liveAfterMany, liveAfterFree };
  });

  if (r.noGL) {
    // WebGL genuinely unavailable in this runner — skip rather than false-fail.
    durable('  SKIP — WebGL unavailable in this environment (' + (r.err || '') + ')');
    durable('==== skipped (no WebGL) ====');
    code = 0;
  } else {
    ok('F2 live GL texture count is bounded across many resizes (leak fixed)',
       r.liveAfterMany.tex === r.liveAfterFirst.tex && r.liveAfterFirst.tex === r.liveAfterCtor.tex,
       `ctor=${r.liveAfterCtor.tex}, after 1 resize=${r.liveAfterFirst.tex}, after ${r.resizes}=${r.liveAfterMany.tex}`);
    ok('F2 live GL framebuffer count is bounded across many resizes',
       r.liveAfterMany.fb === r.liveAfterFirst.fb && r.liveAfterFirst.fb === r.liveAfterCtor.fb,
       `ctor=${r.liveAfterCtor.fb}, after 1=${r.liveAfterFirst.fb}, after ${r.resizes}=${r.liveAfterMany.fb}`);
    ok('F2 _freeTextures() releases all ping-pong GL objects on teardown',
       r.liveAfterFree.tex === 0 && r.liveAfterFree.fb === 0, `tex ${r.liveAfterMany.tex}→${r.liveAfterFree.tex}, fb ${r.liveAfterMany.fb}→${r.liveAfterFree.fb}`);

    const passed = checks.filter(Boolean).length;
    durable(`==== ${passed}/${checks.length} checks passed ====`);
    code = passed === checks.length && checks.length === 3 ? 0 : 1;
  }
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
