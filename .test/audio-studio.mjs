// =============================================================================
// audio-studio.mjs — the Audio Studio actually bounces a real file
// -----------------------------------------------------------------------------
// The Audio Studio was one of the modules revived by the window.state fix
// (loadFromBin reads window.state.mediaBin). This proves the whole chain works
// by DECODING what it produces — not bytes, PCM samples:
//
//   • loadFromBin decodes a bin clip into the Web Audio engine (buffer present,
//     right duration/sample rate)
//   • Bounce → WAV (no ffmpeg) lands a clip in the bin that decodes to the
//     expected number of PCM samples
//   • Bounce → MP3 with loudness normalisation exercises the ffmpeg encode +
//     two-pass loudnorm branch, and that output also decodes to real samples
//
//   node .test/audio-studio.mjs
// =============================================================================
import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync } from 'node:fs';

const RESULTS = process.env.RESULTS || '';
const durable = (line) => { console.log(line); if (RESULTS) { try { appendFileSync(RESULTS, line + '\n'); } catch (_) {} } };

const PORT = Number(process.env.PORT || 8175);
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
  page.on('dialog', (d) => d.accept().catch(() => {}));

  await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof state !== 'undefined' && state.engineReady === true, { timeout: 120000 });
  durable('[boot] engine ready');

  // A 2s / 44.1kHz sine WAV, made with the wasm core and loaded via the bin.
  const loaded = await page.evaluate(async () => {
    await ff.exec(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1', '-y', 'sine.wav'], { raw: true });
    const data = await ff.readFile('sine.wav');
    const file = new File([data], 'sine.wav', { type: 'audio/wav' });
    const dt = new DataTransfer(); dt.items.add(file);
    const input = document.querySelector('#file-input');
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
    const m = [...(window.state.mediaBin || [])].reverse().find((x) => /sine\.wav/.test(x.name));
    if (!m) return { err: 'sine.wav not in bin' };
    window.FFAudioStudio.loadFromBin(m.id);
    // wait for the Web Audio engine to decode it
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const eng = window.FFAudioStudio.engine?.();
      if (eng && eng.buffer) return { ok: true, dur: eng.buffer.duration, sr: eng.buffer.sampleRate, len: eng.buffer.length };
    }
    return { err: 'engine never decoded a buffer' };
  });
  ok('loadFromBin decoded the clip into the audio engine',
    loaded.ok && loaded.dur > 1.8 && loaded.dur < 2.2 && loaded.len > 0,
    loaded.ok ? `${loaded.dur.toFixed(2)}s · ${loaded.sr}Hz · ${loaded.len} samples` : loaded.err);

  // Decode a bin entry to PCM and count samples (the "frames not bytes" of audio).
  const decodeSamples = (nameRe) => page.evaluate(async (reSrc) => {
    const re = new RegExp(reSrc, 'i');
    const entry = [...(window.state.mediaBin || [])].reverse().find((m) => re.test(m.name));
    if (!entry) return { ok: false, err: 'no matching bin entry' };
    const ab = await (await fetch(entry.blobUrl || entry.url)).arrayBuffer();
    const u8 = new Uint8Array(ab); const bytes = u8.length;
    await ff.writeFile('__a', u8);
    await ff.exec(['-i', '__a', '-f', 's16le', '-ac', '1', '-ar', '8000', '-y', '__a.pcm'], { raw: true }).catch(() => {});
    let pcm = new Uint8Array(0);
    try { pcm = await ff.readFile('__a.pcm'); } catch (_) {}
    const samples = pcm.length / 2;
    try { await ff.deleteFile('__a'); } catch (_) {}
    try { await ff.deleteFile('__a.pcm'); } catch (_) {}
    return { ok: true, name: entry.name, bytes, samples };
  }, nameRe.source);

  // --- Bounce 1: WAV, no normalise (no ffmpeg at all) ---
  await page.evaluate(() => {
    document.getElementById('as-format').value = 'wav';
    const n = document.getElementById('as-normalize'); if (n.checked) n.click();
    document.getElementById('as-bounce').click();
  });
  await page.waitForFunction(() => (window.state.mediaBin || []).some((m) => /\[processed\]\.wav/i.test(m.name)),
    null, { timeout: 60000 }).catch(() => {});
  const wav = await decodeSamples(/\[processed\]\.wav/);
  // 2s at 8000 Hz mono ≈ 16000 samples
  ok('WAV bounce decodes to real PCM samples',
    wav.ok && wav.samples >= 12000, wav.ok ? `${wav.samples} samples · ${wav.bytes} B` : wav.err);

  // --- Bounce 2: MP3 with loudness normalisation (ffmpeg encode + two-pass loudnorm) ---
  await page.evaluate(() => {
    document.getElementById('as-format').value = 'mp3';
    const n = document.getElementById('as-normalize'); if (!n.checked) n.click();
    document.getElementById('as-bounce').click();
  });
  await page.waitForFunction(() => (window.state.mediaBin || []).some((m) => /\[processed\]\.mp3/i.test(m.name)),
    null, { timeout: 90000 }).catch(() => {});
  const mp3 = await decodeSamples(/\[processed\]\.mp3/);
  ok('MP3 (loudnorm) bounce decodes to real PCM samples',
    mp3.ok && mp3.samples >= 12000, mp3.ok ? `${mp3.samples} samples · ${mp3.bytes} B` : mp3.err);

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
