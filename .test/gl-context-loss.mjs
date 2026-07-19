// =============================================================================
// gl-context-loss.mjs — F3: WebGL context-loss recovery
// -----------------------------------------------------------------------------
// A GPU reset / OS sleep / eviction fires `webglcontextlost` and invalidates
// every GL object. Before the fix nothing listened: the draw loop kept issuing
// dead GL calls and the canvas was bricked until a full reload. This drives a
// REAL context loss + restore via the WEBGL_lose_context extension and asserts:
//   • on loss the engine halts (flag set, rAF stopped) and render() is a safe
//     no-op that doesn't throw
//   • on restore the engine rebuilds its programs/textures and renders again
//
//   node .test/gl-context-loss.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8253);
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
    const cv = document.createElement('canvas'); cv.width = 320; cv.height = 240;
    document.body.appendChild(cv);
    let engine;
    try { engine = new window.TripCam.TripEngine(cv); }
    catch (e) { return { noGL: true, err: e.message }; }

    const ext = engine.gl.getExtension('WEBGL_lose_context');
    if (!ext) return { noExt: true };

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const listeners = { lost: 0, restored: 0 };
    cv.addEventListener('webglcontextlost', () => listeners.lost++);
    cv.addEventListener('webglcontextrestored', () => listeners.restored++);

    engine.start();
    const rafBefore = engine.raf;
    const progsBefore = Object.keys(engine.programs).length;

    // --- trigger a real context loss ---
    ext.loseContext();
    await wait(50);
    const lostFlag = engine._contextLost === true;
    const rafStopped = engine.raf === 0;
    // render() must be a safe no-op while lost
    let threwWhileLost = false;
    try { engine.render(); } catch (_) { threwWhileLost = true; }

    // --- restore ---
    engine.srcTex = null;                         // clear so we can prove _initTextures re-ran
    ext.restoreContext();
    // the browser fires webglcontextrestored asynchronously; give it time
    for (let i = 0; i < 60 && engine._contextLost; i++) await wait(50);
    const restoredFlag = engine._contextLost === false;
    const texturesRebuilt = !!engine.srcTex;      // _initTextures ran during restore
    const loopResumed = engine.raf !== 0;         // start() ran during restore
    const progsAfter = Object.keys(engine.programs).length;
    let threwAfterRestore = false;
    try { engine.render(); } catch (_) { threwAfterRestore = true; }
    engine.stop();

    return {
      noGL: false, noExt: false,
      progsBefore, rafRan: rafBefore !== 0,
      lostEvents: listeners.lost, restoredEvents: listeners.restored,
      lostFlag, rafStopped, threwWhileLost,
      restoredFlag, texturesRebuilt, loopResumed, progsAfter, threwAfterRestore,
    };
  });

  if (r.noGL) { durable('  SKIP — WebGL unavailable (' + (r.err || '') + ')'); durable('==== skipped ===='); code = 0; }
  else if (r.noExt) { durable('  SKIP — WEBGL_lose_context extension unavailable'); durable('==== skipped ===='); code = 0; }
  else {
    ok('F3 on context loss the engine halts (flag set, rAF stopped) and does not brick',
       r.lostEvents >= 1 && r.lostFlag && r.rafStopped, `lostEvents=${r.lostEvents} flag=${r.lostFlag} raf=${r.rafStopped}`);
    ok('F3 render() is a safe no-op while the context is lost (no throw)', !r.threwWhileLost);
    // NB: swiftshader (headless) may not compile these shaders, so program
    // count is env-dependent and not asserted; the recovery LIFECYCLE is.
    ok('F3 on restore the engine rebuilds its textures, resumes the loop, and renders without throwing',
       r.restoredEvents >= 1 && r.restoredFlag && r.texturesRebuilt && r.loopResumed && !r.threwAfterRestore,
       `restoredEvents=${r.restoredEvents} texturesRebuilt=${r.texturesRebuilt} loopResumed=${r.loopResumed} progs=${r.progsAfter} threw=${r.threwAfterRestore}`);

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
