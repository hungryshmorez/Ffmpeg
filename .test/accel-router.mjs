// =============================================================================
// accel-router.mjs — Unified graceful-fallback layer (Phase 4.2)
// -----------------------------------------------------------------------------
// The router guarantees an accelerated path can never take a workflow down.
// Verified by injecting capability states (the absent-hardware case is real
// here — WebGPU is genuinely unavailable in headless; the isolated COOP/COEP
// app context does expose WebCodecs + OPFS):
//   • detect() reports this environment's real capabilities accurately and
//     folds in FFHardware.CAPS
//   • when the needed capability is ABSENT, route() runs the fallback and
//     returns its result (path=fallback)
//   • when it's present and the accelerated path works, route() uses it
//   • when it's present but the accelerated path THROWS, route() SILENTLY falls
//     back and still returns the correct result (path=fallback-after-error)
//   • mode 'wasm' forces the fallback even when capable; a missing fallback is
//     rejected (fallback is mandatory)
//
//   node .test/accel-router.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8265);
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
  await page.waitForFunction(() => !!(window.FFAccel && window.FFAccel.route), { timeout: 60000 });
  durable('[boot] FFAccel present');

  const r = await page.evaluate(async () => {
    const A = window.FFAccel;

    // real detection in THIS environment. WebGPU is genuinely absent here; the
    // isolated (COOP/COEP) app context DOES expose WebCodecs + OPFS. Assert the
    // report is accurate + coherent rather than hardcoding a value.
    A._setCapsForTest(null);
    const real = await A.detect();
    const detectAccurate = real.webgpu === false
      && typeof real.webcodecs === 'boolean'
      && typeof real.opfs === 'boolean'
      && real.webgl2 === true;

    // --- capability ABSENT → fallback runs, returns its result ---
    A._setCapsForTest({ webgpu: false, webcodecs: false, opfs: false, webgl2: true });
    A.setMode('auto');
    let accelRan = false;
    const r1 = await A.route({ name: 't1', need: 'webgpu',
      accelerated: async () => { accelRan = true; return 'ACCEL'; },
      fallback: async () => 'FALLBACK' });
    const absentUsesFallback = r1 === 'FALLBACK' && !accelRan && A.lastPath('t1') === 'fallback';

    // --- capability PRESENT + accel works → accel used ---
    A._setCapsForTest({ webgpu: true, webcodecs: true, opfs: true, webgl2: true });
    A.setMode('auto');
    const r2 = await A.route({ name: 't2', need: 'webgpu',
      accelerated: async () => 'ACCEL', fallback: async () => 'FALLBACK' });
    const presentUsesAccel = r2 === 'ACCEL' && A.lastPath('t2') === 'accel';

    // --- capability PRESENT but accel THROWS → SILENT fallback, correct result ---
    let fbRan = false;
    const r3 = await A.route({ name: 't3', need: 'webgpu',
      accelerated: async () => { throw new Error('GPU device lost'); },
      fallback: async () => { fbRan = true; return 'FALLBACK'; } });
    const errorFallsBack = r3 === 'FALLBACK' && fbRan && A.lastPath('t3') === 'fallback-after-error';

    // --- mode 'wasm' forces fallback even when capable ---
    A.setMode('wasm');
    let accel2 = false;
    const r4 = await A.route({ name: 't4', need: 'webgpu',
      accelerated: async () => { accel2 = true; return 'ACCEL'; },
      fallback: async () => 'FALLBACK' });
    const wasmForces = r4 === 'FALLBACK' && !accel2 && A.lastPath('t4') === 'fallback';
    A.setMode('auto');

    // --- a missing fallback is rejected (fallback is mandatory) ---
    let threw = false;
    try { await A.route({ name: 't5', need: 'webgpu', accelerated: async () => 'x' }); } catch (_) { threw = true; }

    // --- a predicate `need` works too ---
    A._setCapsForTest({ webgpu: false, webcodecs: true, opfs: false, webgl2: true });
    const r6 = await A.route({ name: 't6', need: (c) => c.webcodecs && !c.webgpu,
      accelerated: async () => 'ACCEL', fallback: async () => 'FALLBACK' });
    const predicateWorks = r6 === 'ACCEL';

    A._setCapsForTest(null);
    return { detectAccurate, real, absentUsesFallback, presentUsesAccel, errorFallsBack, wasmForces, missingFallbackRejected: threw, predicateWorks };
  });

  ok('detect() reports this environment accurately (webgpu absent; webcodecs/opfs per isolation; webgl2 present)', r.detectAccurate, JSON.stringify(r.real));
  ok('an ABSENT capability routes to the fallback (returns its result)', r.absentUsesFallback);
  ok('a PRESENT capability with a working accel path uses acceleration', r.presentUsesAccel);
  ok('a hardware path that THROWS silently falls back and still returns correctly', r.errorFallsBack);
  ok('mode "wasm" forces the fallback even when capable; a missing fallback is rejected', r.wasmForces && r.missingFallbackRejected);
  ok('a predicate capability requirement is honoured', r.predicateWorks);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 6 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
