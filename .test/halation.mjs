// =============================================================================
// halation.mjs — halation & bloom (#48)
// -----------------------------------------------------------------------------
// A physical light-bleed pass: threshold the bright parts, blur them, tint, and
// screen back. Pure ImageData math → verified DETERMINISTICALLY:
//   • a bright spot on black BLOOMS — pixels AROUND it (that were black) light up
//   • the glow is reddish (tint): near the spot, red rises more than blue
//   • a below-threshold (dim) frame barely changes — nothing to bloom
//   • a fully black frame stays black
//
//   node .test/halation.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8201);
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
  await page.waitForFunction(() => !!(window.FFShaderPlus && window.FFShaderPlus.halation), { timeout: 60000 });
  durable('[boot] FFShaderPlus.halation present');

  const r = await page.evaluate(async () => {
    const W = 96, H = 96;
    // a white square (bright) on a black field, centred
    function spot(v) {
      const d = new Uint8ClampedArray(W * H * 4);
      for (let i = 0; i < d.length; i += 4) d[i + 3] = 255;         // black, opaque
      for (let y = H / 2 - 6; y < H / 2 + 6; y++) for (let x = W / 2 - 6; x < W / 2 + 6; x++) { const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; }
      return new ImageData(d, W, H);
    }
    const px = (img, x, y) => { const i = (y * W + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };

    // a point OUTSIDE the square but near it — starts black, should bloom
    const ox = W / 2 + 12, oy = H / 2;

    const bright = spot(255);
    const before = px(bright, ox, oy);                              // [0,0,0]
    window.FFShaderPlus.halation(bright, { threshold: 0.72, radius: 8, intensity: 1.0, passes: 3, tint: [1.0, 0.55, 0.35] });
    const after = px(bright, ox, oy);
    const bloomed = after[0] + after[1] + after[2] > 30;            // the black neighbour lit up
    const reddish = after[0] > after[2] + 8;                        // red glow stronger than blue

    // a dim frame below threshold — barely blooms
    const dim = spot(120);                                          // luma 120 < 0.72*255≈184
    const dimBefore = px(dim, ox, oy);
    window.FFShaderPlus.halation(dim, { threshold: 0.72, radius: 8, intensity: 1.0, passes: 3 });
    const dimAfter = px(dim, ox, oy);
    const dimUnchanged = (dimAfter[0] + dimAfter[1] + dimAfter[2]) - (dimBefore[0] + dimBefore[1] + dimBefore[2]) < 12;

    // a fully black frame stays black
    const black = new ImageData(new Uint8ClampedArray(W * H * 4).map((_, i) => (i % 4 === 3 ? 255 : 0)), W, H);
    window.FFShaderPlus.halation(black, { threshold: 0.72, radius: 8, intensity: 1.0 });
    let blackStays = true;
    for (let i = 0; i < black.data.length; i += 4) if (black.data[i] || black.data[i + 1] || black.data[i + 2]) { blackStays = false; break; }

    return { before, after, bloomed, reddish, dimUnchanged, blackStays };
  });

  ok('#48 a bright spot blooms into its black surroundings', r.bloomed, `neighbour ${r.before}→${r.after}`);
  ok('#48 the glow is reddish (halation tint)', r.reddish, `r=${r.after[0]} b=${r.after[2]}`);
  ok('#48 a below-threshold frame barely blooms', r.dimUnchanged);
  ok('#48 a fully black frame stays black', r.blackStays);

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
