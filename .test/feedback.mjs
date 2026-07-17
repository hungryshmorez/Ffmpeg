// =============================================================================
// feedback.mjs — feedback with geometric transforms (#67), the infinite tunnel
// -----------------------------------------------------------------------------
// The tunnel keeps a persistent buffer, re-draws it ZOOMED+ROTATED and faded by
// `decay` each frame, then adds the new frame. It's pure canvas math, so it's
// verified DETERMINISTICALLY on ImageData — no MediaRecorder, no video decode:
//   • ZOOM>1 spreads a central detail OUTWARD: an outer ring lights up over time
//   • DECAY fades the buffer when no new frame is fed (energy drops each step)
//   • ROTATE changes where the trail lands (rotate≠0 ≠ rotate=0)
//
//   node .test/feedback.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8197);
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
  await page.waitForFunction(() => !!(window.FFShaderPlus && window.FFShaderPlus.FeedbackTunnel), { timeout: 60000 });
  durable('[boot] FFShaderPlus.FeedbackTunnel present');

  const r = await page.evaluate(async () => {
    const W = 64, H = 64;
    // A small bright square drawn at the centre of a fresh black frame.
    function dot(cx, cy, s) {
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const g = c.getContext('2d');
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
      g.fillStyle = '#fff'; g.fillRect(cx - s, cy - s, s * 2, s * 2);
      return c;
    }
    const black = (() => { const c = document.createElement('canvas'); c.width = W; c.height = H; c.getContext('2d').fillRect(0, 0, W, H); return c; })();
    const lum = (d, x, y) => { const i = (y * W + x) * 4; return (d[i] + d[i + 1] + d[i + 2]) / 3; };
    // mean brightness on a ring of radius ~R around the centre
    const ring = (img, R) => {
      let s = 0, n = 0;
      for (let a = 0; a < 360; a += 10) { const x = Math.round(W / 2 + R * Math.cos(a * Math.PI / 180)), y = Math.round(H / 2 + R * Math.sin(a * Math.PI / 180)); if (x >= 0 && x < W && y >= 0 && y < H) { s += lum(img.data, x, y); n++; } }
      return n ? s / n : 0;
    };
    const total = (img) => { let s = 0; for (let i = 0; i < img.data.length; i += 4) s += img.data[i]; return s; };

    // ZOOM>1 spreads the centre square outward. Feed the square ONCE, then feed
    // black under 'lighter' (black adds nothing) so only the zooming buffer acts.
    const T = new window.FFShaderPlus.FeedbackTunnel(W, H, { zoom: 1.12, rotate: 0, decay: 0.97, mix: 1, blend: 'lighter' });
    T.push(dot(W / 2, H / 2, 4));                 // seed: 8x8 square at centre
    const ring0 = ring(T.read(), 20);             // outer ring is dark now
    for (let i = 0; i < 14; i++) T.push(black);   // let it zoom outward
    const ring1 = ring(T.read(), 20);             // outer ring should have lit up
    const spreadsOut = ring1 > ring0 + 5;

    // DECAY: no zoom, no new frames — total brightness must fall each step.
    const D = new window.FFShaderPlus.FeedbackTunnel(W, H, { zoom: 1, rotate: 0, decay: 0.8, mix: 1, blend: 'source-over' });
    D.push(dot(W / 2, H / 2, 8));
    const tot0 = total(D.read());
    for (let i = 0; i < 6; i++) D.push(null);     // null = decay only, nothing added
    const tot1 = total(D.read());
    const decays = tot1 < tot0 * 0.9 && tot1 > 0;

    // ROTATE: an OFF-centre dot, accumulated with rotation vs without — the
    // trails land in different places, so the frames differ.
    function runRot(rot) {
      const F = new window.FFShaderPlus.FeedbackTunnel(W, H, { zoom: 1.0, rotate: rot, decay: 0.9, mix: 1, blend: 'source-over' });
      F.push(dot(W / 2, 12, 3));                  // dot near the top
      for (let i = 0; i < 10; i++) F.push(null);  // spin the trail
      return F.read();
    }
    const noRot = runRot(0), yesRot = runRot(0.35);
    let rotDiff = 0;
    for (let i = 0; i < noRot.data.length; i += 4) if (Math.abs(noRot.data[i] - yesRot.data[i]) > 24) rotDiff++;
    const rotates = rotDiff > (W * H) * 0.02;

    return { spreadsOut, decays, rotates, dbg: { ring0: +ring0.toFixed(1), ring1: +ring1.toFixed(1), tot0, tot1, rotDiff } };
  });

  ok('#67 zoom>1 spreads a central detail outward', r.spreadsOut, `ring ${r.dbg.ring0}→${r.dbg.ring1}`);
  ok('#67 decay fades the buffer when nothing is added', r.decays, `total ${r.dbg.tot0}→${r.dbg.tot1}`);
  ok('#67 rotate changes where the trail lands', r.rotates, `${r.dbg.rotDiff} px differ`);

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
