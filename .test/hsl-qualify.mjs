// =============================================================================
// hsl-qualify.mjs — HSL secondary qualifiers (#54)
// -----------------------------------------------------------------------------
// A colour-selective grade. Verified DETERMINISTICALLY on a frame split into a
// RED half and a BLUE half:
//   • qualify RED (hue ~0) and hue-shift +120° → the red half turns GREEN while
//     the blue half is untouched
//   • qualify BLUE and drop its luma → the blue half darkens, the red is untouched
//   • a hue far from any content selects nothing (frame unchanged)
//
//   node .test/hsl-qualify.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8222);
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
  await page.waitForFunction(() => !!(window.FFShaderPlus && window.FFShaderPlus.hslQualify), { timeout: 60000 });
  durable('[boot] FFShaderPlus.hslQualify present');

  const r = await page.evaluate(async () => {
    const W = 64, H = 32;
    // left half red, right half blue
    const split = () => { const d = new Uint8ClampedArray(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if (x < W / 2) { d[i] = 220; d[i + 1] = 30; d[i + 2] = 30; } else { d[i] = 30; d[i + 1] = 30; d[i + 2] = 220; } d[i + 3] = 255; } return new ImageData(d, W, H); };
    const px = (img, x) => { const i = ((H / 2 | 0) * W + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };

    // qualify RED, hue-shift +120 (→ green)
    const a = split();
    window.FFShaderPlus.hslQualify(a, { hueCenter: 0, hueWidth: 30, softness: 0.3, satMin: 0.2, hueShift: 120 });
    const redAfter = px(a, 10), blueAfter = px(a, 54);
    const redTurnedGreen = redAfter[1] > redAfter[0] && redAfter[1] > redAfter[2] && redAfter[1] > 120;
    const blueUntouched = Math.abs(blueAfter[2] - 220) < 20 && blueAfter[2] > blueAfter[0];

    // qualify BLUE, drop luma
    const b = split();
    window.FFShaderPlus.hslQualify(b, { hueCenter: 240, hueWidth: 30, softness: 0.3, satMin: 0.2, lumAdd: -0.35 });
    const redAfter2 = px(b, 10), blueAfter2 = px(b, 54);
    const blueDarkened = blueAfter2[2] < 120 && (blueAfter2[0] + blueAfter2[1] + blueAfter2[2]) < (30 + 30 + 220) * 0.7;
    const redUntouched = Math.abs(redAfter2[0] - 220) < 20;

    // qualify a hue with no content (green ~120) → nothing changes
    const c0 = split(); const c = split();
    window.FFShaderPlus.hslQualify(c, { hueCenter: 120, hueWidth: 20, softness: 0.2, satMin: 0.2, hueShift: 90, lumAdd: 0.3 });
    let maxDelta = 0; for (let i = 0; i < c.data.length; i++) maxDelta = Math.max(maxDelta, Math.abs(c.data[i] - c0.data[i]));
    const nothingSelected = maxDelta <= 2;

    return { redTurnedGreen, blueUntouched, blueDarkened, redUntouched, nothingSelected, dbg: { redAfter, blueAfter, blueAfter2, redAfter2, maxDelta } };
  });

  ok('#54 qualify red + hue-shift → red half turns green', r.redTurnedGreen, `red→${r.dbg.redAfter}`);
  ok('#54 the un-qualified blue half is untouched', r.blueUntouched, `blue=${r.dbg.blueAfter}`);
  ok('#54 qualify blue + drop luma → blue half darkens, red untouched', r.blueDarkened && r.redUntouched, `blue→${r.dbg.blueAfter2} red=${r.dbg.redAfter2}`);
  ok('#54 a hue with no content selects nothing', r.nothingSelected, `Δ=${r.dbg.maxDelta}`);

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
