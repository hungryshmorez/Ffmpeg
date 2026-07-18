// =============================================================================
// power-window.mjs — power windows / masks (#55)
// -----------------------------------------------------------------------------
// A shape mask limits a grade to a region. Verified DETERMINISTICALLY on a flat
// grey frame with a centred ellipse window + a brightness boost:
//   • the CENTRE (inside the window) brightens
//   • the CORNER (outside) is untouched
//   • a point on the FEATHERED edge is partially adjusted (between the two)
//   • INVERT flips it — the outside brightens, the centre is untouched
//
//   node .test/power-window.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8221);
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
  await page.waitForFunction(() => !!(window.FFShaderPlus && window.FFShaderPlus.powerWindow), { timeout: 60000 });
  durable('[boot] FFShaderPlus.powerWindow present');

  const r = await page.evaluate(async () => {
    const W = 100, H = 100;
    const flat = () => { const d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 120; d[i + 3] = 255; } return new ImageData(d, W, H); };
    const at = (img, x, y) => img.data[(y * W + x) * 4];

    // centred ellipse, radius 0.25 (norm), feather 0.15, brightness +0.4 (+102)
    const win = flat();
    window.FFShaderPlus.powerWindow(win, { shape: 'ellipse', cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.25, feather: 0.15, brightness: 0.4 });
    const centre = at(win, 50, 50);      // inside → brightened
    const corner = at(win, 3, 3);        // outside → untouched
    // a point on the feather: norm dist ~1.07 (just past rx). x where (x/W-0.5)/0.25 ≈ 1.07 → x/W-0.5≈0.268 → x≈76.8
    const edge = at(win, 77, 50);

    const insideBrightened = centre > 200;
    const outsideUntouched = Math.abs(corner - 120) <= 1;
    const edgePartial = edge > 125 && edge < centre - 10;

    // invert: outside brightens, centre untouched
    const inv = flat();
    window.FFShaderPlus.powerWindow(inv, { shape: 'ellipse', cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.25, feather: 0.15, brightness: 0.4, invert: true });
    const invCentre = at(inv, 50, 50), invCorner = at(inv, 3, 3);
    const inverted = Math.abs(invCentre - 120) <= 1 && invCorner > 200;

    return { insideBrightened, outsideUntouched, edgePartial, inverted, dbg: { centre, corner, edge, invCentre, invCorner } };
  });

  ok('#55 inside the window is graded (brightened)', r.insideBrightened, `centre=${r.dbg.centre}`);
  ok('#55 outside the window is untouched', r.outsideUntouched, `corner=${r.dbg.corner}`);
  ok('#55 the feathered edge is partially graded', r.edgePartial, `edge=${r.dbg.edge}`);
  ok('#55 invert flips the mask (outside graded, centre untouched)', r.inverted, `centre=${r.dbg.invCentre} corner=${r.dbg.invCorner}`);

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
