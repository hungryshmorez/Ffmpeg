// =============================================================================
// ms-eq.mjs — mid/side EQ (#30)
// -----------------------------------------------------------------------------
// The two canonical moves, verified DETERMINISTICALLY on a stereo signal whose
// SIDE carries both a 60 Hz tone and a 6 kHz tone (mid is a shared 1 kHz):
//   • MONO THE BASS: high-pass the side at 200 Hz → the low band of (L−R) drops
//     hard (bass collapses to mono) while the high side survives
//   • WIDEN THE HIGHS: +9 dB high-shelf on the side → the high band of (L−R)
//     rises (top end opens up)
//   • neutral params leave the signal untouched
//
//   node .test/ms-eq.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8206);
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
  await page.waitForFunction(() => !!(window.FFAudioDSP && window.FFAudioDSP.midSideEQ), { timeout: 60000 });
  durable('[boot] FFAudioDSP.midSideEQ present');

  const r = await page.evaluate(async () => {
    const DSP = window.FFAudioDSP, sr = 44100, N = sr;
    function mk() {
      const L = new Float32Array(N), R = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const mid = 0.3 * Math.sin(i * 2 * Math.PI * 1000 / sr);
        const sideLow = 0.3 * Math.sin(i * 2 * Math.PI * 60 / sr);
        const sideHigh = 0.3 * Math.sin(i * 2 * Math.PI * 6000 / sr);
        L[i] = mid + sideLow + sideHigh; R[i] = mid - sideLow - sideHigh;
      }
      return [L, R];
    }
    // measure band energy of the SIDE = (L-R)/2 via one-pole low/high pass
    const sideBand = (L, R, mode) => {
      const n = L.length; let lp = 0, s = 0, cnt = 0;
      const cLow = Math.exp(-2 * Math.PI * 150 / sr);      // ~150 Hz one-pole
      for (let i = 0; i < n; i++) {
        const sd = (L[i] - R[i]) * 0.5;
        lp = cLow * lp + (1 - cLow) * sd;
        const v = mode === 'low' ? lp : (sd - lp);         // hp = signal - lp
        if (i > sr * 0.1) { s += v * v; cnt++; }            // skip filter warm-up
      }
      return Math.sqrt(s / cnt);
    };

    const base = mk();
    const lowBase = sideBand(base[0], base[1], 'low');
    const highBase = sideBand(base[0], base[1], 'high');

    // mono the bass
    const mb = mk(); DSP.midSideEQ(mb, sr, { monoBelowHz: 200 });
    const lowMono = sideBand(mb[0], mb[1], 'low');
    const highMono = sideBand(mb[0], mb[1], 'high');

    // widen the highs
    const wh = mk(); DSP.midSideEQ(wh, sr, { widenAboveHz: 3000, widenDb: 9 });
    const highWide = sideBand(wh[0], wh[1], 'high');

    // neutral
    const nu = mk(); DSP.midSideEQ(nu, sr, {});
    let maxDelta = 0; for (let i = 0; i < N; i++) maxDelta = Math.max(maxDelta, Math.abs(nu[0][i] - base[0][i]));

    return {
      monoBassDrops: lowMono < lowBase * 0.3,
      monoKeepsHigh: highMono > highBase * 0.7,
      widenHighRises: highWide > highBase * 1.2,
      neutralUntouched: maxDelta < 1e-9,
      dbg: { lowBase: +lowBase.toFixed(4), lowMono: +lowMono.toFixed(4), highBase: +highBase.toFixed(4), highWide: +highWide.toFixed(4) },
    };
  });

  ok('#30 mono-the-bass collapses the low side', r.monoBassDrops, `low ${r.dbg.lowBase}→${r.dbg.lowMono}`);
  ok('#30 mono-the-bass keeps the high side intact', r.monoKeepsHigh);
  ok('#30 widen-the-highs lifts the high side', r.widenHighRises, `high ${r.dbg.highBase}→${r.dbg.highWide}`);
  ok('#30 neutral params leave the signal untouched', r.neutralUntouched);

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
