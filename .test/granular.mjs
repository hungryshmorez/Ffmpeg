// =============================================================================
// granular.mjs — granular / beat stutter (#37)
// -----------------------------------------------------------------------------
// granularRearrange realises a beat-grid rearrangement as audio. Verified
// DETERMINISTICALLY on a source with a DIFFERENT tone in each half-second slice
// (200 / 400 / 800 Hz), by reading the dominant frequency (zero-crossing rate)
// out of each output region:
//   • a stutter order [0,0,0] fills the output with slice-0's tone (200 Hz)
//   • a shuffle order [2,1,0] plays the tones back reversed (800,400,200)
//   • the output length equals the sum of the taken slices (minus tiny seam xfades)
//
//   node .test/granular.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8229);
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
  await page.waitForFunction(() => !!(window.FFAudioDSP && window.FFAudioDSP.granularRearrange && window.FFBeatSync), { timeout: 60000 });
  durable('[boot] FFAudioDSP.granularRearrange + FFBeatSync present');

  const r = await page.evaluate(async () => {
    const sr = 44100, DSP = window.FFAudioDSP, BS = window.FFBeatSync;
    const freqs = [200, 400, 800];
    const sliceSec = 0.5, N = freqs.length;
    const src = new Float32Array(sr * sliceSec * N);
    for (let s = 0; s < N; s++) for (let i = 0; i < sr * sliceSec; i++) { const t = i / sr; src[s * sr * sliceSec + i] = Math.sin(2 * Math.PI * freqs[s] * t); }
    const beats = [0, 0.5, 1.0]; const slices = BS.chopOnBeats(beats, { duration: 1.5 });

    // dominant frequency of a region via zero-crossing count
    const domFreq = (buf, lo, hi) => { let zc = 0; for (let i = lo + 1; i < hi; i++) if ((buf[i - 1] < 0) !== (buf[i] < 0)) zc++; return zc / 2 / ((hi - lo) / sr); };

    // stutter: slice 0 (200 Hz) ×3
    const stut = DSP.granularRearrange(src, sr, BS.rearrangeSlices(slices, [0, 0, 0]).steps);
    const stutMids = [0, 1, 2].map((k) => domFreq(stut, Math.round((k * 0.5 + 0.15) * sr), Math.round((k * 0.5 + 0.35) * sr)));
    const stutter = stutMids.every((f) => Math.abs(f - 200) < 25);

    // shuffle reversed: [2,1,0] → 800,400,200
    const shuf = DSP.granularRearrange(src, sr, BS.rearrangeSlices(slices, [2, 1, 0]).steps);
    const shufMids = [0, 1, 2].map((k) => domFreq(shuf, Math.round((k * 0.5 + 0.15) * sr), Math.round((k * 0.5 + 0.35) * sr)));
    const reversed = Math.abs(shufMids[0] - 800) < 40 && Math.abs(shufMids[1] - 400) < 30 && Math.abs(shufMids[2] - 200) < 25;

    // length ≈ sum of taken slices (1.5 s) within a few ms of seam crossfades
    const lenOk = Math.abs(stut.length / sr - 1.5) < 0.02;

    return { stutter, reversed, lenOk, dbg: { stutMids: stutMids.map((f) => Math.round(f)), shufMids: shufMids.map((f) => Math.round(f)), lenSec: +(stut.length / sr).toFixed(3) } };
  });

  ok('#37 stutter [0,0,0] fills the output with slice-0 tone (200 Hz)', r.stutter, `mids=${JSON.stringify(r.dbg.stutMids)}`);
  ok('#37 shuffle [2,1,0] reverses the tones (800,400,200)', r.reversed, `mids=${JSON.stringify(r.dbg.shufMids)}`);
  ok('#37 output length = sum of the taken slices', r.lenOk, `${r.dbg.lenSec}s`);

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
