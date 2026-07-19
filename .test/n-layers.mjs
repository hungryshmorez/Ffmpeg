// =============================================================================
// n-layers.mjs — N-layer compositor support (#72)
// -----------------------------------------------------------------------------
// The engine takes any layer count; this drives it from the UI. Verified in the
// REAL app: grow the deck past the old 4-layer limit and composite on the new
// top layer.
//   • setLayerCount(6) → the compositor has 6 layers and the deck shows 6 strips
//   • a clip loaded into LAYER 5 (the 6th, beyond the old max) decodes and, screen-
//     blended over a red base, makes the centre pixel YELLOW — layers beyond 4 are
//     real and composite (frames, not bytes)
//   • clamping: setLayerCount(99) caps at 8, setLayerCount(1) floors at 2
//
//   node .test/n-layers.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8218);
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
const near = (v, t, tol = 60) => Math.abs(v - t) <= tol;

try {
  if (!USE_EXTERNAL) { server = await startServer(); console.log(`[server] listening on ${BASE}`); }
  browser = await chromium.launch({ executablePath: process.env.PW_EXEC || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.engineReady === true, { timeout: 120000 });
  await page.evaluate(() => document.querySelector('[data-tab="vj"]')?.click());
  await page.waitForFunction(() => !!(window.FFComp && window.FFComp.compositor), { timeout: 15000 });
  durable('[boot] compositor panel built');

  const r = await page.evaluate(async () => {
    function makeClip(color, ms = 1400) {
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180;
      const ctx = cv.getContext('2d');
      const stream = cv.captureStream(20);
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      const rec = new MediaRecorder(stream, { mimeType: mime });
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      return new Promise((res) => {
        rec.onstop = () => res(new Blob(chunks, { type: 'video/webm' }));
        rec.start();
        const t0 = performance.now();
        const draw = () => { ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 180); if (performance.now() - t0 < ms) requestAnimationFrame(draw); else rec.stop(); };
        draw();
      });
    }

    // grow to 6 layers
    window.FFComp.setLayerCount(6);
    const c = window.FFComp.compositor;
    const strips = document.querySelectorAll('#comp-layers .comp-layer').length;
    const grewTo6 = c.layers.length === 6 && window.FFComp.layerCount === 6 && strips === 6;

    // load red → layer 0, green → layer 5 (the new top layer, beyond old max 4)
    const red = await makeClip('#ff0000'), green = await makeClip('#00ff00');
    await window.FFComp.loadInto(0, new File([red], 'red.webm', { type: 'video/webm' }), 'RED');
    await window.FFComp.loadInto(5, new File([green], 'green.webm', { type: 'video/webm' }), 'GREEN');
    const ready = () => c.layers[0].video?.readyState >= 2 && c.layers[5].video?.readyState >= 2;
    for (let i = 0; i < 60 && !ready(); i++) await new Promise((r) => setTimeout(r, 100));

    c.layers[0].opacity = 1; c.layers[0].blendMode = 'normal';
    c.layers[5].opacity = 1; c.layers[5].blendMode = 'screen';
    // make sure both clips have actually painted a frame before we composite
    c.layers[0].video.play?.().catch(() => {}); c.layers[5].video.play?.().catch(() => {});
    const w = c.cv.width, h = c.cv.height;
    let px = [0, 0, 0];
    for (let i = 0; i < 30; i++) { c.draw(); px = Array.from(c.ctx.getImageData((w / 2) | 0, (h / 2) | 0, 1, 1).data); if (px[1] > 180) break; await new Promise((r) => setTimeout(r, 80)); }

    // clamping
    window.FFComp.setLayerCount(99); const capped = window.FFComp.layerCount;
    window.FFComp.setLayerCount(1); const floored = window.FFComp.layerCount;

    return { grewTo6, ready: ready(), px, capped, floored };
  });

  ok('#72 setLayerCount(6) gives 6 layers + 6 strips', r.grewTo6);
  ok('#72 layer 5 (beyond old max) decodes and composites', r.ready, `readyState ok=${r.ready}`);
  ok('#72 screen-blend on the 6th layer → yellow centre', near(r.px[0], 255) && near(r.px[1], 255) && r.px[2] < 90, `rgb(${r.px.slice(0, 3)})`);
  ok('#72 layer count clamps to [2,8]', r.capped === 8 && r.floored === 2, `cap=${r.capped} floor=${r.floored}`);

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
