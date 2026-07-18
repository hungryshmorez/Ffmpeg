// =============================================================================
// lens.mjs — lens distortion + chromatic aberration (#49)
// -----------------------------------------------------------------------------
// Pure ImageData remap → verified DETERMINISTICALLY:
//   • BARREL distortion (k1<0) bows a straight vertical line — its x-position at
//     the top of the frame differs from its x-position at the centre row; with
//     k1=0 the line stays straight
//   • CHROMATIC ABERRATION splits R and B at the EDGES: a white block develops a
//     coloured fringe near the frame edge (|R−B|>0) while its centre stays neutral
//   • ca=0, k1=0 is a near-identity (the frame is essentially unchanged)
//
//   node .test/lens.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8213);
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
  await page.waitForFunction(() => !!(window.FFShaderPlus && window.FFShaderPlus.lensDistort), { timeout: 60000 });
  durable('[boot] FFShaderPlus.lensDistort present');

  const r = await page.evaluate(async () => {
    const W = 160, H = 160;
    // a straight white vertical line near the left edge (x = 30), on black
    const lineFrame = () => {
      const d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < d.length; i += 4) d[i + 3] = 255;
      for (let y = 0; y < H; y++) for (let x = 28; x <= 32; x++) { const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = 255; }
      return new ImageData(d, W, H);
    };
    // brightest x on a given row
    const lineX = (img, y) => { let best = -1, bv = 40; for (let x = 0; x < W; x++) { const v = img.data[(y * W + x) * 4]; if (v > bv) { bv = v; best = x; } } return best; };

    const barrel = lineFrame(); window.FFShaderPlus.lensDistort(barrel, { k1: -0.4, k2: 0, ca: 0 });
    const xTop = lineX(barrel, 12), xMid = lineX(barrel, H / 2 | 0);
    const straight = lineFrame(); window.FFShaderPlus.lensDistort(straight, { k1: 0, k2: 0, ca: 0 });
    const sTop = lineX(straight, 12), sMid = lineX(straight, H / 2 | 0);

    // CA: a big white block; measure |R-B| near the edge vs the centre
    const block = () => { const d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < d.length; i += 4) d[i + 3] = 255; for (let y = 20; y < H - 20; y++) for (let x = 20; x < W - 20; x++) { const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = 255; } return new ImageData(d, W, H); };
    const ca = block(); window.FFShaderPlus.lensDistort(ca, { k1: 0, k2: 0, ca: 0.01 });
    // edge of the block near a frame corner (y=22) vs centre of the block
    const rbDiff = (img, x, y) => { const i = (y * W + x) * 4; return Math.abs(img.data[i] - img.data[i + 2]); };
    let edgeFringe = 0; for (let y = 18; y < 26; y++) for (let x = 18; x < 26; x++) edgeFringe = Math.max(edgeFringe, rbDiff(ca, x, y));
    const centreFringe = rbDiff(ca, W / 2 | 0, H / 2 | 0);

    // near-identity for k1=0,ca=0
    const idbase = lineFrame(); const id = lineFrame(); window.FFShaderPlus.lensDistort(id, { k1: 0, k2: 0, ca: 0 });
    let maxDelta = 0; for (let i = 0; i < id.data.length; i += 4) maxDelta = Math.max(maxDelta, Math.abs(id.data[i] - idbase.data[i]));

    return {
      barrelBows: Math.abs(xTop - xMid) >= 4,
      straightStays: Math.abs(sTop - sMid) <= 1,
      caEdgeFringe: edgeFringe > 40 && centreFringe < 10,
      identity: maxDelta <= 2,
      dbg: { xTop, xMid, sTop, sMid, edgeFringe, centreFringe, maxDelta },
    };
  });

  ok('#49 barrel distortion bows a straight line', r.barrelBows, `line x: top=${r.dbg.xTop} mid=${r.dbg.xMid}`);
  ok('#49 with no distortion the line stays straight', r.straightStays, `top=${r.dbg.sTop} mid=${r.dbg.sMid}`);
  ok('#49 chromatic aberration fringes the edges, not the centre', r.caEdgeFringe, `edge=${r.dbg.edgeFringe} centre=${r.dbg.centreFringe}`);
  ok('#49 k1=0, ca=0 is a near-identity', r.identity, `Δ=${r.dbg.maxDelta}`);

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
