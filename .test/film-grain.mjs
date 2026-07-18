// =============================================================================
// film-grain.mjs — real film grain, plate-based (#47)
// -----------------------------------------------------------------------------
// The point of a grain PLATE (vs per-pixel procedural noise) is spatial
// CLUMPING — real grain has structure. Verified DETERMINISTICALLY on a flat grey
// frame:
//   • grain adds texture: the frame's variance rises from ~0
//   • the mean is essentially preserved (grain is zero-mean)
//   • the grain is CLUMPY: lag-1 spatial autocorrelation of the added layer is
//     clearly positive — a white-noise field would sit near 0. This is the test
//     that it's a plate, not hiss.
//   • intensity scales the variance
//
//   node .test/film-grain.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8208);
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
  await page.waitForFunction(() => !!(window.FFShaderPlus && window.FFShaderPlus.FilmGrain && window.FFShaderPlus.filmGrain), { timeout: 60000 });
  durable('[boot] FFShaderPlus.FilmGrain present');

  const r = await page.evaluate(async () => {
    const W = 128, H = 128;
    const flat = () => { const d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 128; d[i + 3] = 255; } return new ImageData(d, W, H); };
    const mean = (img) => { let s = 0; for (let i = 0; i < img.data.length; i += 4) s += img.data[i]; return s / (W * H); };
    const variance = (img) => { const m = mean(img); let s = 0; for (let i = 0; i < img.data.length; i += 4) s += (img.data[i] - m) ** 2; return s / (W * H); };
    // lag-1 horizontal autocorrelation of the grain LAYER (out - 128)
    const autocorr = (img) => {
      let s0 = 0, s1 = 0, n = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W - 1; x++) {
        const a = img.data[(y * W + x) * 4] - 128, b = img.data[(y * W + x + 1) * 4] - 128;
        s1 += a * b; s0 += a * a; n++;
      }
      return s0 > 0 ? s1 / s0 : 0;
    };

    const g1 = flat(); window.FFShaderPlus.filmGrain(g1, { intensity: 0.18, size: 2, seed: 7 });
    const g2 = flat(); window.FFShaderPlus.filmGrain(g2, { intensity: 0.36, size: 2, seed: 7 });

    // a WHITE-noise reference for the autocorrelation contrast
    const whiteAC = (() => {
      const d = new Uint8ClampedArray(W * H * 4); let s = 12345;
      for (let i = 0; i < d.length; i += 4) { s = (s * 1664525 + 1013904223) >>> 0; const v = 128 + (s / 4294967296 - 0.5) * 60; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
      return autocorr(new ImageData(d, W, H));
    })();

    return {
      var0: variance(flat()), var1: variance(g1), var2: variance(g2),
      meanShift: Math.abs(mean(g1) - 128),
      grainAC: autocorr(g1), whiteAC,
    };
  });

  ok('#47 grain adds texture (variance rises from ~0)', r.var1 > 20, `var ${r.var0.toFixed(2)}→${r.var1.toFixed(2)}`);
  ok('#47 the mean is preserved (grain is zero-mean)', r.meanShift < 4, `Δmean=${r.meanShift.toFixed(2)}`);
  ok('#47 the grain is CLUMPY (plate, not white noise)', r.grainAC > 0.3 && r.grainAC > r.whiteAC + 0.25, `grainAC=${r.grainAC.toFixed(2)} vs whiteAC=${r.whiteAC.toFixed(2)}`);
  ok('#47 intensity scales the grain', r.var2 > r.var1 * 1.8, `${r.var1.toFixed(1)}→${r.var2.toFixed(1)}`);

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
