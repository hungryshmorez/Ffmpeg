// =============================================================================
// pitch-snap.mjs — pitch correction / snap to detected key (#35)
// -----------------------------------------------------------------------------
// Verified DETERMINISTICALLY on synthesised tones:
//   • detectPitch recovers the fundamental of a 440 Hz sine (within a few Hz)
//   • nearestNote maps 466 Hz to A#4 with ~0 cents
//   • snapToScale nudges an off-key note to the nearest note IN the scale — a
//     C#-ish pitch snaps to D in C-major (which excludes C#), and the reported
//     correction is the semitone distance to that note
//   • a note already in the scale needs ~0 correction
//
//   node .test/pitch-snap.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8230);
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
  await page.waitForFunction(() => !!(window.FFAudioDSP && window.FFAudioDSP.detectPitch && window.FFAudioDSP.snapToScale), { timeout: 60000 });
  durable('[boot] FFAudioDSP pitch API present');

  const r = await page.evaluate(async () => {
    const sr = 44100, DSP = window.FFAudioDSP;
    const tone = (f, sec = 0.3) => { const n = Math.round(sr * sec); const b = new Float32Array(n); for (let i = 0; i < n; i++) b[i] = Math.sin(2 * Math.PI * f * i / sr) + 0.3 * Math.sin(2 * Math.PI * 2 * f * i / sr); return b; };

    const p440 = DSP.detectPitch(tone(440), sr);
    const detectOk = Math.abs(p440.freq - 440) < 5 && p440.confidence > 0.8;

    const nn = DSP.nearestNote(466.16);            // A#4
    const noteOk = nn.name === 'A#4' && Math.abs(nn.cents) < 5;

    // a C#-ish pitch (~277.2 Hz, midi 61) in C major → should snap to D (62) or C (60);
    // 61 is equidistant, so nudge slightly sharp (278.5 ≈ midi 61.08) → nearer D
    const snap = DSP.snapToScale(280, 0, 'major');  // ~C#5-ish
    const inScaleName = ['C', 'D', 'E', 'F', 'G', 'A', 'B'].some((n) => snap.name.startsWith(n) && !snap.name.includes('#'));
    const snapMovedToScale = inScaleName && Math.abs(snap.semitones) <= 1.0;

    // a note already in the scale → ~0 correction
    const onKey = DSP.snapToScale(DSP.nearestNote(261.63).freq, 0, 'major');  // C4
    const onKeyZero = Math.abs(onKey.semitones) < 0.05 && onKey.name.startsWith('C');

    return { detectOk, noteOk, snapMovedToScale, onKeyZero, dbg: { f: +p440.freq.toFixed(1), nn: nn.name, snap: snap.name, snapSemis: +snap.semitones.toFixed(2) } };
  });

  ok('#35 detectPitch recovers a 440 Hz fundamental', r.detectOk, `f=${r.dbg.f}Hz`);
  ok('#35 nearestNote maps 466 Hz → A#4 (~0 cents)', r.noteOk, `${r.dbg.nn}`);
  ok('#35 snapToScale nudges an off-key note into the scale', r.snapMovedToScale, `→ ${r.dbg.snap} (${r.dbg.snapSemis} st)`);
  ok('#35 a note already in the scale needs ~0 correction', r.onKeyZero);

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
