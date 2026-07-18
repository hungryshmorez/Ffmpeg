// =============================================================================
// gain-staging.mjs — automatic gain staging (#32) + loudness-matched A/B (#33)
// -----------------------------------------------------------------------------
// Both are pure DSP, verified DETERMINISTICALLY:
//   #32 gainStaging walks the rack's boosts in series and flags the first stage
//       that crosses 0 dBFS:
//         • a +12 dB bass boost on a −3 dB input clips AT the bass stage
//         • a flat rack on a −6 dB input never clips
//         • Volume above unity can push the output stage over on its own
//   #33 loudnessMatch returns the gain that brings the mix onto the reference's
//       RMS — applying it makes the two levels equal; matching to itself is unity
//
//   node .test/gain-staging.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8231);
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
  await page.waitForFunction(() => !!(window.FFAudioDSP && window.FFAudioDSP.gainStaging && window.FFAudioDSP.loudnessMatch), { timeout: 60000 });
  durable('[boot] FFAudioDSP gainStaging + loudnessMatch present');

  const r = await page.evaluate(async () => {
    const DSP = window.FFAudioDSP;
    // #32
    const bassClip = DSP.gainStaging({ bassBoostDb: 12 }, -3);
    const flat = DSP.gainStaging({}, -6);
    const loudVol = DSP.gainStaging({ volume: 2 }, -3);   // +6 dB output

    // #33
    const sr = 44100, N = sr;
    const quiet = new Float32Array(N), loud = new Float32Array(N);
    for (let i = 0; i < N; i++) { const s = Math.sin(2 * Math.PI * 220 * i / sr); quiet[i] = 0.2 * s; loud[i] = 0.5 * s; }
    const m = DSP.loudnessMatch(quiet, loud);            // bring quiet up to loud
    const matched = quiet.map((v) => v * m.gain);
    const matchedRms = DSP.rmsLevel(matched), refRms = DSP.rmsLevel(loud);
    const self = DSP.loudnessMatch(loud, loud);

    return {
      bassClips: bassClip.clips && bassClip.firstClip === 'bass',
      flatClean: !flat.clips,
      volClips: loudVol.clips && loudVol.firstClip === 'output',
      matchWorks: Math.abs(matchedRms - refRms) < refRms * 0.02 && m.gain > 2,
      selfUnity: Math.abs(self.gain - 1) < 1e-6,
      dbg: { bassPeak: bassClip.peakDb, gain: +m.gain.toFixed(2) },
    };
  });

  ok('#32 a +12 dB bass boost on −3 dB input clips at the bass stage', r.bassClips, `peak=${r.dbg.bassPeak} dBFS`);
  ok('#32 a flat rack on −6 dB input never clips', r.flatClean);
  ok('#32 Volume above unity clips the output stage on its own', r.volClips);
  ok('#33 loudnessMatch brings the mix onto the reference RMS', r.matchWorks, `gain=${r.dbg.gain}×`);
  ok('#33 matching a signal to itself is unity gain', r.selfUnity);

  const passed = checks.filter(Boolean).length;
  durable(`==== ${passed}/${checks.length} checks passed ====`);
  code = passed === checks.length && checks.length === 5 ? 0 : 1;
} catch (e) {
  durable('FATAL: ' + (e.message || String(e)));
  code = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server) server.close();
}
process.exit(code);
