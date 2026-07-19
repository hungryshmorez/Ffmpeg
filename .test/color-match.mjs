// =============================================================================
// color-match.mjs — auto colour-match across clips (#85)
// -----------------------------------------------------------------------------
// Reinhard statistical transfer, verified DETERMINISTICALLY on hand-built
// frames with known statistics:
//   • after matching, the target's per-channel MEAN lands on the reference's
//   • its per-channel STD (spread) lands on the reference's too
//   • strength=0 is a no-op; strength=0.5 lands halfway
//   • matching a frame to ITSELF is (near) identity
//
//   node .test/color-match.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8238);
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
  await page.waitForFunction(() => !!(window.FFShaderPlus && window.FFShaderPlus.matchColorStats), { timeout: 60000 });
  durable('[boot] FFShaderPlus.matchColorStats present');

  const r = await page.evaluate(async () => {
    const W = 64, H = 64, N = W * H;
    // a frame whose channels are horizontal ramps with a chosen mean & spread
    const ramp = (mean, spread, tint) => {
      const d = new Uint8ClampedArray(N * 4);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4; const v = mean + (x / (W - 1) - 0.5) * 2 * spread;
        d[i] = v * tint[0]; d[i + 1] = v * tint[1]; d[i + 2] = v * tint[2]; d[i + 3] = 255;
      }
      return new ImageData(d, W, H);
    };
    const stats = (img) => {
      const d = img.data; const sum = [0, 0, 0], sum2 = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) { sum[c] += d[i + c]; sum2[c] += d[i + c] * d[i + c]; }
      const mean = sum.map((s) => s / N); const std = sum2.map((s2, c) => Math.sqrt(Math.max(0, s2 / N - mean[c] * mean[c])));
      return { mean, std };
    };

    // target: dark & flat-ish, reference: bright & orange & wide
    const target = ramp(90, 30, [1, 1, 1]);            // grey, mean~90
    const reference = ramp(150, 55, [1.1, 0.75, 0.5]); // orange, mean channels differ
    const refStats = stats(reference);

    const t2 = ramp(90, 30, [1, 1, 1]);
    window.FFShaderPlus.matchColorStats(t2, reference);
    const ms = stats(t2);
    const meanMatched = [0, 1, 2].every((c) => Math.abs(ms.mean[c] - refStats.mean[c]) < 4);
    const stdMatched = [0, 1, 2].every((c) => Math.abs(ms.std[c] - refStats.std[c]) < 4);

    // strength 0 = no-op
    const t0 = ramp(90, 30, [1, 1, 1]); const before = stats(t0).mean.slice();
    window.FFShaderPlus.matchColorStats(t0, reference, { strength: 0 });
    const noop = [0, 1, 2].every((c) => Math.abs(stats(t0).mean[c] - before[c]) < 1);

    // strength 0.5 = halfway between target and ref means
    const th = ramp(90, 30, [1, 1, 1]);
    window.FFShaderPlus.matchColorStats(th, reference, { strength: 0.5 });
    const halfMean = stats(th).mean;
    const halfway = [0, 1, 2].every((c) => Math.abs(halfMean[c] - (before[c] + refStats.mean[c]) / 2) < 5);

    // self-match ≈ identity
    const self = ramp(120, 40, [1, 0.9, 0.8]); const selfBefore = stats(self).mean.slice();
    window.FFShaderPlus.matchColorStats(self, ramp(120, 40, [1, 0.9, 0.8]));
    const selfId = [0, 1, 2].every((c) => Math.abs(stats(self).mean[c] - selfBefore[c]) < 2);

    return { meanMatched, stdMatched, noop, halfway, selfId, dbg: { refMean: refStats.mean.map((m) => Math.round(m)), gotMean: ms.mean.map((m) => Math.round(m)) } };
  });

  ok('#85 target mean lands on the reference mean', r.meanMatched, `ref=${JSON.stringify(r.dbg.refMean)} got=${JSON.stringify(r.dbg.gotMean)}`);
  ok('#85 target spread (std) lands on the reference std', r.stdMatched);
  ok('#85 strength=0 is a no-op; strength=0.5 lands halfway', r.noop && r.halfway);
  ok('#85 matching a frame to itself is ~identity', r.selfId);

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
