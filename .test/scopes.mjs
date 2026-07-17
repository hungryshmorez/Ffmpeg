// =============================================================================
// scopes.mjs — vectorscope + waveform monitor (#51)
// -----------------------------------------------------------------------------
// The scopes are pure ImageData → ImageData, so they're verified
// DETERMINISTICALLY on hand-built frames — no video, no GPU:
//   • vectorscope: a solid GREY frame plots only at the centre; saturated RED
//     and BLUE plot off-centre in OPPOSITE directions (distinct chroma)
//   • waveform: a black→white horizontal gradient makes the luma trace rise
//     from bottom (left/dark) to top (right/bright); a flat grey frame draws a
//     single mid-height line
//
//   node .test/scopes.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8200);
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
  await page.waitForFunction(() => !!(window.FFScopes && window.FFScopes.vectorscope && window.FFScopes.waveform), { timeout: 60000 });
  durable('[boot] FFScopes present');

  const r = await page.evaluate(async () => {
    const SZ = 128;
    const solid = (w, h, r, g, b) => { const d = new Uint8ClampedArray(w * h * 4); for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; } return new ImageData(d, w, h); };

    // ---- VECTORSCOPE ----
    // centroid of the plotted ink (weighted by green channel above the graticule)
    const centroid = (img) => {
      let sx = 0, sy = 0, s = 0;
      for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
        const i = (y * img.width + x) * 4; const w = img.data[i + 1] > 40 ? img.data[i + 1] : 0;
        sx += x * w; sy += y * w; s += w;
      }
      return s ? { x: sx / s, y: sy / s, s } : { x: -1, y: -1, s: 0 };
    };
    const c = SZ / 2;
    const grey = centroid(window.FFScopes.vectorscope(solid(32, 32, 128, 128, 128), SZ));
    const red = centroid(window.FFScopes.vectorscope(solid(32, 32, 255, 0, 0), SZ));
    const blue = centroid(window.FFScopes.vectorscope(solid(32, 32, 0, 0, 255), SZ));
    const greyCentred = Math.hypot(grey.x - c, grey.y - c) < 3;
    const redOut = Math.hypot(red.x - c, red.y - c) > SZ * 0.15;
    const blueOut = Math.hypot(blue.x - c, blue.y - c) > SZ * 0.15;
    // red and blue chroma must sit in clearly different directions
    const redBlueApart = Math.hypot(red.x - blue.x, red.y - blue.y) > SZ * 0.25;

    // ---- WAVEFORM ----
    // horizontal black→white gradient
    const GW = 64, GH = 32;
    const grad = new Uint8ClampedArray(GW * GH * 4);
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) { const i = (y * GW + x) * 4; const v = Math.round(x / (GW - 1) * 255); grad[i] = grad[i + 1] = grad[i + 2] = v; grad[i + 3] = 255; }
    const wf = window.FFScopes.waveform(new ImageData(grad, GW, GH), SZ, SZ);
    // mean ink-y for a column band (green channel marks the trace)
    // threshold ABOVE the faint IRE graticule (green≈24); the trace is green≈255
    const colY = (xc) => { let sy = 0, s = 0; for (let y = 0; y < SZ; y++) { const i = (y * SZ + xc) * 4; const w = wf.data[i + 1] > 60 ? 1 : 0; sy += y * w; s += w; } return s ? sy / s : -1; };
    const leftY = colY(8), rightY = colY(SZ - 8);
    // left column is dark → trace near the BOTTOM (high y); right is bright → top (low y)
    const wfRises = leftY > rightY + SZ * 0.4;

    // flat grey → a single mid-height line
    const flat = window.FFScopes.waveform(solid(64, 32, 128, 128, 128), SZ, SZ);
    let midBand = 0, offBand = 0;
    for (let y = 0; y < SZ; y++) for (let x = 0; x < SZ; x++) { const i = (y * SZ + x) * 4; if (flat.data[i + 1] > 60) { if (Math.abs(y - SZ / 2) < SZ * 0.08) midBand++; else offBand++; } }
    const flatMid = midBand > offBand;

    return { greyCentred, redOut, blueOut, redBlueApart, wfRises, flatMid, dbg: { grey, red, blue, leftY, rightY, midBand, offBand } };
  });

  ok('#51 vectorscope: grey plots at the centre', r.greyCentred, `grey=(${r.dbg.grey.x|0},${r.dbg.grey.y|0})`);
  ok('#51 vectorscope: saturated red + blue push off-centre', r.redOut && r.blueOut);
  ok('#51 vectorscope: red and blue land in different directions', r.redBlueApart);
  ok('#51 waveform: dark→bright gradient makes the trace rise', r.wfRises, `left y=${r.dbg.leftY|0} right y=${r.dbg.rightY|0}`);
  ok('#51 waveform: flat grey draws a single mid-height line', r.flatMid, `mid=${r.dbg.midBand} off=${r.dbg.offBand}`);

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
