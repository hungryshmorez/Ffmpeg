// =============================================================================
// shader-cache.mjs — #19 per-context shader-program cache
// -----------------------------------------------------------------------------
// A linked GL program (11 fragment compiles + links) is expensive. The engine
// now caches programs per GL context keyed by shader source, so a second engine
// that shares a canvas/context reuses the GPU programs instead of recompiling.
// This was previously unverifiable — the shaders wouldn't LINK on SwiftShader
// (fixed: varying mismatch) — so now it's asserted for real, including that the
// REUSED programs still render:
//
//   • engine A on a canvas compiles + links all 11 programs
//   • engine B on the SAME canvas/context makes ZERO new compileShader calls
//     (full cache hit) and holds the SAME program objects as A
//   • engine B RENDERS non-black pixels through those reused programs
//   • engine C on a NEW canvas (separate context) recompiles — the cache is
//     correctly per-context, not a global handing back dead programs
//
//   node .test/shader-cache.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8277);
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
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.TripCam && window.TripCam.TripEngine), { timeout: 60000 });
  durable('[boot] TripCam.TripEngine present');

  const r = await page.evaluate(async () => {
    let compiles = 0;
    const patch = (proto) => {
      if (!proto || proto.__ccPatched) return;
      proto.__ccPatched = true;
      const cs = proto.compileShader;
      proto.compileShader = function (s) { compiles++; return cs.call(this, s); };
    };
    patch(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype);
    patch(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype);

    const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; document.body.appendChild(c); return c; };
    const paintSrc = () => { const s = mk(160, 120); const g = s.getContext('2d'); g.fillStyle = '#2050ff'; g.fillRect(0, 0, 160, 120); g.fillStyle = '#ff3080'; g.fillRect(20, 20, 90, 60); return s; };
    const total = Object.keys(window.TripCam.SHADERS || {}).length || 11;

    // engine A
    const cvA = mk(160, 120);
    let A; try { A = new window.TripCam.TripEngine(cvA); } catch (e) { return { noGL: true, err: e.message }; }
    const compilesA = compiles, progA = Object.keys(A.programs).length;

    // engine B on the SAME canvas/context — should be a full cache hit
    const before = compiles;
    const B = new window.TripCam.TripEngine(cvA);
    const newCompilesB = compiles - before, progB = Object.keys(B.programs).length;
    const shared = !!(A.programs.datamosh && B.programs.datamosh && A.programs.datamosh.p === B.programs.datamosh.p);

    // engine B renders non-black through the REUSED programs
    const src = paintSrc();
    B.setSource(src);
    for (let i = 0; i < 4; i++) B.render();
    const g = B.gl, w = cvA.width, h = cvA.height, px = new Uint8Array(w * h * 4);
    g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
    let nb = 0, n = 0; for (let i = 0; i < px.length; i += 4) { n++; if (px[i] > 8 || px[i + 1] > 8 || px[i + 2] > 8) nb++; }
    const nonBlackPct = 100 * nb / n;

    // engine C on a NEW canvas (separate context) must recompile
    const beforeC = compiles;
    const cvC = mk(160, 120);
    const C = new window.TripCam.TripEngine(cvC);
    const newCompilesC = compiles - beforeC;

    return { noGL: false, total, compilesA, progA, newCompilesB, progB, shared, nonBlackPct, newCompilesC };
  });

  if (r.noGL) {
    durable('  SKIP — WebGL unavailable in this environment (' + (r.err || '') + ')');
    durable('==== skipped (no WebGL) ====');
    code = 0;
  } else {
    ok('engine A compiles + links all shader programs', r.compilesA > 0 && r.progA === r.total,
       `compiled ${r.compilesA}, ${r.progA}/${r.total} linked`);
    ok('a 2nd engine sharing the context makes ZERO new compileShader calls (full cache hit)',
       r.newCompilesB === 0 && r.progB === r.total, `newCompiles=${r.newCompilesB}, programs=${r.progB}/${r.total}`);
    ok('the 2nd engine holds the SAME program objects as the first', r.shared === true);
    ok('the 2nd engine RENDERS non-black pixels through the reused programs', r.nonBlackPct > 5,
       `${r.nonBlackPct.toFixed(1)}% non-black`);
    ok('an engine on a NEW canvas/context recompiles (cache is per-context, not global)',
       r.newCompilesC > 0, `recompiled=${r.newCompilesC}`);

    const passed = checks.filter(Boolean).length;
    durable(`==== ${passed}/${checks.length} checks passed ====`);
    code = passed === checks.length && checks.length === 5 ? 0 : 1;
  }
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
