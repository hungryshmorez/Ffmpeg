// =============================================================================
// crossfade-curves.mjs — crossfader curve selection (#74)
// -----------------------------------------------------------------------------
// The three DJ/VJ crossfader laws, verified DETERMINISTICALLY by their defining
// properties, plus that Compositor.crossfade drives the two layers' opacity:
//   • LINEAR keeps gainA + gainB = 1 (a dip in perceived level at the middle)
//   • CONSTANT-POWER keeps gainA² + gainB² = 1 — both ≈0.707 at the midpoint, no
//     level dip
//   • SHARP is an S-curve: it lingers at the ends (gainB(0.25) < 0.25) and snaps
//     through the middle (gainB(0.75) > 0.75)
//   • comp.crossfade(0,1,0.5,'power') sets both layer opacities to ≈0.707
//
//   node .test/crossfade-curves.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8217);
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
  await page.waitForFunction(() => !!(window.FFPerf && window.FFPerf.CROSSFADE_CURVES && window.FFPerf.Compositor), { timeout: 60000 });
  durable('[boot] FFPerf.CROSSFADE_CURVES + Compositor present');

  const r = await page.evaluate(async () => {
    const C = window.FFPerf.CROSSFADE_CURVES;
    const xs = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
    // linear: gainA + gainB = 1 everywhere; midpoint both 0.5
    let linSum = true; for (const x of xs) { const [a, b] = C.linear(x); if (Math.abs(a + b - 1) > 1e-9) linSum = false; }
    const linMid = C.linear(0.5);
    // constant-power: gainA² + gainB² = 1; midpoint both ≈0.707
    let powSq = true; for (const x of xs) { const [a, b] = C.power(x); if (Math.abs(a * a + b * b - 1) > 1e-9) powSq = false; }
    const powMid = C.power(0.5);
    // sharp S-curve: lingers at ends, snaps in the middle
    const s25 = C.sharp(0.25)[1], s75 = C.sharp(0.75)[1];
    const sharpS = s25 < 0.25 - 0.02 && s75 > 0.75 + 0.02 && Math.abs(C.sharp(0.5)[1] - 0.5) < 1e-9;

    // Compositor.crossfade drives layer opacity with the chosen curve
    const cv = document.createElement('canvas'); cv.width = 32; cv.height = 32;
    const comp = new window.FFPerf.Compositor(cv, 4);
    comp.crossfade(0, 1, 0.5, 'power');
    const drivesLayers = Math.abs(comp.layers[0].opacity - 0.7071) < 0.01 && Math.abs(comp.layers[1].opacity - 0.7071) < 0.01;

    return {
      linSum, linMidOk: Math.abs(linMid[0] - 0.5) < 1e-9 && Math.abs(linMid[1] - 0.5) < 1e-9,
      powSq, powMidOk: Math.abs(powMid[0] - 0.7071) < 0.001 && Math.abs(powMid[1] - 0.7071) < 0.001,
      sharpS, drivesLayers,
      dbg: { powMid: powMid.map((v) => +v.toFixed(3)), s25: +s25.toFixed(3), s75: +s75.toFixed(3), op: [+comp.layers[0].opacity.toFixed(3), +comp.layers[1].opacity.toFixed(3)] },
    };
  });

  ok('#74 linear keeps gainA + gainB = 1 (level dip at mid)', r.linSum && r.linMidOk);
  ok('#74 constant-power keeps gainA² + gainB² = 1 (no dip)', r.powSq && r.powMidOk, `mid=${r.dbg.powMid}`);
  ok('#74 sharp is an S-curve (lingers at ends, snaps in the middle)', r.sharpS, `b(.25)=${r.dbg.s25} b(.75)=${r.dbg.s75}`);
  ok('#74 Compositor.crossfade drives the layers with the curve', r.drivesLayers, `opacity=${r.dbg.op}`);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 4 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
