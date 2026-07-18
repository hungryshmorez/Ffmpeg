// =============================================================================
// rolling-shutter.mjs — rolling shutter / jello, sim + correct (#46)
// -----------------------------------------------------------------------------
// A per-row horizontal shift models the CMOS row-time skew. Verified
// DETERMINISTICALLY on a straight vertical line:
//   • SIM (shear) slants the line — its x at the top differs from its x at the
//     bottom by ~shear·H
//   • CORRECT (opposite shear) round-trips a sheared line back to straight
//   • WOBBLE bends the line (non-monotonic x down the frame) — the jello, as
//     opposed to a clean linear skew
//   • shear=0, wobble=0 is a byte-identity
//
//   node .test/rolling-shutter.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8214);
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
  await page.waitForFunction(() => !!(window.FFShaderPlus && window.FFShaderPlus.rollingShutter), { timeout: 60000 });
  durable('[boot] FFShaderPlus.rollingShutter present');

  const r = await page.evaluate(async () => {
    const W = 160, H = 120;
    const line = () => { const d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < d.length; i += 4) d[i + 3] = 255; for (let y = 0; y < H; y++) for (let x = 78; x <= 82; x++) { const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = 255; } return new ImageData(d, W, H); };
    const lineX = (img, y) => { for (let x = 0; x < W; x++) if (img.data[(y * W + x) * 4] > 100) return x; return -1; };

    const RS = window.FFShaderPlus.rollingShutter;
    // SIM shear
    const sim = line(); RS(sim, { shear: 0.4, wobble: 0 });
    const topX = lineX(sim, 4), botX = lineX(sim, H - 5);
    const slants = Math.abs(topX - botX) >= 20;

    // CORRECT: shear then −shear should straighten it
    const corr = line(); RS(corr, { shear: 0.4, wobble: 0 }); RS(corr, { shear: -0.4, wobble: 0 });
    const cTop = lineX(corr, 4), cMid = lineX(corr, H / 2 | 0), cBot = lineX(corr, H - 5);
    const straightened = Math.abs(cTop - cBot) <= 2 && Math.abs(cTop - 80) <= 3;

    // WOBBLE: the line should bend (non-monotonic x)
    const jel = line(); RS(jel, { shear: 0, wobble: 1, wobbleFreq: 2 });
    const xs = []; for (let y = 0; y < H; y += 8) xs.push(lineX(jel, y));
    let signChanges = 0; for (let i = 2; i < xs.length; i++) { const d1 = xs[i - 1] - xs[i - 2], d2 = xs[i] - xs[i - 1]; if (d1 * d2 < 0) signChanges++; }
    const bends = signChanges >= 2;   // a sinusoid reverses direction

    // identity
    const idb = line(); const id = line(); RS(id, { shear: 0, wobble: 0 });
    let maxDelta = 0; for (let i = 0; i < id.data.length; i++) maxDelta = Math.max(maxDelta, Math.abs(id.data[i] - idb.data[i]));

    return { slants, straightened, bends, identity: maxDelta === 0, dbg: { topX, botX, cTop, cBot, signChanges } };
  });

  ok('#46 shear slants the vertical line', r.slants, `top=${r.dbg.topX} bot=${r.dbg.botX}`);
  ok('#46 opposite shear corrects it back to straight', r.straightened, `top=${r.dbg.cTop} bot=${r.dbg.cBot}`);
  ok('#46 wobble bends the line (jello, not a clean skew)', r.bends, `${r.dbg.signChanges} direction reversals`);
  ok('#46 shear=0, wobble=0 is a byte-identity', r.identity);

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
