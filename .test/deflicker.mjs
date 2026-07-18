// =============================================================================
// deflicker.mjs — timelapse deflicker (#50)
// -----------------------------------------------------------------------------
// Deflicker tracks a SMOOTHED running mean of frame brightness and scales each
// frame onto it. Verified DETERMINISTICALLY on synthetic frame sequences:
//   • a FLICKERING sequence (flat grey, mean oscillating 128 ± 40) comes out
//     with its frame-to-frame brightness variance collapsed
//   • the SLOW trend is preserved: a gentle brightness ramp (day→night) is not
//     flattened — the last frame stays brighter than the first
//   • a steady sequence is left essentially unchanged
//
//   node .test/deflicker.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8220);
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
  await page.waitForFunction(() => !!(window.FFShaderPlus && window.FFShaderPlus.Deflicker), { timeout: 60000 });
  durable('[boot] FFShaderPlus.Deflicker present');

  const r = await page.evaluate(async () => {
    const W = 48, H = 48;
    const flat = (val) => { const d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = val; d[i + 3] = 255; } return new ImageData(d, W, H); };
    const mean = (img) => { let s = 0; for (let i = 0; i < img.data.length; i += 4) s += img.data[i]; return s / (W * H); };
    const variance = (arr) => { const m = arr.reduce((a, b) => a + b, 0) / arr.length; return arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length; };

    // FLICKER: mean oscillates 128 ± 40
    const flickerVals = []; for (let i = 0; i < 40; i++) flickerVals.push(128 + 40 * Math.sin(i * 1.7));
    const inFlick = flickerVals.slice();
    const df = new window.FFShaderPlus.Deflicker({ smooth: 0.08, strength: 1 });
    const outFlick = flickerVals.map((val) => { const f = flat(val); df.process(f); return mean(f); });
    // ignore the first few frames (running mean warming up)
    const varIn = variance(inFlick.slice(5)), varOut = variance(outFlick.slice(5));
    const flickerKilled = varOut < varIn * 0.25;

    // SLOW TREND: a ramp 80→180, deflicker must NOT flatten it
    const rampVals = []; for (let i = 0; i < 40; i++) rampVals.push(80 + i * 2.5);
    const df2 = new window.FFShaderPlus.Deflicker({ smooth: 0.15, strength: 1 });
    const outRamp = rampVals.map((val) => { const f = flat(val); df2.process(f); return mean(f); });
    const trendKept = (outRamp[38] - outRamp[6]) > 40;

    // STEADY: unchanged
    const df3 = new window.FFShaderPlus.Deflicker({ smooth: 0.1, strength: 1 });
    let maxDelta = 0; for (let i = 0; i < 30; i++) { const f = flat(120); df3.process(f); maxDelta = Math.max(maxDelta, Math.abs(mean(f) - 120)); }
    const steadyOk = maxDelta < 2;

    return { flickerKilled, trendKept, steadyOk, dbg: { varIn: +varIn.toFixed(0), varOut: +varOut.toFixed(0), rampDelta: +(outRamp[38] - outRamp[6]).toFixed(0) } };
  });

  ok('#50 flicker is cancelled (frame brightness variance collapses)', r.flickerKilled, `var ${r.dbg.varIn}→${r.dbg.varOut}`);
  ok('#50 the slow trend (day→night) is preserved', r.trendKept, `ramp Δ=${r.dbg.rampDelta}`);
  ok('#50 a steady sequence is left unchanged', r.steadyOk);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 3 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
