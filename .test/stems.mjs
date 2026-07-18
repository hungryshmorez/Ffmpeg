// =============================================================================
// stems.mjs — stem separation (mid/side) (#26)
// -----------------------------------------------------------------------------
// Verified DETERMINISTICALLY on a synthetic mix: a CENTRE vocal (1 kHz, equal in
// L and R) + a hard-panned instrument (200 Hz, in L only):
//   • INSTRUMENTAL (remove centre): the 1 kHz vocal band drops to ~0 while the
//     200 Hz instrument survives — the OOPS karaoke cancel, exact
//   • ACAPELLA (keep centre): the vocal/instrument energy RATIO improves versus
//     the plain mid (the correlation gate suppresses the panned instrument)
//   • mono input degrades gracefully (returns a pair, no crash)
//
//   node .test/stems.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8210);
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
  await page.waitForFunction(() => !!(window.FFAudioDSP && window.FFAudioDSP.stemSeparate), { timeout: 60000 });
  durable('[boot] FFAudioDSP.stemSeparate present');

  const r = await page.evaluate(async () => {
    const DSP = window.FFAudioDSP, sr = 44100, N = sr;
    const L = new Float32Array(N), R = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const vocal = 0.4 * Math.sin(i * 2 * Math.PI * 1000 / sr);      // centre
      const instr = 0.4 * Math.sin(i * 2 * Math.PI * 200 / sr);       // left only
      L[i] = vocal + instr; R[i] = vocal;
    }
    // band energy via biquads (isolate 1 kHz vocal vs 200 Hz instrument)
    const bandRms = (a, kind) => {
      const c = Float32Array.from(a);
      if (kind === 'vocal') { DSP.highpass(c, sr, 600); DSP.lowpass(c, sr, 1600); }
      else { DSP.lowpass(c, sr, 350); }
      let s = 0, cnt = 0; for (let i = sr * 0.1; i < a.length; i++) { s += c[i] * c[i]; cnt++; } return Math.sqrt(s / cnt);
    };

    const midCh = new Float32Array(N); for (let i = 0; i < N; i++) midCh[i] = (L[i] + R[i]) * 0.5;
    const midVocal = bandRms(midCh, 'vocal'), midInstr = bandRms(midCh, 'instr');

    const [iL] = DSP.stemSeparate([L, R], sr, 'instrumental');
    const instVocal = bandRms(iL, 'vocal'), instInstr = bandRms(iL, 'instr');

    const [aL] = DSP.stemSeparate([L, R], sr, 'acapella');
    const acaVocal = bandRms(aL, 'vocal'), acaInstr = bandRms(aL, 'instr');

    // mono graceful
    const mono = DSP.stemSeparate([new Float32Array(100).fill(0.1)], sr, 'instrumental');
    const monoOk = Array.isArray(mono) && mono.length === 2 && mono[0].length === 100;

    return {
      instrumentalKillsVocal: instVocal < midVocal * 0.1 && instInstr > midInstr * 0.5,
      acapellaImprovesRatio: (acaVocal / (acaInstr + 1e-9)) > (midVocal / (midInstr + 1e-9)) * 1.5,
      monoOk,
      dbg: {
        midV: +midVocal.toFixed(3), midI: +midInstr.toFixed(3),
        instV: +instVocal.toFixed(3), instI: +instInstr.toFixed(3),
        acaRatio: +(acaVocal / (acaInstr + 1e-9)).toFixed(2), midRatio: +(midVocal / (midInstr + 1e-9)).toFixed(2),
      },
    };
  });

  ok('#26 instrumental cancels the centre vocal, keeps the instrument', r.instrumentalKillsVocal, `vocal ${r.dbg.midV}→${r.dbg.instV}, instr ${r.dbg.midI}→${r.dbg.instI}`);
  ok('#26 acapella improves the vocal/instrument ratio', r.acapellaImprovesRatio, `ratio ${r.dbg.midRatio}→${r.dbg.acaRatio}`);
  ok('#26 mono input degrades gracefully (returns a pair)', r.monoOk);

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
