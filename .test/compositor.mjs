// =============================================================================
// compositor.mjs — the Layer Compositor test that can't lie
// -----------------------------------------------------------------------------
// The compositor stacks DECODED video frames on a 2D canvas with blend modes,
// opacity, solo/mute and crossfade. This boots the REAL app, opens the VJ tab
// so compositor-ui builds, feeds two solid-colour clips (RED, GREEN) into two
// layers through the real UI hook, then reads the COMPOSITED PIXELS back and
// asserts the blend math actually happened:
//
//   • screen(red, green)      → the centre pixel goes YELLOW  (both channels lit)
//   • solo layer 2            → the centre pixel goes GREEN    (red hidden)
//   • mute layer 2            → the centre pixel goes RED       (green hidden)
//   • layer-2 opacity → 0     → the centre pixel goes RED       (green faded out)
//   • crossfade A→B           → red gives way to green
//
// Pixels, not bytes. A dead compositor leaves the canvas black and every one of
// these assertions fails.
//
//   node .test/compositor.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8143);
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
  return new Promise((resolve, reject) => {
    srv.on('error', reject);
    srv.listen(PORT, () => resolve(srv));
  });
}

let server, browser, code = 1;
const checks = [];
const ok = (name, pass, detail) => {
  checks.push(pass);
  durable(`  ${pass ? 'PASS' : 'FAIL'} — ${name}${detail ? ` (${detail})` : ''}`);
};

try {
  if (!USE_EXTERNAL) { server = await startServer(); console.log(`[server] listening on ${BASE}`); }
  else console.log(`[server] using external ${BASE}`);

  browser = await chromium.launch({ executablePath: process.env.PW_EXEC || undefined, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  page.on('dialog', (d) => d.accept().catch(() => {}));

  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.engineReady === true, { timeout: 120000 });
  durable('[boot] engine ready');

  // Open the VJ tab so vj-mode builds the deck and compositor-ui appends its panel.
  await page.evaluate(() => document.querySelector('[data-tab="vj"]')?.click());
  await page.waitForFunction(() => !!(window.FFComp && window.FFComp.compositor), { timeout: 15000 });
  durable('[boot] compositor panel built');

  // Feed two solid-colour clips straight into layers 0 and 1 via the real hook.
  const setup = await page.evaluate(async () => {
    // A short solid-colour webm the headless browser can decode (VP8/VP9).
    function makeClip(color, ms = 1400) {
      const cv = document.createElement('canvas'); cv.width = 320; cv.height = 180;
      const ctx = cv.getContext('2d');
      const stream = cv.captureStream(20);
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9' : 'video/webm';
      const rec = new MediaRecorder(stream, { mimeType: mime });
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      return new Promise((res) => {
        rec.onstop = () => res(new Blob(chunks, { type: 'video/webm' }));
        rec.start();
        const t0 = performance.now();
        const draw = () => {
          ctx.fillStyle = color; ctx.fillRect(0, 0, 320, 180);
          if (performance.now() - t0 < ms) requestAnimationFrame(draw); else rec.stop();
        };
        draw();
      });
    }
    const red = await makeClip('#ff0000');
    const green = await makeClip('#00ff00');
    await window.FFComp.loadInto(0, new File([red], 'red.webm', { type: 'video/webm' }), 'RED');
    await window.FFComp.loadInto(1, new File([green], 'green.webm', { type: 'video/webm' }), 'GREEN');
    const c = window.FFComp.compositor;
    // wait until both videos are actually decoding frames
    const ready = () => c.layers[0].video?.readyState >= 2 && c.layers[1].video?.readyState >= 2;
    for (let i = 0; i < 60 && !ready(); i++) await new Promise((r) => setTimeout(r, 100));
    return { ready: ready(), r0: c.layers[0].video?.readyState, r1: c.layers[1].video?.readyState };
  });
  ok('both clips decoding', setup.ready, `readyState ${setup.r0}/${setup.r1}`);

  // Read the centre composited pixel after N animation frames settle.
  const readCentre = () => page.evaluate(async () => {
    const c = window.FFComp.compositor;
    for (let i = 0; i < 8; i++) await new Promise((r) => requestAnimationFrame(r));
    const w = c.cv.width, h = c.cv.height;
    const d = c.ctx.getImageData((w / 2) | 0, (h / 2) | 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  });

  const near = (v, t, tol = 60) => Math.abs(v - t) <= tol;

  // 1) SCREEN blend of red over green → yellow (R high, G high, B low).
  await page.evaluate(() => {
    const c = window.FFComp.compositor;
    c.layers[0].opacity = 1; c.layers[0].blendMode = 'normal'; c.layers[0].solo = c.layers[0].mute = false;
    c.layers[1].opacity = 1; c.layers[1].blendMode = 'screen'; c.layers[1].solo = c.layers[1].mute = false;
    c.masterOpacity = 1;
  });
  let px = await readCentre();
  ok('screen blend → yellow', near(px[0], 255) && near(px[1], 255) && px[2] < 90, `rgb(${px})`);

  // 2) Solo layer 1 (green) → green only.
  await page.evaluate(() => { window.FFComp.compositor.layers[1].solo = true; });
  px = await readCentre();
  ok('solo L2 → green', px[0] < 90 && near(px[1], 255) && px[2] < 90, `rgb(${px})`);

  // 3) Clear solo, mute layer 1 → red only shows.
  await page.evaluate(() => {
    const c = window.FFComp.compositor;
    c.layers[1].solo = false; c.layers[1].mute = true;
  });
  px = await readCentre();
  ok('mute L2 → red', near(px[0], 255) && px[1] < 90 && px[2] < 90, `rgb(${px})`);

  // 4) Unmute, drop layer-1 opacity to 0 → red only (faded out, blend irrelevant).
  await page.evaluate(() => {
    const c = window.FFComp.compositor;
    c.layers[1].mute = false; c.layers[1].opacity = 0;
  });
  px = await readCentre();
  ok('L2 opacity 0 → red', near(px[0], 255) && px[1] < 90 && px[2] < 90, `rgb(${px})`);

  // 5) Crossfade A(0)→B(1) with normal blend: x=0 is red, x=1 is green.
  await page.evaluate(() => {
    const c = window.FFComp.compositor;
    c.layers[1].blendMode = 'normal';
    c.crossfade(0, 1, 0);   // full A (red)
  });
  const pxA = await readCentre();
  await page.evaluate(() => window.FFComp.compositor.crossfade(0, 1, 1)); // full B (green)
  const pxB = await readCentre();
  ok('crossfade red→green',
    near(pxA[0], 255) && pxA[1] < 90 && pxB[0] < 90 && near(pxB[1], 255),
    `A rgb(${pxA}) → B rgb(${pxB})`);

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
