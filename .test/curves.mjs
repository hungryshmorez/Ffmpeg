// =============================================================================
// curves.mjs — tone-curve editor (#53)
// -----------------------------------------------------------------------------
// The colour half of the draggable-spline widget. Verified DETERMINISTICALLY:
//   • an identity curve [(0,0),(255,255)] is a byte no-op
//   • a lift curve passes exactly through its control point (128 → 190) and
//     brightens the midtones
//   • an invert curve [(0,255),(255,0)] gives LUT[i] = 255−i
//   • a per-channel curve (red only) touches red and leaves green/blue alone
//
//   node .test/curves.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8233);
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
  await page.waitForFunction(() => !!(window.FFShaderPlus && window.FFShaderPlus.buildCurveLUT && window.FFShaderPlus.applyCurve), { timeout: 60000 });
  durable('[boot] FFShaderPlus curves present');

  const r = await page.evaluate(async () => {
    const SP = window.FFShaderPlus;
    const W = 8, H = 8;
    const flat = (r, g, b) => { const d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; } return new ImageData(d, W, H); };
    const px = (img) => [img.data[0], img.data[1], img.data[2]];

    // identity
    const idLut = SP.buildCurveLUT([[0, 0], [255, 255]]);
    let identity = true; for (let i = 0; i < 256; i++) if (idLut[i] !== i) { identity = false; break; }
    const idImg = flat(60, 120, 200); SP.applyCurve(idImg, { rgb: idLut });
    const idNoop = JSON.stringify(px(idImg)) === JSON.stringify([60, 120, 200]);

    // lift: control point (128,190)
    const lift = SP.buildCurveLUT([[0, 0], [128, 190], [255, 255]]);
    const liftHits = lift[128] === 190;
    const liftImg = flat(128, 128, 128); SP.applyCurve(liftImg, { rgb: lift });
    const brightened = px(liftImg)[0] === 190;

    // invert
    const inv = SP.buildCurveLUT([[0, 255], [255, 0]]);
    let inverted = true; for (let i = 0; i < 256; i++) if (Math.abs(inv[i] - (255 - i)) > 1) { inverted = false; break; }
    const invImg = flat(100, 100, 100); SP.applyCurve(invImg, { rgb: inv });
    const invApplied = px(invImg)[0] >= 154 && px(invImg)[0] <= 156;

    // per-channel: red only
    const redOnly = flat(100, 100, 100); SP.applyCurve(redOnly, { r: SP.buildCurveLUT([[0, 0], [100, 200], [255, 255]]) });
    const rc = px(redOnly);
    const redOnlyOk = rc[0] === 200 && rc[1] === 100 && rc[2] === 100;

    return { identity, idNoop, liftHits, brightened, inverted, invApplied, redOnlyOk, dbg: { lift128: lift[128], inv100: inv[100], red: rc } };
  });

  ok('#53 identity curve is a byte no-op', r.identity && r.idNoop);
  ok('#53 curve passes through its control point (128 → 190)', r.liftHits && r.brightened, `lut[128]=${r.dbg.lift128}`);
  ok('#53 invert curve gives 255 − i', r.inverted && r.invApplied, `100 → ${r.dbg.inv100}`);
  ok('#53 a per-channel (red) curve leaves green/blue alone', r.redOnlyOk, `rgb=${JSON.stringify(r.dbg.red)}`);

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
